/* Invoice PDF (FLKRM-487): the Falkram doc-kit invoice (falkram-doc-kit
 * src/05-nre-invoice.html + assets/doc.css), drawn directly with pdfkit.
 *
 * Drawn fresh on every download from the frozen invoice (number, bill-to
 * snapshot, lines, totals), so re-downloads never change the amounts. Bank
 * details are a constant (they're public and printed on every invoice); the
 * signature comes from private R2 and is never in Git. No browser: the worker VM is ARM64, where Puppeteer's
 * Chrome isn't published, and the layout is simple enough to draw.
 *
 * Measurements follow the kit's CSS at 0.75 pt per CSS px.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatINR, formatLineRate, invoicePdfFilename, longDate, periodLabel, shortDate } from '../../shared/invoiceFormat.js';
import { getObject } from './storage.js';

export { formatINR };

export const SIGNATURE_KEY = 'billing/invoice-signature.png';
/** Falkram's bank details, printed on every invoice. Public, so kept in code; change here and deploy. */
export const FALKRAM_BANK = Object.freeze({ accountName: 'FALKRAM PRIVATE LIMITED', accountNo: '00000000000000', ifsc: 'HDFC0000000', bank: 'HDFC Bank' });

const COLOR = { red: '#F21B1B', ink: '#0A0A0A', paper: '#FBFAF8', mist: '#F2F0EC', line: '#D9D6D0', dim: '#6B675F', white: '#FFFFFF' };
const MM = 72 / 25.4;
const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = { top: 20 * MM, right: 18 * MM, bottom: 18 * MM, left: 18 * MM };
const LEFT = MARGIN.left;
const RIGHT = PAGE.width - MARGIN.right;
const WIDTH = RIGHT - LEFT;
const BOTTOM = PAGE.height - MARGIN.bottom;

const FONT_FILES = {
  Inter: 'Inter-Regular.ttf',
  'Inter-Italic': 'Inter-Italic.ttf',
  'Inter-SemiBold': 'Inter-SemiBold.ttf',
  'Inter-Bold': 'Inter-Bold.ttf',
  'Fraunces-SemiBold': 'Fraunces9pt-SemiBold.ttf',
  'Fraunces-Bold': 'Fraunces9pt-Bold.ttf',
};
/** Font file paths; vercel.json ships invoice-assets/ with the auth function (includeFiles). */
function fonts() {
  const dir = path.join(import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url)), 'invoice-assets');
  return Object.fromEntries(Object.entries(FONT_FILES).map(([name, file]) => [name, path.join(dir, file)]));
}

export class InvoicePdfError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'InvoicePdfError';
    this.statusCode = statusCode;
  }
}

const marks = (value) => (Number.isInteger(Number(value)) ? String(Number(value)) : Number(value).toFixed(2));
/** Cut text to `max` characters with an ellipsis, so one long value can't overflow a page. */
const clip = (value, max) => { const t = String(value ?? ''); return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t; };
// Drawn-size limits: the address is at most 6 lines, every cell stays well under a page.
const LIMITS = { legalName: 120, addressLines: 6, addressLine: 90, examName: 140, voidReason: 120 };

export const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const isPng = (bytes) => Buffer.isBuffer(bytes) && bytes.subarray(0, 8).equals(PNG_MAGIC);

/**
 * The authorised signature, from private R2. Only a missing object (404) or a
 * non-PNG answers "not uploaded"; storage misconfiguration, network errors and
 * other statuses throw, so the route logs them as internal errors instead of
 * sending admins to re-upload a signature that is already there.
 */
export async function loadSignature() {
  const response = await getObject({ key: SIGNATURE_KEY });
  if (response.status === 404) throw new InvoicePdfError(503, `The invoice signature isn't uploaded (expected a PNG at ${SIGNATURE_KEY} in private storage). Run scripts/uploadInvoiceSignature.mjs.`);
  if (!response.ok) throw new Error(`Could not read the invoice signature from storage (HTTP ${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!isPng(bytes)) throw new InvoicePdfError(503, `The invoice signature at ${SIGNATURE_KEY} isn't a PNG. Re-run scripts/uploadInvoiceSignature.mjs with the PNG.`);
  return bytes;
}

export const pdfFilename = (invoice) => invoicePdfFilename(invoice.number);

/**
 * Draw the invoice. `assets` = { signature: Buffer (PNG), bank: {…} } (bank defaults to FALKRAM_BANK).
 * Returns a Buffer. `trace`, when given, receives every drawn string as
 * { page, value } (tests read content through it).
 */
export async function renderInvoicePdf(invoice, { signature, bank = FALKRAM_BANK, trace }) {
  const { default: PDFDocument } = await import('pdfkit');
  const doc = new PDFDocument({
    size: 'A4', margins: { top: 0, bottom: 0, left: 0, right: 0 }, bufferPages: true, autoFirstPage: false,
    info: { Title: `Invoice ${invoice.number}`, Author: 'Falkram PVT LTD', Subject: `${invoice.school || invoice.billTo?.legalName || ''} · ${periodLabel(invoice.period)}` },
    displayTitle: true,
    // Our own default font: pdfkit otherwise loads its built-in Helvetica via
    // package `imports` (#standard-fonts/*), which would also have to ship in
    // the Vercel bundle. With this, no standard font is ever loaded.
    font: fonts().Inter,
  });
  for (const [name, data] of Object.entries(fonts())) doc.registerFont(name, data);
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });

  let page = -1;
  const text = (value, x, y, { font = 'Inter', size = 10.5, color = COLOR.ink, width, align = 'left', spacing = 0, upper = false, lineGap = 0 } = {}) => {
    const shown = upper ? String(value).toUpperCase() : String(value);
    trace?.push({ page, value: shown });
    doc.font(font).fontSize(size).fillColor(color);
    doc.text(shown, x, y, { width, align, characterSpacing: spacing, lineGap, lineBreak: Boolean(width) });
    return doc.y;
  };
  const height = (value, { font = 'Inter', size = 10.5, width, spacing = 0, lineGap = 0 } = {}) => doc.font(font).fontSize(size).heightOfString(String(value), { width, characterSpacing: spacing, lineGap });
  const rule = (x1, y, x2, color = COLOR.line, weight = 0.75) => doc.save().moveTo(x1, y).lineTo(x2, y).lineWidth(weight).strokeColor(color).stroke().restore();
  const label = (value, x, y, opts = {}) => text(value, x, y, { font: 'Inter-Bold', size: 7, color: COLOR.dim, spacing: 7 * 0.13, upper: true, ...opts });

  const newPage = () => {
    doc.addPage({ size: 'A4', margins: { top: 0, bottom: 0, left: 0, right: 0 } });
    page += 1;
    // The kit prints the body's paper colour inside the page margins only.
    doc.save().rect(LEFT, MARGIN.top, WIDTH, BOTTOM - MARGIN.top).fill(COLOR.paper).restore();
    return MARGIN.top;
  };

  // ── Header ─────────────────────────────────────────────────────────────
  let y = newPage();
  text('FALKRAM PVT LTD', LEFT, y, { font: 'Fraunces-Bold', size: 20 });
  text('CIN U32409PN2026PTC258972 · Pune, Maharashtra, India', LEFT, y + 27, { size: 8, color: COLOR.dim, spacing: 8 * 0.05 });
  text('INVOICE', LEFT, y - 2, { font: 'Fraunces-Bold', size: 28, color: COLOR.red, width: WIDTH, align: 'right', spacing: -28 * 0.02 });
  const metaTop = y + 38;
  text(`Invoice No: ${invoice.number}`, LEFT, metaTop, { size: 9, color: COLOR.dim, width: WIDTH, align: 'right' });
  text(`Date: ${longDate(invoice.invoiceDate)}`, LEFT, metaTop + 14, { size: 9, color: COLOR.dim, width: WIDTH, align: 'right' });
  text(`Period: ${periodLabel(invoice.period)}`, LEFT, metaTop + 28, { size: 9, color: COLOR.dim, width: WIDTH, align: 'right' });
  y = metaTop + 28 + 14 + 22.5;

  // ── Bill To / GSTN / PAN / Place of Supply ─────────────────────────────
  const billTo = invoice.billTo || {};
  const half = WIDTH / 2;
  const padX = 10.5;
  const padY = 7.5;
  const cellWidth = half - padX * 2;
  const addressLines = String(billTo.address || '').split('\n').filter(Boolean);
  const address = [...addressLines.slice(0, LIMITS.addressLines - 1), ...(addressLines.length >= LIMITS.addressLines ? [addressLines.slice(LIMITS.addressLines - 1).join(', ')] : [])]
    .map((lineText) => clip(lineText, LIMITS.addressLine));
  const billToValue = [clip(billTo.legalName, LIMITS.legalName), ...address].filter(Boolean).join('\n');
  const cells = [['Bill To', billToValue], ['GSTN', billTo.gstin || '—'], ['PAN', billTo.pan || '—'], ['Place of Supply', billTo.placeOfSupply || '—']];
  const cellHeight = (value) => padY + 10 + height(value, { font: 'Inter-SemiBold', size: 9.5, width: cellWidth, lineGap: 1.5 }) + padY;
  const rowHeights = [Math.max(cellHeight(cells[0][1]), cellHeight(cells[1][1])), Math.max(cellHeight(cells[2][1]), cellHeight(cells[3][1]))];
  const gridHeight = rowHeights[0] + rowHeights[1];
  doc.save().roundedRect(LEFT, y, WIDTH, gridHeight, 3.75).fill(COLOR.white).restore();
  cells.forEach(([title, value], index) => {
    const x = LEFT + (index % 2) * half;
    const top = y + (index < 2 ? 0 : rowHeights[0]);
    label(title, x + padX, top + padY);
    text(value, x + padX, top + padY + 10, { font: 'Inter-SemiBold', size: 9.5, width: cellWidth, lineGap: 1.5 });
  });
  doc.save().lineWidth(0.75).strokeColor(COLOR.line)
    .roundedRect(LEFT, y, WIDTH, gridHeight, 3.75).stroke()
    .moveTo(LEFT + half, y).lineTo(LEFT + half, y + gridHeight).stroke()
    .moveTo(LEFT, y + rowHeights[0]).lineTo(RIGHT, y + rowHeights[0]).stroke()
    .restore();
  y += gridHeight + 18 + 12;

  // ── Particulars ────────────────────────────────────────────────────────
  text('1', LEFT, y + 2.5, { font: 'Fraunces-SemiBold', size: 10, color: COLOR.red });
  text('Particulars', LEFT + 13, y, { font: 'Fraunces-SemiBold', size: 13 });
  y += 18 + 4.5;
  rule(LEFT, y, RIGHT);
  y += 6.75;

  const columns = [
    { title: 'Exam', width: 0.3 },
    { title: 'Date', width: 0.15 },
    { title: 'Marks', width: 0.1, align: 'right' },
    { title: 'Papers', width: 0.1, align: 'right' },
    { title: 'Rate', width: 0.17, align: 'right' },
    { title: 'Amount (INR)', width: 0.18, align: 'right' },
  ].map((column) => ({ ...column, width: column.width * WIDTH }));
  const cellPadX = 6.75;
  const cellPadY = 5.25;
  const tableHeader = () => {
    const headerHeight = cellPadY * 2 + 9;
    doc.save().rect(LEFT, y, WIDTH, headerHeight).fill(COLOR.mist).restore();
    let x = LEFT;
    for (const column of columns) {
      label(column.title, x + cellPadX, y + cellPadY + 1, { size: 7.5, spacing: 7.5 * 0.11, width: column.width - cellPadX * 2, align: column.align || 'left' });
      x += column.width;
    }
    y += headerHeight;
    rule(LEFT, y, RIGHT, COLOR.ink, 1.125);
  };
  const rowHeightOf = (cellsText, font) => cellPadY * 2 + Math.max(...cellsText.map((value, index) => height(value, { font, size: 9, width: columns[index].width - cellPadX * 2 })));
  const drawRow = (cellsText, { font = 'Inter', topRule = null } = {}) => {
    const rowHeight = rowHeightOf(cellsText, font);
    // Never split a row: move it (with a repeated header) to the next page.
    if (y + rowHeight > BOTTOM - 12) { y = newPage(); tableHeader(); }
    doc.save().rect(LEFT, y, WIDTH, rowHeight).fill(COLOR.white).restore();
    if (topRule) rule(LEFT, y, RIGHT, topRule.color, topRule.weight);
    let x = LEFT;
    cellsText.forEach((value, index) => {
      text(value, x + cellPadX, y + cellPadY, { font, size: 9, width: columns[index].width - cellPadX * 2, align: columns[index].align || 'left' });
      x += columns[index].width;
    });
    y += rowHeight;
    rule(LEFT, y, RIGHT);
  };

  tableHeader();
  for (const line of invoice.lines) {
    drawRow([clip(line.examName, LIMITS.examName), shortDate(line.examDate), marks(line.maxMarks), String(line.papers), formatLineRate(line), formatINR(line.amountPaise)]);
  }
  const summary = (title, paise, options) => drawRow([title, '', '', '', '', formatINR(paise)], options);
  summary('Subtotal', invoice.subtotalPaise, { topRule: { color: COLOR.ink, weight: 1.125 } });
  summary('Round-off', invoice.roundOffPaise);
  summary('Total', invoice.totalPaise, { font: 'Inter-SemiBold', topRule: { color: COLOR.ink, weight: 1.125 } });

  // ── Total box, bank details, signature, notes ──────────────────────────
  // Kept together: if they don't fit under the table, they start a new page.
  // The page-break check and the drawing below use the same named parts.
  const CLOSING = { gapAbove: 15, boxHeight: 10.5 * 2 + 26, gapAfterBox: 15 + 30, bankTextTop: 13, bankLineGap: 1.5, signImageTop: 8, signLabelTop: 48, signBlockMin: 60, gapAfterSign: 18, noteBlock: 9 + 12 + 22.5, footerLine: 20 };
  const bankLines = [`Account Name: ${bank.accountName}`, `Account No: ${bank.accountNo}`, `IFSC: ${bank.ifsc}`, `Bank: ${bank.bank}`];
  const bankTextWidth = 210;
  const bankHeight = CLOSING.bankTextTop + bankLines.reduce((sum, lineText) => sum + height(lineText, { size: 8.5, width: bankTextWidth }) + CLOSING.bankLineGap, 0);
  const signBlockHeight = Math.max(bankHeight, CLOSING.signBlockMin);
  const closingHeight = CLOSING.gapAbove + CLOSING.boxHeight + CLOSING.gapAfterBox + signBlockHeight + CLOSING.gapAfterSign + CLOSING.noteBlock + CLOSING.footerLine;
  if (y + closingHeight > BOTTOM) y = newPage();
  y += CLOSING.gapAbove;
  const boxHeight = CLOSING.boxHeight;
  doc.save().roundedRect(LEFT, y, WIDTH, boxHeight, 3.75).fill(COLOR.mist).restore();
  doc.save().roundedRect(LEFT + 0.75, y + 0.75, WIDTH - 1.5, boxHeight - 1.5, 3.75).lineWidth(1.5).strokeColor(COLOR.ink).stroke().restore();
  text('Total Amount Chargeable', LEFT + 13.5, y + boxHeight / 2 - 6, { font: 'Inter-SemiBold', size: 10 });
  text(`INR ${formatINR(invoice.totalPaise)}`, LEFT + 13.5, y + boxHeight / 2 - 14, { font: 'Fraunces-Bold', size: 20, width: WIDTH - 27, align: 'right' });
  y += boxHeight + CLOSING.gapAfterBox;

  const signTop = y;
  label('Bank Details', LEFT, y);
  let bankY = y + CLOSING.bankTextTop;
  for (const lineText of bankLines) {
    bankY = text(lineText, LEFT, bankY, { size: 8.5, color: COLOR.dim, width: bankTextWidth }) + CLOSING.bankLineGap;
  }
  const signWidth = 150;
  doc.image(signature, RIGHT - signWidth, signTop + CLOSING.signImageTop, { fit: [signWidth, 36], align: 'right', valign: 'bottom' });
  // The kit's signatory label is regular weight, unlike the bold block labels.
  label('Authorised Signatory', RIGHT - signWidth - 40, signTop + CLOSING.signLabelTop, { font: 'Inter', width: signWidth + 40, align: 'right' });
  y = signTop + signBlockHeight + CLOSING.gapAfterSign;

  rule(LEFT, y, RIGHT);
  text('This is a Computer Generated Invoice', LEFT, y + 9, { font: 'Inter-Italic', size: 8, color: COLOR.dim, width: WIDTH, align: 'center' });
  y += CLOSING.noteBlock;
  rule(LEFT, y, RIGHT);
  text(`Falkram PVT LTD · Invoice ${invoice.number} · ${longDate(invoice.invoiceDate)}`, LEFT, y + 9, { size: 8, color: COLOR.dim, width: WIDTH });

  // ── Every page: VOID watermark and the kit's page footer ───────────────
  const range = doc.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index += 1) {
    doc.switchToPage(index);
    page = index - range.start;
    if (invoice.status === 'void') {
      trace?.push({ page, value: 'VOID' });
      doc.save().rotate(-30, { origin: [PAGE.width / 2, PAGE.height / 2] }).fillOpacity(0.12)
        .font('Inter-Bold').fontSize(150).fillColor(COLOR.red)
        .text('VOID', 0, PAGE.height / 2 - 90, { width: PAGE.width, align: 'center', lineBreak: false })
        .restore();
      if (index === range.start && invoice.voidedAt) {
        text(`VOID · ${shortDate(invoice.voidedAt)} · ${clip(invoice.voidReason, LIMITS.voidReason)}`, LEFT, MARGIN.top - 16, { font: 'Inter-SemiBold', size: 8, color: COLOR.red, width: WIDTH });
      }
    }
    const footerY = PAGE.height - MARGIN.bottom / 2 - 3;
    text('Falkram PVT LTD · Confidential', LEFT, footerY, { size: 7, color: COLOR.dim, width: WIDTH / 2 });
    text(`${index - range.start + 1} / ${range.count}`, LEFT + WIDTH / 2, footerY, { size: 7, color: COLOR.dim, width: WIDTH / 2, align: 'right' });
  }

  doc.end();
  return done;
}
