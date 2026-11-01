/* Monthly per-school invoices for graded papers (FLKRM-486, epic FLKRM-483).
 *
 * A paper (one submissions row) is billable when its report was built
 * (submissions.graded_at, FLKRM-484) in the billed month, Asia/Kolkata time,
 * its exam belongs to the school and is not archived, it is not blank (every
 * question not attempted), and it is not already on a live invoice. Papers
 * whose test was deleted lost their exam row and drop out through the JOIN.
 * Only schools with a complete billing profile (FLKRM-485) are invoiced.
 *
 * Price: per school (#311, api/_lib/pricing.js). A school with price bands is
 * billed per paper from the band covering the paper's total; otherwise 25
 * paise per mark. Each line stores the price it was billed at. Lines keep exact
 * paise; only the total is rounded to the rupee, with the difference shown as
 * a round-off line. No GST.
 *
 * Invoices are immutable once issued and numbered SKY/<FY>/<seq>, where FY is
 * the invoice date's financial year (April-March) and seq never repeats or
 * skips: it is allocated in the same write transaction that inserts the
 * invoice, so a failed or racing generation rolls the counter back too. The
 * database enforces one issued invoice per (school, month) and one live
 * invoice per paper (partial unique indexes, migration 074).
 */
import { randomUUID } from 'node:crypto';
import { getBillingProfile, isBillingProfileComplete } from './billingProfiles.js';
import { DEFAULT_RATE_PAISE_PER_MARK, getPricingBands, priceForPaper } from './pricing.js';

export const RATE_PAISE_PER_MARK = DEFAULT_RATE_PAISE_PER_MARK;
/** Invoicing starts with September 2026 (decided in the FLKRM-483 grilling). */
export const FIRST_BILLABLE_PERIOD = '2026-09';
const IST_OFFSET_MS = 330 * 60 * 1000;
const PERIOD = /^(\d{4})-(0[1-9]|1[0-2])$/;

export class InvoiceError extends Error {
  constructor(statusCode, message, code) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

const fail = (statusCode, message, code) => { throw new InvoiceError(statusCode, message, code); };

/** The IST calendar date/month of an instant. */
export function istDate(at = new Date()) {
  return new Date(new Date(at).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}
export const currentPeriod = (at = new Date()) => istDate(at).slice(0, 7);

export function assertPeriod(period) {
  if (!PERIOD.test(String(period || ''))) fail(400, 'period must be YYYY-MM.', 'bad_period');
  return period;
}

/** UTC ISO bounds [start, end) of an IST calendar month, comparable with graded_at. */
export function periodBounds(period) {
  const [, year, month] = assertPeriod(period).match(PERIOD);
  const start = Date.UTC(Number(year), Number(month) - 1, 1) - IST_OFFSET_MS;
  const end = Date.UTC(Number(year), Number(month), 1) - IST_OFFSET_MS;
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}

/** Financial year (April-March) of an IST date: '2027-03-31' → '2026-27'. */
export function financialYear(date) {
  const [year, month] = String(date).split('-').map(Number);
  const startYear = month >= 4 ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

export const invoiceNumber = (fy, seq) => `SKY/${fy}/${String(seq).padStart(4, '0')}`;

/** A paper's amount under the default rule (25 paise per mark). */
export const paperAmountPaise = (maxMarks) => priceForPaper(maxMarks).amountPaise;

/**
 * Lines (one per exam and paper total) and totals for a list of billable
 * papers. Each paper carries its `price` (from priceForPaper); papers without
 * one are priced by the default rule.
 */
export function priceInvoice(papers) {
  const groups = new Map();
  for (const paper of papers) {
    const price = paper.price || priceForPaper(paper.maxMarks);
    const key = `${paper.examId}\u0000${Number(paper.maxMarks)}`;
    if (!groups.has(key)) groups.set(key, { examId: paper.examId, examName: paper.examName, examDate: paper.examDate, maxMarks: Number(paper.maxMarks), papers: 0, ratePaisePerMark: price.ratePaisePerMark, pricePaisePerPaper: price.pricePaisePerPaper, amountPaise: 0 });
    const line = groups.get(key);
    line.papers += 1;
    line.amountPaise += price.amountPaise;
  }
  const lines = [...groups.values()].sort((a, b) => String(a.examDate || '').localeCompare(String(b.examDate || ''))
    || a.examName.localeCompare(b.examName) || a.maxMarks - b.maxMarks);
  const subtotalPaise = lines.reduce((sum, line) => sum + line.amountPaise, 0);
  // Nearest rupee, 50 paise rounds up.
  const totalPaise = Math.floor((subtotalPaise + 50) / 100) * 100;
  return { lines, paperCount: papers.length, subtotalPaise, roundOffPaise: totalPaise - subtotalPaise, totalPaise };
}

/** Billable papers for one school and month, not yet on a live invoice. */
export async function billablePapers(db, schoolId, period) {
  const { start, end } = periodBounds(period);
  const result = await db.execute({
    sql: `SELECT s.id AS submission_id, s.student_id, s.max_marks, s.graded_at,
                 e.id AS exam_id, e.name AS exam_name, COALESCE(e.exam_date, e.created_at) AS exam_date,
                 st.display_name AS student_name
          FROM submissions s
          JOIN exams e ON e.id = s.exam_id
          LEFT JOIN students st ON st.id = s.student_id
          WHERE e.school_id = ?
            AND s.graded_at >= ? AND s.graded_at < ?
            AND s.max_marks IS NOT NULL
            AND e.status <> 'archived' AND e.archived_at IS NULL
            AND EXISTS (SELECT 1 FROM submission_questions_v2 q WHERE q.submission_id = s.id
                          AND COALESCE(json_extract(q.render_json, '$.studentAnswer.attempted'), 1) <> 0)
            AND NOT EXISTS (SELECT 1 FROM invoice_papers p WHERE p.submission_id = s.id AND p.released_at IS NULL)
          ORDER BY e.name, st.display_name, s.id`,
    args: [schoolId, start, end],
  });
  return result.rows.map((row) => ({
    submissionId: row.submission_id,
    studentId: row.student_id,
    studentName: row.student_name || row.student_id,
    examId: row.exam_id,
    examName: row.exam_name,
    examDate: row.exam_date ? String(row.exam_date).slice(0, 10) : null,
    maxMarks: Number(row.max_marks),
    amountPaise: paperAmountPaise(row.max_marks),
    gradedAt: row.graded_at,
  }));
}

function presentInvoice(row) {
  return {
    id: row.id,
    schoolId: row.school_id,
    school: row.school_name ?? undefined,
    period: row.period,
    number: row.number,
    status: row.status,
    invoiceDate: row.invoice_date,
    paperCount: Number(row.paper_count),
    subtotalPaise: Number(row.subtotal_paise),
    roundOffPaise: Number(row.round_off_paise),
    totalPaise: Number(row.total_paise),
    billTo: JSON.parse(row.bill_to_json || '{}'),
    issuedBy: row.issued_by,
    issuedAt: row.issued_at,
    voidedBy: row.voided_by || null,
    voidedAt: row.voided_at || null,
    voidReason: row.void_reason || null,
    paidOn: row.paid_on || null,
    paidReference: row.paid_reference || null,
    paidMarkedBy: row.paid_marked_by || null,
    paidMarkedAt: row.paid_marked_at || null,
    pdfKey: row.pdf_key || null,
  };
}

async function liveInvoice(db, schoolId, period) {
  const result = await db.execute({ sql: "SELECT * FROM invoices WHERE school_id = ? AND period = ? AND status = 'issued' LIMIT 1", args: [schoolId, period] });
  return result.rows[0] ? presentInvoice(result.rows[0]) : null;
}

/**
 * What an invoice for (school, period) would contain right now, and whether it
 * can be generated. Works for any month; only generation is restricted.
 */
export async function previewInvoice(db, { schoolId, period, now = new Date() }) {
  if (!schoolId) fail(400, 'schoolId is required.', 'bad_school');
  assertPeriod(period);
  const school = (await db.execute({ sql: 'SELECT id, display_name FROM schools WHERE id = ? LIMIT 1', args: [schoolId] })).rows[0];
  if (!school) fail(404, 'School not found.', 'school_not_found');
  const [profile, existing, allPapers, bands] = await Promise.all([getBillingProfile(db, schoolId), liveInvoice(db, schoolId, period), billablePapers(db, schoolId, period), getPricingBands(db, schoolId)]);
  // Price every paper with the school's bands (or the default rule). A banded
  // school's paper above its top band has no price and blocks generation.
  const papers = [];
  const unpriced = [];
  for (const paper of allPapers) {
    const price = priceForPaper(paper.maxMarks, bands);
    if (price) papers.push({ ...paper, amountPaise: price.amountPaise, price });
    else unpriced.push(paper);
  }
  const uncoveredTotals = [...new Set(unpriced.map((paper) => paper.maxMarks))].sort((a, b) => a - b);
  const priced = priceInvoice(papers);
  let blocker = null;
  if (period < FIRST_BILLABLE_PERIOD) blocker = { code: 'before_start', message: `Invoicing starts with ${FIRST_BILLABLE_PERIOD}.` };
  else if (period >= currentPeriod(now)) blocker = { code: 'month_not_over', message: 'Only completed months can be invoiced.' };
  else if (!isBillingProfileComplete(profile)) blocker = { code: 'profile_incomplete', message: 'Complete the school\'s billing profile first.' };
  else if (existing) blocker = { code: 'already_invoiced', message: `${existing.number} is already issued for this month. Void it to reissue.` };
  else if (!allPapers.length) blocker = { code: 'nothing_to_invoice', message: 'No billable papers in this month.' };
  else if (unpriced.length) blocker = { code: 'price_band_missing', message: `No price band covers ${uncoveredTotals.join(', ')}-mark papers (${unpriced.length} paper${unpriced.length === 1 ? '' : 's'}). Add a band in the school's pricing and try again.` };
  return { schoolId, school: school.display_name, period, profile, existingInvoice: existing, pricing: { bands, isDefault: !bands.length }, papers, unpricedPapers: unpriced, uncoveredTotals, ...priced, canGenerate: !blocker, blocker };
}

/** Issue the invoice for (school, period). Throws InvoiceError when refused. */
export async function generateInvoice(db, { schoolId, period, issuedBy, now = new Date() }) {
  const preview = await previewInvoice(db, { schoolId, period, now });
  if (preview.blocker) fail(preview.blocker.code === 'already_invoiced' ? 409 : 422, preview.blocker.message, preview.blocker.code);
  const invoiceId = `inv_${randomUUID()}`;
  const issuedAt = new Date(now).toISOString();
  const invoiceDate = istDate(now);
  const fy = financialYear(invoiceDate);
  const billTo = { legalName: preview.profile.legalName, address: preview.profile.address, gstin: preview.profile.gstin, pan: preview.profile.pan, placeOfSupply: preview.profile.placeOfSupply };
  const seq = '(SELECT last_seq FROM invoice_counters WHERE fy = ?)';
  const statements = [
    { sql: 'INSERT INTO invoice_counters (fy, last_seq) VALUES (?, 1) ON CONFLICT(fy) DO UPDATE SET last_seq = last_seq + 1', args: [fy] },
    {
      sql: `INSERT INTO invoices (id, school_id, period, fy, seq, number, status, invoice_date, paper_count,
              subtotal_paise, round_off_paise, total_paise, bill_to_json, issued_by, issued_at)
            VALUES (?, ?, ?, ?, ${seq}, 'SKY/' || ? || '/' || printf('%04d', ${seq}), 'issued', ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [invoiceId, schoolId, period, fy, fy, fy, fy, invoiceDate, preview.paperCount,
        preview.subtotalPaise, preview.roundOffPaise, preview.totalPaise, JSON.stringify(billTo), issuedBy, issuedAt],
    },
    ...preview.lines.map((line, index) => ({
      // Banded lines store their per-paper price; rate_paise_per_mark is NOT NULL (074), so 0 there.
      sql: `INSERT INTO invoice_lines (id, invoice_id, position, exam_id, exam_name, exam_date, max_marks, papers, rate_paise_per_mark, price_paise_per_paper, amount_paise)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [`invl_${randomUUID()}`, invoiceId, index + 1, line.examId, line.examName, line.examDate, line.maxMarks, line.papers, line.ratePaisePerMark ?? 0, line.pricePaisePerPaper ?? null, line.amountPaise],
    })),
    ...preview.papers.map((paper) => ({
      sql: `INSERT INTO invoice_papers (invoice_id, submission_id, exam_id, student_id, student_name, max_marks, amount_paise, graded_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [invoiceId, paper.submissionId, paper.examId, paper.studentId, paper.studentName, paper.maxMarks, paper.amountPaise, paper.gradedAt],
    })),
  ];
  try {
    await db.batch(statements, 'write');
  } catch (error) {
    // A concurrent generation won the race: the unique indexes refused this
    // one and the whole batch, counter included, rolled back.
    if (/UNIQUE constraint failed/i.test(String(error?.message || error))) fail(409, 'This month or some of its papers were invoiced by a concurrent request. Refresh and try again.', 'conflict');
    throw error;
  }
  return getInvoice(db, invoiceId);
}

export async function getInvoice(db, invoiceId) {
  const row = (await db.execute({ sql: 'SELECT i.*, s.display_name AS school_name FROM invoices i JOIN schools s ON s.id = i.school_id WHERE i.id = ? LIMIT 1', args: [invoiceId] })).rows[0];
  if (!row) fail(404, 'Invoice not found.', 'invoice_not_found');
  const [lines, papers] = await Promise.all([
    db.execute({ sql: 'SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY position', args: [invoiceId] }),
    db.execute({ sql: 'SELECT * FROM invoice_papers WHERE invoice_id = ? ORDER BY student_name, submission_id', args: [invoiceId] }),
  ]);
  return {
    ...presentInvoice(row),
    lines: lines.rows.map((line) => ({ examId: line.exam_id, examName: line.exam_name, examDate: line.exam_date, maxMarks: Number(line.max_marks), papers: Number(line.papers), ratePaisePerMark: line.price_paise_per_paper == null ? Number(line.rate_paise_per_mark) : null, pricePaisePerPaper: line.price_paise_per_paper == null ? null : Number(line.price_paise_per_paper), amountPaise: Number(line.amount_paise) })),
    papers: papers.rows.map((paper) => ({ submissionId: paper.submission_id, examId: paper.exam_id, studentId: paper.student_id, studentName: paper.student_name, maxMarks: Number(paper.max_marks), amountPaise: Number(paper.amount_paise), gradedAt: paper.graded_at, releasedAt: paper.released_at || null })),
  };
}

/** Invoices newest first (optionally one school's), plus unpaid totals per school. */
export async function listInvoices(db, { schoolId } = {}) {
  const invoices = await db.execute({
    sql: `SELECT i.*, s.display_name AS school_name FROM invoices i JOIN schools s ON s.id = i.school_id
          ${schoolId ? 'WHERE i.school_id = ?' : ''} ORDER BY i.issued_at DESC, i.number DESC LIMIT 500`,
    args: schoolId ? [schoolId] : [],
  });
  const unpaid = await db.execute(`SELECT i.school_id, s.display_name AS school_name, COUNT(*) AS invoices, SUM(i.total_paise) AS total_paise
    FROM invoices i JOIN schools s ON s.id = i.school_id
    WHERE i.status = 'issued' AND i.paid_on IS NULL GROUP BY i.school_id ORDER BY s.display_name COLLATE NOCASE`);
  return {
    invoices: invoices.rows.map(presentInvoice),
    unpaid: unpaid.rows.map((row) => ({ schoolId: row.school_id, school: row.school_name, invoices: Number(row.invoices), totalPaise: Number(row.total_paise) })),
  };
}

async function requireChanged(db, result, invoiceId, explain) {
  if (Number(result.rowsAffected || 0) > 0) return getInvoice(db, invoiceId);
  const current = await getInvoice(db, invoiceId); // 404 when it doesn't exist
  return fail(409, explain(current), 'invalid_state');
}

/** Void an issued, unpaid invoice; its papers become billable again. */
export async function voidInvoice(db, { invoiceId, reason, voidedBy, now = new Date() }) {
  const why = String(reason || '').trim();
  if (!why) fail(400, 'A reason is required to void an invoice.', 'reason_required');
  const at = new Date(now).toISOString();
  const [result] = await db.batch([
    { sql: "UPDATE invoices SET status = 'void', voided_by = ?, voided_at = ?, void_reason = ? WHERE id = ? AND status = 'issued' AND paid_on IS NULL", args: [voidedBy, at, why.slice(0, 500), invoiceId] },
    { sql: "UPDATE invoice_papers SET released_at = ? WHERE invoice_id = ? AND released_at IS NULL AND EXISTS (SELECT 1 FROM invoices WHERE id = ? AND status = 'void' AND voided_at = ?)", args: [at, invoiceId, invoiceId, at] },
  ], 'write');
  return requireChanged(db, result, invoiceId, (current) => (current.status === 'void' ? 'This invoice is already void.' : 'A paid invoice can\'t be voided. Remove the paid mark first.'));
}

export async function markInvoicePaid(db, { invoiceId, paidOn, reference, markedBy, now = new Date() }) {
  const date = String(paidOn || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) fail(400, 'paidOn must be a date (YYYY-MM-DD).', 'bad_date');
  if (date > istDate(now)) fail(400, 'The paid date can\'t be in the future.', 'bad_date');
  const ref = String(reference || '').trim().slice(0, 100) || null;
  const result = await db.execute({
    sql: "UPDATE invoices SET paid_on = ?, paid_reference = ?, paid_marked_by = ?, paid_marked_at = ? WHERE id = ? AND status = 'issued' AND paid_on IS NULL",
    args: [date, ref, markedBy, new Date(now).toISOString(), invoiceId],
  });
  return requireChanged(db, result, invoiceId, (current) => (current.status === 'void' ? 'A void invoice can\'t be marked paid.' : 'This invoice is already marked paid.'));
}

export async function unmarkInvoicePaid(db, { invoiceId }) {
  const result = await db.execute({
    sql: 'UPDATE invoices SET paid_on = NULL, paid_reference = NULL, paid_marked_by = NULL, paid_marked_at = NULL WHERE id = ? AND paid_on IS NOT NULL',
    args: [invoiceId],
  });
  return requireChanged(db, result, invoiceId, () => 'This invoice is not marked paid.');
}
