// The parent fees page (CRM M2 phase 2 S3, D10; CRM-018's guardian view).
// No login: a fees link from a WhatsApp message opens every child that
// guardian pays for (fee payer, or primary guardian when no fee payer is set).
// It shows balances, invoices and receipts, and the class's payment
// instructions. Never internal notes, references, reasons or other guardians.
//
// Links are stored hashed, expire after 60 days, can be revoked, and are
// rate-limited per address and per link. Responses are no-store and noindex.
import { z } from 'zod';
import { PAYMENT_METHOD_LABELS } from '../../shared/crm/fees.js';
import { localDate } from '../../shared/crm/time.js';
import { checkRateLimit } from '../../api/_lib/rateLimit.js';
import { schoolContext } from '../comms/fees.js';
import { hashToken, openLink } from '../comms/links.js';
import { CrmHttpError, crmErrors } from './errors.js';
import { feeSettings } from './feePlans.js';
import { documentFilename, renderFeeInvoicePdf, renderFeeReceiptPdf } from './feeDocuments.js';
import { clientAddress } from './inquiry.js';
import { INVOICE_SELECT, linesFor, serializeInvoice, summarize } from './invoices.js';
import { PAID_SQL } from './ledger.js';
import { PAYMENT_SELECT, allocationsFor, loadPayment, serializePayment } from './payments.js';

const token = z.string().trim().min(1).max(100);
export const publicFeesQuery = z.object({ token }).passthrough();
export const publicInvoiceQuery = z.object({ token, invoiceId: z.string().trim().min(1).max(128) }).passthrough();
export const publicReceiptQuery = z.object({ token, paymentId: z.string().trim().min(1).max(128) }).passthrough();

const LINK_PROBLEMS = {
  expired: () => new CrmHttpError(410, 'link_expired', 'This link has expired. Ask the class for a new one.'),
  revoked: () => new CrmHttpError(410, 'link_revoked', 'This link is no longer active. Ask the class for a new one.'),
  not_found: () => crmErrors.notFound(),
};

function privateHeaders(res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

async function limited(req, raw) {
  const [byAddress, byLink] = await Promise.all([
    checkRateLimit(`parent-link:${clientAddress(req)}`, { max: 60, windowMs: 60_000 }),
    checkRateLimit(`parent-link:${hashToken(raw).slice(0, 32)}`, { max: 30, windowMs: 60_000 }),
  ]);
  if (byAddress || byLink) throw new CrmHttpError(429, 'rate_limited', 'Too many requests. Please wait a minute and try again.');
}

/** The link's school, guardian and the active students they pay for. */
async function resolve(db, req, res, raw) {
  privateHeaders(res);
  await limited(req, raw);
  const { link, problem } = await openLink(db, raw, 'fees');
  if (problem) throw LINK_PROBLEMS[problem]();
  const contact = (await db.execute({
    sql: 'SELECT id, full_name FROM crm_contacts WHERE id = ? AND school_id = ? AND anonymised_at IS NULL', args: [link.contact_id, link.school_id],
  })).rows[0];
  if (!contact) throw crmErrors.notFound();
  // Fee payer of the student, or the primary guardian where nobody is marked fee payer (D5, D9).
  const students = await db.execute({
    sql: `SELECT s.id, s.display_name FROM crm_guardian_links g JOIN students s ON s.id = g.student_id AND s.school_id = g.school_id
          WHERE g.school_id = ? AND g.contact_id = ? AND g.status = 'active' AND s.status != 'archived'
            AND (g.is_fee_payer = 1 OR (g.is_primary = 1 AND NOT EXISTS (
              SELECT 1 FROM crm_guardian_links o WHERE o.school_id = g.school_id AND o.student_id = g.student_id AND o.status = 'active' AND o.is_fee_payer = 1)))
          ORDER BY s.display_name`,
    args: [link.school_id, contact.id],
  });
  const context = await schoolContext(db, link.school_id);
  return { link, contact, students: students.rows, scope: { schoolId: link.school_id, timezone: context.timeZone }, context };
}

function publicInvoice(invoice) {
  return {
    id: invoice.id, number: invoice.number, issueDate: invoice.issueDate, dueDate: invoice.dueDate, totalPaise: invoice.totalPaise, paidPaise: invoice.paidPaise,
    balancePaise: invoice.balancePaise, paymentStatus: invoice.paymentStatus, overdue: invoice.overdue, lines: invoice.lines,
  };
}

function publicPayment(payment) {
  return {
    id: payment.id, receiptNumber: payment.receiptNumber, receivedOn: payment.receivedOn, amountPaise: payment.amountPaise,
    method: PAYMENT_METHOD_LABELS[payment.method] || payment.method, reversed: Boolean(payment.reversal),
  };
}

export async function getPublicFees({ req, res, db, input }) {
  const { link, contact, students, scope, context } = await resolve(db, req, res, input.query.token);
  const settings = await feeSettings(db, scope);
  const today = localDate(Date.now(), scope.timezone);
  const children = [];
  for (const student of students) {
    const [rows, payments] = await Promise.all([
      db.execute({ sql: `${INVOICE_SELECT} WHERE i.school_id = ? AND i.student_id = ? AND i.status = 'issued' ORDER BY i.due_date, i.seq`, args: [scope.schoolId, student.id] }),
      db.execute({ sql: `${PAYMENT_SELECT} WHERE p.school_id = ? AND p.student_id = ? AND p.kind = 'payment' ORDER BY p.received_on DESC, p.created_at DESC`, args: [scope.schoolId, student.id] }),
    ]);
    const [lines, allocations] = await Promise.all([linesFor(db, scope, rows.rows.map((row) => row.id)), allocationsFor(db, scope, payments.rows.map((row) => row.id))]);
    const invoices = rows.rows.map((row) => serializeInvoice(row, lines[row.id] || [], today));
    const paymentItems = payments.rows.map((row) => serializePayment(row, allocations[row.id] || []));
    // A child with no fees at all isn't shown.
    if (!invoices.length && !paymentItems.length) continue;
    const { balancePaise, overduePaise, creditPaise } = summarize(invoices, paymentItems.reduce((sum, payment) => sum + payment.unallocatedPaise, 0));
    // "Next due" is the next date still ahead; overdue fees show under Overdue.
    const upcoming = invoices.filter((invoice) => invoice.balancePaise > 0 && invoice.dueDate >= today).sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1))[0];
    const nextDue = upcoming ? { dueDate: upcoming.dueDate, amountPaise: upcoming.balancePaise } : null;
    children.push({
      name: student.display_name,
      summary: { balancePaise, overduePaise, creditPaise, nextDue },
      invoices: invoices.map(publicInvoice),
      payments: paymentItems.map(publicPayment),
    });
  }
  return {
    school: { name: settings.headerName, address: settings.headerAddress || null, phone: settings.headerPhone || null },
    guardianName: contact.full_name || null,
    paymentInstructions: context.settings.payment_instructions || null,
    contactLine: context.settings.contact_line || null,
    language: context.settings.language,
    expiresAt: link.expires_at,
    today,
    children,
  };
}

function sendPdf(res, body, filename) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', String(body.length));
  return res.status(200).send(body);
}

export async function getPublicInvoicePdf({ req, res, db, input }) {
  const { students, scope } = await resolve(db, req, res, input.query.token);
  const row = (await db.execute({ sql: `SELECT i.*, ${PAID_SQL} AS paid_paise FROM crm_invoices i WHERE i.id = ? AND i.school_id = ? AND i.status = 'issued'`, args: [input.query.invoiceId, scope.schoolId] })).rows[0];
  // Another family's invoice is indistinguishable from a missing one.
  if (!row || !students.some((student) => student.id === row.student_id)) throw crmErrors.notFound();
  const lines = (await linesFor(db, scope, [row.id]))[row.id] || [];
  const body = await renderFeeInvoicePdf({
    number: row.number, status: row.status, issueDate: row.issue_date, dueDate: row.due_date, totalPaise: Number(row.total_paise), paidPaise: Number(row.paid_paise),
    voidReason: null, billTo: JSON.parse(row.bill_to_json), lines: lines.map((line) => ({ label: line.label, amountPaise: Number(line.amount_paise) })),
  }, { today: localDate(Date.now(), scope.timezone) });
  return sendPdf(res, body, documentFilename(row.number));
}

export async function getPublicReceiptPdf({ req, res, db, input }) {
  const { students, scope } = await resolve(db, req, res, input.query.token);
  let payment;
  try { payment = await loadPayment(db, scope, input.query.paymentId); } catch { throw crmErrors.notFound(); }
  const student = students.find((item) => item.id === payment.student.id);
  if (!student) throw crmErrors.notFound();
  const settings = await feeSettings(db, scope);
  const balance = await db.execute({ sql: `SELECT COALESCE(SUM(i.total_paise - ${PAID_SQL}), 0) AS due FROM crm_invoices i WHERE i.school_id = ? AND i.student_id = ? AND i.status = 'issued'`, args: [scope.schoolId, student.id] });
  // The receipt document never shows internal notes; the reversal reason is staff-facing, so it's left out here.
  const shown = payment.reversal ? { ...payment, reversal: { at: payment.reversal.at, reason: 'Reversed by the class' } } : payment;
  const body = await renderFeeReceiptPdf(shown, {
    school: { name: settings.headerName, address: settings.headerAddress, phone: settings.headerPhone, gstin: settings.headerGstin, footer: settings.footerNote },
    studentName: student.display_name, balancePaise: Number(balance.rows[0].due),
  });
  return sendPdf(res, body, documentFilename(payment.receiptNumber));
}
