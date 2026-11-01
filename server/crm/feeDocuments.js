// Fee invoice and receipt PDFs (CRM M2 phase 1 S4, D6). Drawn with pdfkit on
// each download, from the invoice's frozen bill-to (names and school header as
// issued) and the append-only ledger, so a re-download never changes what was
// billed. Internal notes are never drawn. School-branded and deliberately
// separate from Skyll's own invoices to schools (api/_lib/invoicePdf.js); only
// the font files are shared.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { PAYMENT_METHOD_LABELS, formatMoney, invoiceState } from '../../shared/crm/fees.js';
import { crmErrors } from './errors.js';
import { feeSettings } from './feePlans.js';
import { linesFor, today } from './invoices.js';
import { PAID_SQL } from './ledger.js';
import { loadPayment } from './payments.js';

export const invoicePdfQuery = z.object({ invoiceId: z.string().trim().min(1).max(128) });
export const receiptPdfQuery = z.object({ paymentId: z.string().trim().min(1).max(128) });

const COLOR = { ink: '#14211C', dim: '#5F6B66', line: '#D8DDDA', soft: '#F3F5F4', red: '#C62828', green: '#1B6B47' };
const PAGE = { width: 595.28, height: 841.89 };
const M = 48;
const LEFT = M;
const RIGHT = PAGE.width - M;
const WIDTH = RIGHT - LEFT;
const BOTTOM = PAGE.height - M;

// The Inter files that ship with the auth function (vercel.json includeFiles).
function fonts() {
  const dir = path.join(import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'api', '_lib', 'invoice-assets');
  return { Inter: path.join(dir, 'Inter-Regular.ttf'), 'Inter-SemiBold': path.join(dir, 'Inter-SemiBold.ttf'), 'Inter-Bold': path.join(dir, 'Inter-Bold.ttf') };
}

const clip = (value, max) => { const text = String(value ?? ''); return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text; };
const longDate = (value) => {
  if (!value) return '—';
  const [y, m, d] = value.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
};
export const documentFilename = (number) => `${String(number).replace(/[^A-Za-z0-9-]+/g, '-')}.pdf`;

/**
 * A small drawing kit over one pdfkit document. `trace` (tests) collects every
 * string drawn, so tests can check what a document says without parsing PDF.
 */
async function startDocument(title, trace) {
  const { default: PDFDocument } = await import('pdfkit');
  const files = fonts();
  // Our own default font, so pdfkit never loads its bundled Helvetica.
  const doc = new PDFDocument({ size: 'A4', margin: M, bufferPages: true, info: { Title: title }, displayTitle: true, font: files.Inter });
  for (const [name, file] of Object.entries(files)) doc.registerFont(name, file);
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
  const text = (value, x, y, { font = 'Inter', size = 10, color = COLOR.ink, width, align = 'left' } = {}) => {
    const shown = String(value);
    trace?.push(shown);
    doc.font(font).fontSize(size).fillColor(color).text(shown, x, y, { width, align, lineBreak: Boolean(width) });
    return doc.y;
  };
  const rule = (y, color = COLOR.line) => doc.save().moveTo(LEFT, y).lineTo(RIGHT, y).lineWidth(0.75).strokeColor(color).stroke().restore();
  const stamp = (word, color) => {
    trace?.push(word);
    doc.save().rotate(-18, { origin: [PAGE.width / 2, 520] }).font('Inter-Bold').fontSize(64).fillColor(color).opacity(0.18)
      .text(word, 0, 490, { width: PAGE.width, align: 'center', lineBreak: false }).restore();
  };
  return { doc, done, text, rule, stamp };
}

/** School header (left) and the document title block (right). Returns the y below it. */
function header(kit, school, title, meta) {
  const { text } = kit;
  let y = M;
  text(clip(school.name, 70), LEFT, y, { font: 'Inter-Bold', size: 16, width: WIDTH * 0.6 });
  let left = kit.doc.y + 2;
  for (const line of String(school.address || '').split(/\r?\n/).filter(Boolean).slice(0, 4)) left = text(clip(line, 70), LEFT, left, { size: 9, color: COLOR.dim, width: WIDTH * 0.6 });
  if (school.phone) left = text(`Phone ${clip(school.phone, 40)}`, LEFT, left, { size: 9, color: COLOR.dim, width: WIDTH * 0.6 });
  if (school.gstin) left = text(`GSTIN ${clip(school.gstin, 20)}`, LEFT, left, { size: 9, color: COLOR.dim, width: WIDTH * 0.6 });
  text(title, LEFT, y, { font: 'Inter-Bold', size: 20, width: WIDTH, align: 'right' });
  y += 28;
  for (const [label, value] of meta) {
    text(`${label}: ${value}`, LEFT, y, { size: 9, color: COLOR.dim, width: WIDTH, align: 'right' });
    y += 13;
  }
  const bottom = Math.max(left, y) + 16;
  kit.rule(bottom);
  return bottom + 16;
}

function amountRows(kit, y, rows, { heading }) {
  const { text, rule, doc } = kit;
  doc.save().rect(LEFT, y, WIDTH, 22).fill(COLOR.soft).restore();
  text(heading[0], LEFT + 10, y + 6, { font: 'Inter-SemiBold', size: 9, color: COLOR.dim });
  text(heading[1], LEFT, y + 6, { font: 'Inter-SemiBold', size: 9, color: COLOR.dim, width: WIDTH - 10, align: 'right' });
  y += 30;
  for (const [label, amount] of rows) {
    if (y > BOTTOM - 140) { doc.addPage(); y = M; }
    text(clip(label, 90), LEFT + 10, y, { size: 10, width: WIDTH - 140 });
    text(amount, LEFT, y, { size: 10, width: WIDTH - 10, align: 'right' });
    y = Math.max(doc.y, y + 14) + 6;
    rule(y - 3);
  }
  return y + 6;
}

function totalLine(kit, y, label, value, { bold = false, color = COLOR.ink } = {}) {
  kit.text(label, LEFT + WIDTH * 0.5, y, { font: bold ? 'Inter-Bold' : 'Inter', size: bold ? 12 : 10, color, width: WIDTH * 0.3 });
  kit.text(value, LEFT, y, { font: bold ? 'Inter-Bold' : 'Inter', size: bold ? 12 : 10, color, width: WIDTH - 10, align: 'right' });
  return y + (bold ? 20 : 16);
}

function footer(kit, note, line) {
  const { text, doc } = kit;
  const range = doc.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index += 1) {
    doc.switchToPage(index);
    let y = BOTTOM - 40;
    if (note && index === range.start + range.count - 1) {
      text(clip(note, 300), LEFT, y - 24, { size: 8.5, color: COLOR.dim, width: WIDTH });
    }
    y = BOTTOM - 10;
    text(line, LEFT, y, { size: 7.5, color: COLOR.dim, width: WIDTH, align: 'center' });
  }
}

/** `invoice`: number, status, dates, lines, total, paid, voidReason, billTo (frozen). */
export async function renderFeeInvoicePdf(invoice, { today: now, trace } = {}) {
  const kit = await startDocument(`Invoice ${invoice.number}`, trace);
  const school = invoice.billTo.school || {};
  const state = invoiceState({ status: invoice.status, totalPaise: invoice.totalPaise, paidPaise: invoice.paidPaise, dueDate: invoice.dueDate }, now);
  let y = header(kit, school, 'INVOICE', [['Invoice no', invoice.number], ['Issued', longDate(invoice.issueDate)], ['Due', longDate(invoice.dueDate)]]);

  kit.text('BILLED TO', LEFT, y, { font: 'Inter-SemiBold', size: 8, color: COLOR.dim });
  y = kit.text(clip(invoice.billTo.payer?.name || invoice.billTo.student?.name || '', 80), LEFT, y + 12, { font: 'Inter-SemiBold', size: 11, width: WIDTH });
  if (invoice.billTo.payer?.name) y = kit.text(`For ${clip(invoice.billTo.student?.name, 80)}`, LEFT, y + 2, { size: 9.5, color: COLOR.dim, width: WIDTH });
  y += 18;

  y = amountRows(kit, y, invoice.lines.map((line) => [line.label, formatMoney(line.amountPaise)]), { heading: ['Description', 'Amount'] });
  y = totalLine(kit, y, 'Total', formatMoney(invoice.totalPaise), { bold: true });
  if (invoice.status === 'issued') {
    if (invoice.paidPaise > 0) y = totalLine(kit, y, 'Paid to date', formatMoney(invoice.paidPaise));
    totalLine(kit, y, 'Balance due', formatMoney(state.balancePaise), { bold: true, color: state.overdue ? COLOR.red : COLOR.ink });
  }

  if (invoice.status === 'void') {
    kit.stamp('VOID', COLOR.red);
    kit.text(`This invoice was cancelled: ${clip(invoice.voidReason, 160)}`, LEFT, BOTTOM - 90, { size: 9, color: COLOR.red, width: WIDTH });
  } else if (state.paymentStatus === 'paid') {
    kit.stamp('PAID', COLOR.green);
  }
  footer(kit, school.footer, `${invoice.number} · computer-generated invoice`);
  kit.doc.end();
  return kit.done;
}

/** `payment`: from loadPayment (allocations, reversal); `school`: current fee settings header; `balancePaise`: still due. */
export async function renderFeeReceiptPdf(payment, { school, studentName, balancePaise, trace } = {}) {
  const kit = await startDocument(`Receipt ${payment.receiptNumber}`, trace);
  let y = header(kit, school, 'RECEIPT', [['Receipt no', payment.receiptNumber], ['Received', longDate(payment.receivedOn)]]);

  kit.text('RECEIVED FROM', LEFT, y, { font: 'Inter-SemiBold', size: 8, color: COLOR.dim });
  y = kit.text(clip(payment.payerName || studentName, 80), LEFT, y + 12, { font: 'Inter-SemiBold', size: 11, width: WIDTH });
  if (payment.payerName) y = kit.text(`For ${clip(studentName, 80)}`, LEFT, y + 2, { size: 9.5, color: COLOR.dim, width: WIDTH });
  y += 18;

  kit.doc.save().rect(LEFT, y, WIDTH, 54).fill(COLOR.soft).restore();
  kit.text('Amount received', LEFT + 14, y + 10, { size: 9, color: COLOR.dim });
  kit.text(formatMoney(payment.amountPaise), LEFT + 14, y + 24, { font: 'Inter-Bold', size: 18 });
  const method = [PAYMENT_METHOD_LABELS[payment.method], payment.reference && `Ref ${clip(payment.reference, 60)}`].filter(Boolean).join(' · ');
  kit.text(method, LEFT, y + 28, { size: 10, width: WIDTH - 14, align: 'right' });
  y += 74;

  if (payment.reversal) {
    kit.stamp('REVERSED', COLOR.red);
    y = kit.text(`This payment was reversed on ${longDate(payment.reversal.at?.slice(0, 10))}: ${clip(payment.reversal.reason, 160)}. It no longer counts towards any fees.`, LEFT, y, { size: 10, color: COLOR.red, width: WIDTH }) + 14;
  } else {
    const rows = payment.allocations.map((item) => [`Invoice ${item.invoiceNumber}`, formatMoney(item.amountPaise)]);
    if (payment.unallocatedPaise > 0) rows.push(['Kept as credit for future fees', formatMoney(payment.unallocatedPaise)]);
    y = amountRows(kit, y, rows, { heading: ['Applied to', 'Amount'] });
    totalLine(kit, y, 'Balance still due', formatMoney(balancePaise), { bold: true });
  }
  footer(kit, school.footer, `${payment.receiptNumber} · computer-generated receipt`);
  kit.doc.end();
  return kit.done;
}

function sendPdf(res, body, filename) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', String(body.length));
  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(200).send(body);
}

export async function invoicePdf({ db, scope, input, res }) {
  const result = await db.execute({ sql: `SELECT i.*, ${PAID_SQL} AS paid_paise FROM crm_invoices i WHERE i.id = ? AND i.school_id = ?`, args: [input.query.invoiceId, scope.schoolId] });
  const row = result.rows[0];
  if (!row) throw crmErrors.notFound();
  const lines = (await linesFor(db, scope, [row.id]))[row.id] || [];
  const body = await renderFeeInvoicePdf({
    number: row.number, status: row.status, issueDate: row.issue_date, dueDate: row.due_date, totalPaise: Number(row.total_paise), paidPaise: Number(row.paid_paise),
    voidReason: row.void_reason, billTo: JSON.parse(row.bill_to_json), lines: lines.map((line) => ({ label: line.label, amountPaise: Number(line.amount_paise) })),
  }, { today: today(scope) });
  sendPdf(res, body, documentFilename(row.number));
}

export async function receiptPdf({ db, scope, input, res }) {
  const payment = await loadPayment(db, scope, input.query.paymentId);
  const [settings, student, balance] = await Promise.all([
    feeSettings(db, scope),
    db.execute({ sql: 'SELECT display_name FROM students WHERE id = ? AND school_id = ?', args: [payment.student.id, scope.schoolId] }),
    db.execute({ sql: `SELECT COALESCE(SUM(i.total_paise - ${PAID_SQL}), 0) AS due FROM crm_invoices i WHERE i.school_id = ? AND i.student_id = ? AND i.status = 'issued'`, args: [scope.schoolId, payment.student.id] }),
  ]);
  const school = { name: settings.headerName, address: settings.headerAddress, phone: settings.headerPhone, gstin: settings.headerGstin, footer: settings.footerNote };
  const body = await renderFeeReceiptPdf(payment, { school, studentName: student.rows[0]?.display_name || payment.student.name || '', balancePaise: Number(balance.rows[0].due) });
  sendPdf(res, body, documentFilename(payment.receiptNumber));
}
