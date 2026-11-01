// Invoices and dues (CRM-017/018, CRM M2 phase 1 S2, D2/D4/D6/D9).
//
// One invoice per due date. Only `issued` or `void` is stored; unpaid, partly
// paid, paid and overdue are computed. Issued invoices are never edited: a
// correction voids and re-issues in one batch. Numbers are gapless per school
// and financial year: the counter bump and the insert share one `db.batch`
// (a transaction), and the number is read back from the counter in SQL, so
// two concurrent applies can never take the same number or leave a gap.
import { randomUUID } from 'node:crypto';
import {
  applyBody, correctInvoiceBody, duesQuery, financialYear, invoiceState, linesTotal, manualInvoiceBody, previewQuery, schedulePreview,
  stopFutureBody, voidInvoiceBody,
} from '../../shared/crm/fees.js';
import { addDays, localDate } from '../../shared/crm/time.js';
import { auditStatement } from './audit.js';
import { CrmHttpError, crmErrors } from './errors.js';
import { feeSettings, loadPlan } from './feePlans.js';
import { PAID_SQL, counterStatement, creditStatements, ledgerBatch } from './ledger.js';

export { applyBody, correctInvoiceBody, duesQuery, manualInvoiceBody, previewQuery, stopFutureBody, voidInvoiceBody };

const newId = (prefix) => `${prefix}_${randomUUID()}`;
export const today = (scope) => localDate(Date.now(), scope.timezone);

// ------------------------------------------------------------- reading --

export async function loadStudent(db, scope, studentId) {
  const result = await db.execute({ sql: 'SELECT id, display_name, status FROM students WHERE id = ? AND school_id = ?', args: [studentId, scope.schoolId] });
  if (!result.rows[0]) throw crmErrors.notFound();
  return { id: result.rows[0].id, name: result.rows[0].display_name, status: result.rows[0].status };
}

function requireActive(student) {
  if (student.status !== 'active') throw new CrmHttpError(422, 'student_inactive', 'Fees can only be added for active students');
}

/** The student's fee payer, or else their primary guardian (D9). */
export async function payerName(db, scope, studentId) {
  const result = await db.execute({
    sql: `SELECT c.full_name FROM crm_guardian_links g
          JOIN crm_contacts c ON c.id = g.contact_id AND c.school_id = g.school_id AND c.anonymised_at IS NULL
          WHERE g.school_id = ? AND g.student_id = ? AND g.status = 'active' AND (g.is_fee_payer = 1 OR g.is_primary = 1)
          ORDER BY g.is_fee_payer DESC, g.is_primary DESC, g.created_at LIMIT 1`,
    args: [scope.schoolId, studentId],
  });
  return result.rows[0]?.full_name || null;
}

/** Names and the school header as they are now; frozen onto each invoice (D6). */
async function billTo(db, scope, student) {
  const [payer, settings] = await Promise.all([payerName(db, scope, student.id), feeSettings(db, scope)]);
  return {
    prefix: settings.prefix,
    json: {
      student: { id: student.id, name: student.name },
      payer: payer ? { name: payer } : null,
      school: { name: settings.headerName, address: settings.headerAddress, phone: settings.headerPhone, gstin: settings.headerGstin, footer: settings.footerNote },
    },
  };
}

export function serializeInvoice(row, lines, now) {
  const totalPaise = Number(row.total_paise);
  const paidPaise = Number(row.paid_paise || 0);
  const billed = JSON.parse(row.bill_to_json);
  return {
    id: row.id,
    number: row.number,
    student: { id: row.student_id, name: row.student_name || billed.student?.name || null },
    billedTo: billed.payer?.name || null,
    plan: row.plan_id ? { id: row.plan_id, name: row.plan_name || null } : null,
    status: row.status,
    issueDate: row.issue_date,
    dueDate: row.due_date,
    totalPaise,
    paidPaise,
    ...invoiceState({ status: row.status, totalPaise, paidPaise, dueDate: row.due_date }, now),
    lines: lines?.map((line) => ({ label: line.label, amountPaise: Number(line.amount_paise) })),
    voidReason: row.void_reason || null,
    voidedAt: row.voided_at || null,
    replacesInvoiceId: row.replaces_invoice_id || null,
  };
}

export const INVOICE_SELECT = `
  SELECT i.*, ${PAID_SQL} AS paid_paise, p.name AS plan_name, s.display_name AS student_name
  FROM crm_invoices i
  LEFT JOIN crm_fee_plans p ON p.id = i.plan_id AND p.school_id = i.school_id
  LEFT JOIN students s ON s.id = i.student_id AND s.school_id = i.school_id`;

export async function linesFor(db, scope, invoiceIds) {
  if (!invoiceIds.length) return {};
  const result = await db.execute({
    sql: `SELECT invoice_id, label, amount_paise FROM crm_invoice_lines WHERE school_id = ? AND invoice_id IN (${invoiceIds.map(() => '?').join(', ')}) ORDER BY invoice_id, position`,
    args: [scope.schoolId, ...invoiceIds],
  });
  const byInvoice = {};
  for (const row of result.rows) (byInvoice[row.invoice_id] ||= []).push(row);
  return byInvoice;
}

async function loadInvoiceRow(db, scope, invoiceId) {
  const result = await db.execute({ sql: `${INVOICE_SELECT} WHERE i.id = ? AND i.school_id = ?`, args: [invoiceId, scope.schoolId] });
  if (!result.rows[0]) throw crmErrors.notFound();
  return result.rows[0];
}

export async function loadInvoice(db, scope, invoiceId) {
  const row = await loadInvoiceRow(db, scope, invoiceId);
  return serializeInvoice(row, (await linesFor(db, scope, [row.id]))[row.id] || [], today(scope));
}

// ------------------------------------------------------------- issuing --

/**
 * Statements that issue one invoice: bump the counter, insert the invoice
 * numbered from the counter, its lines and an audit event. With `guard`, the
 * counter is bumped (and so everything else happens) only if the guard holds.
 */
function issueStatements(scope, { invoiceId, student, planId = null, issueDate, dueDate, lines, bill, replacesInvoiceId = null, change = 'issued', guard = null, now }) {
  const fy = financialYear(issueDate);
  const total = linesTotal(lines);
  const exists = { sql: 'EXISTS (SELECT 1 FROM crm_invoices WHERE id = ? AND school_id = ?)', args: [invoiceId, scope.schoolId] };
  return [
    counterStatement(scope, 'invoice', fy, now, guard),
    {
      sql: `INSERT INTO crm_invoices (id, school_id, student_id, plan_id, number, fy, seq, status, issue_date, due_date, total_paise, bill_to_json,
                                      replaces_invoice_id, created_by, created_at, updated_at)
            SELECT ?, ?, ?, ?, ? || printf('%04d', c.last_seq), c.fy, c.last_seq, 'issued', ?, ?, ?, ?, ?, ?, ?, ?
            FROM crm_doc_counters c WHERE c.school_id = ? AND c.kind = 'invoice' AND c.fy = ?${guard ? ` AND ${guard.sql}` : ''}`,
      args: [
        invoiceId, scope.schoolId, student.id, planId, `${bill.prefix}/INV/${fy}/`, issueDate, dueDate, total, JSON.stringify(bill.json),
        replacesInvoiceId, scope.actor.user_id || null, now, now, scope.schoolId, fy, ...(guard ? guard.args : []),
      ],
    },
    ...lines.map((line, position) => ({
      sql: `INSERT INTO crm_invoice_lines (id, school_id, invoice_id, position, label, amount_paise, created_at, updated_at)
            SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${exists.sql}`,
      args: [newId('invl'), scope.schoolId, invoiceId, position, line.label, line.amountPaise, now, now, ...exists.args],
    })),
    // The number isn't known until the batch runs, so the audit row reads it.
    auditStatement(scope, {
      action: 'invoice.changed', entityId: invoiceId, now, when: exists,
      summary: { change, number: '', amountPaise: total, ...(replacesInvoiceId ? { replacesInvoiceId } : {}) },
      computed: { key: 'number', sql: '(SELECT number FROM crm_invoices WHERE id = ? AND school_id = ?)', args: [invoiceId, scope.schoolId] },
    }),
  ];
}

/**
 * Issues invoices with any credit applied to them (D5) in one batch. If a
 * concurrent payment moved the credit meanwhile, the batch aborts as a whole
 * (no number is used) and is retried once with fresh credit.
 */
async function issueWithCredit(db, scope, studentId, statements, invoices, now, guard = null) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await ledgerBatch(db, [...statements, ...(await creditStatements(db, scope, studentId, invoices, now, guard))]);
    } catch (error) {
      if (attempt > 0 || !['balance_changed', 'payment_reversed'].includes(error.code)) throw error;
    }
  }
}

async function issued(db, scope, ids) {
  if (!ids.length) return [];
  const result = await db.execute({ sql: `${INVOICE_SELECT} WHERE i.school_id = ? AND i.id IN (${ids.map(() => '?').join(', ')}) ORDER BY i.due_date, i.seq`, args: [scope.schoolId, ...ids] });
  const lines = await linesFor(db, scope, ids);
  const now = today(scope);
  return result.rows.map((row) => serializeInvoice(row, lines[row.id] || [], now));
}

/**
 * Where a plan's due dates count from (D3): the batch the student just joined
 * if given (its start, else today), otherwise their batch for the plan's
 * course or latest batch start, else today.
 */
async function defaultStart(db, scope, studentId, plan, batchId) {
  if (batchId) {
    const joined = await db.execute({
      sql: `SELECT b.name, bs.starts_on FROM batch_memberships m
            JOIN batches b ON b.id = m.batch_id AND b.school_id = ?
            LEFT JOIN crm_batch_settings bs ON bs.batch_id = b.id AND bs.school_id = b.school_id
            WHERE m.batch_id = ? AND m.student_id = ? AND m.status = 'active'`,
      args: [scope.schoolId, batchId, studentId],
    });
    const batch = joined.rows[0];
    if (batch?.starts_on) return { startDate: batch.starts_on, startSource: 'batch', batchName: batch.name };
    if (batch) return { startDate: today(scope), startSource: 'today', batchName: null };
  }
  const result = await db.execute({
    sql: `SELECT b.name, bs.starts_on, bs.course_id FROM batch_memberships m
          JOIN batches b ON b.id = m.batch_id AND b.school_id = ?
          JOIN crm_batch_settings bs ON bs.batch_id = b.id AND bs.school_id = b.school_id
          WHERE m.student_id = ? AND m.status = 'active' AND bs.starts_on IS NOT NULL
          ORDER BY (bs.course_id IS NOT NULL AND bs.course_id = ?) DESC, bs.starts_on DESC LIMIT 1`,
    args: [scope.schoolId, studentId, plan.course?.id || null],
  });
  const batch = result.rows[0];
  return batch ? { startDate: batch.starts_on, startSource: 'batch', batchName: batch.name } : { startDate: today(scope), startSource: 'today', batchName: null };
}

export async function previewFees({ db, scope, input }) {
  const { studentId, planId, startDate, batchId } = input.query;
  const student = await loadStudent(db, scope, studentId);
  const plan = await loadPlan(db, scope, planId);
  const start = startDate ? { startDate, startSource: 'chosen', batchName: null } : await defaultStart(db, scope, student.id, plan, batchId);
  const [payer, existing] = await Promise.all([
    payerName(db, scope, student.id),
    db.execute({ sql: "SELECT COUNT(*) AS n FROM crm_invoices WHERE school_id = ? AND student_id = ? AND plan_id = ? AND status = 'issued'", args: [scope.schoolId, student.id, plan.id] }),
  ]);
  return {
    student,
    plan: { id: plan.id, name: plan.name, status: plan.status },
    ...start,
    billedTo: payer,
    alreadyFromPlan: Number(existing.rows[0].n),
    invoices: schedulePreview(plan, start.startDate),
  };
}

export async function applyFees({ db, scope, input }) {
  const body = input.body;
  const student = await loadStudent(db, scope, body.studentId);
  requireActive(student);
  const plan = await loadPlan(db, scope, body.planId);
  if (plan.status !== 'active') throw new CrmHttpError(422, 'plan_archived', 'This fee plan is archived; restore it or choose another');
  const bill = await billTo(db, scope, student);
  const issueDate = today(scope);
  const now = new Date().toISOString();
  const ids = body.invoices.map(() => newId('inv'));
  const statements = body.invoices.flatMap((invoice, index) => issueStatements(scope, {
    invoiceId: ids[index], student, planId: plan.id, issueDate, dueDate: invoice.dueDate, lines: invoice.lines, bill, now,
  }));
  await issueWithCredit(db, scope, student.id, statements, body.invoices.map((invoice, index) => ({ id: ids[index], dueDate: invoice.dueDate, totalPaise: linesTotal(invoice.lines) })), now);
  return { items: await issued(db, scope, ids) };
}

export async function createInvoice({ db, scope, input }) {
  const body = input.body;
  const student = await loadStudent(db, scope, body.studentId);
  requireActive(student);
  const bill = await billTo(db, scope, student);
  const invoiceId = newId('inv');
  const now = new Date().toISOString();
  const statements = issueStatements(scope, { invoiceId, student, issueDate: today(scope), dueDate: body.dueDate, lines: body.lines, bill, now });
  await issueWithCredit(db, scope, student.id, statements, [{ id: invoiceId, dueDate: body.dueDate, totalPaise: linesTotal(body.lines) }], now);
  return loadInvoice(db, scope, invoiceId);
}

// ------------------------------------------------------------- voiding --

/** Statements that void one issued invoice; a trigger refuses it while payments are allocated (D4). */
function voidStatements(scope, invoice, reason, now) {
  return [
    {
      sql: `UPDATE crm_invoices SET status = 'void', void_reason = ?, voided_by = ?, voided_at = ?, updated_at = ?
            WHERE id = ? AND school_id = ? AND status = 'issued'`,
      args: [reason, scope.actor.user_id || null, now, now, invoice.id, scope.schoolId],
    },
    auditStatement(scope, {
      action: 'invoice.changed', entityId: invoice.id, onlyIfChanged: true, now,
      summary: { change: 'voided', number: invoice.number, amountPaise: Number(invoice.total_paise), reason },
    }),
  ];
}

function assertIssued(row) {
  if (row.status !== 'issued') throw new CrmHttpError(422, 'invalid_transition', 'This invoice is already void');
}

export async function voidInvoice({ db, scope, input }) {
  const { invoiceId, reason } = input.body;
  const row = await loadInvoiceRow(db, scope, invoiceId);
  assertIssued(row);
  const results = await ledgerBatch(db, voidStatements(scope, row, reason, new Date().toISOString()));
  if (!Number(results[0].rowsAffected)) throw new CrmHttpError(409, 'invalid_transition', 'This invoice changed meanwhile; reload and try again');
  return loadInvoice(db, scope, invoiceId);
}

/** Void and re-issue in one batch (D4): the new invoice exists only if the void happened. */
export async function correctInvoice({ db, scope, input }) {
  const body = input.body;
  const row = await loadInvoiceRow(db, scope, body.invoiceId);
  assertIssued(row);
  const student = { id: row.student_id, name: row.student_name || JSON.parse(row.bill_to_json).student?.name };
  const bill = await billTo(db, scope, student);
  const now = new Date().toISOString();
  const invoiceId = newId('inv');
  const guard = { sql: "EXISTS (SELECT 1 FROM crm_invoices WHERE id = ? AND school_id = ? AND status = 'void' AND voided_at = ?)", args: [row.id, scope.schoolId, now] };
  const results = await issueWithCredit(db, scope, student.id, [
    ...voidStatements(scope, row, body.reason, now),
    ...issueStatements(scope, {
      invoiceId, student, planId: row.plan_id || null, issueDate: today(scope), dueDate: body.dueDate, lines: body.lines, bill,
      replacesInvoiceId: row.id, change: 'corrected', guard, now,
    }),
  ], [{ id: invoiceId, dueDate: body.dueDate, totalPaise: linesTotal(body.lines) }], now, guard);
  if (!Number(results[0].rowsAffected)) throw new CrmHttpError(409, 'invalid_transition', 'This invoice changed meanwhile; reload and try again');
  return loadInvoice(db, scope, invoiceId);
}

/** Voids the student's unpaid invoices due on or after `fromDate` (D4, D9). */
export async function stopFutureFees({ db, scope, input }) {
  const { studentId, fromDate, reason } = input.body;
  const student = await loadStudent(db, scope, studentId);
  const result = await db.execute({
    sql: `SELECT i.*, ${PAID_SQL} AS paid_paise FROM crm_invoices i WHERE i.school_id = ? AND i.student_id = ? AND i.status = 'issued' AND i.due_date >= ? ORDER BY i.due_date`,
    args: [scope.schoolId, student.id, fromDate],
  });
  const unpaid = result.rows.filter((row) => Number(row.paid_paise) === 0);
  if (unpaid.length) {
    const now = new Date().toISOString();
    await ledgerBatch(db, unpaid.flatMap((row) => voidStatements(scope, row, reason, now)));
  }
  return { voided: unpaid.length, skipped: result.rows.length - unpaid.length };
}

// ------------------------------------------------------------- views --

export function summarize(invoices, creditPaise = 0) {
  const open = invoices.filter((invoice) => invoice.status === 'issued');
  const next = open.filter((invoice) => invoice.balancePaise > 0).sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1))[0];
  return {
    balancePaise: open.reduce((sum, invoice) => sum + invoice.balancePaise, 0),
    overduePaise: open.filter((invoice) => invoice.overdue).reduce((sum, invoice) => sum + invoice.balancePaise, 0),
    paidPaise: open.reduce((sum, invoice) => sum + invoice.paidPaise, 0),
    creditPaise,
    nextDue: next ? { dueDate: next.dueDate, amountPaise: next.balancePaise } : null,
  };
}

const DUES_LIMIT = 500;

/** Fees → Dues (D8): unpaid and partly paid invoices across the school, with totals. */
export async function listDues({ db, scope, input }) {
  const { filter, batchId, courseId } = input.query;
  const now = today(scope);
  const clauses = ['i.school_id = ?', "i.status = 'issued'", `i.total_paise > ${PAID_SQL}`];
  const args = [scope.schoolId];
  if (batchId) {
    clauses.push(`EXISTS (SELECT 1 FROM batch_memberships m JOIN batches b ON b.id = m.batch_id AND b.school_id = i.school_id
                          WHERE m.student_id = i.student_id AND m.batch_id = ? AND m.status = 'active')`);
    args.push(batchId);
  }
  if (courseId) {
    clauses.push(`(p.course_id = ? OR EXISTS (SELECT 1 FROM batch_memberships m JOIN crm_batch_settings bs ON bs.batch_id = m.batch_id AND bs.school_id = i.school_id
                                              WHERE m.student_id = i.student_id AND m.status = 'active' AND bs.course_id = ?))`);
    args.push(courseId, courseId);
  }
  const scoped = clauses.join(' AND ');
  const window = filter === 'overdue' ? ' AND i.due_date < ?' : filter === 'week' ? ' AND i.due_date >= ? AND i.due_date <= ?' : '';
  const windowArgs = filter === 'overdue' ? [now] : filter === 'week' ? [now, addDays(now, 7)] : [];
  const [rows, totals] = await Promise.all([
    db.execute({ sql: `${INVOICE_SELECT} WHERE ${scoped}${window} ORDER BY i.due_date, s.display_name COLLATE NOCASE, i.seq LIMIT ${DUES_LIMIT + 1}`, args: [...args, ...windowArgs] }),
    db.execute({
      sql: `SELECT COALESCE(SUM(i.total_paise - ${PAID_SQL}), 0) AS outstanding,
                   COALESCE(SUM(CASE WHEN i.due_date < ? THEN i.total_paise - ${PAID_SQL} ELSE 0 END), 0) AS overdue,
                   COUNT(DISTINCT CASE WHEN i.due_date < ? THEN i.student_id END) AS overdue_students
            FROM crm_invoices i LEFT JOIN crm_fee_plans p ON p.id = i.plan_id AND p.school_id = i.school_id WHERE ${scoped}`,
      args: [now, now, ...args],
    }),
  ]);
  const items = rows.rows.slice(0, DUES_LIMIT).map((row) => serializeInvoice(row, null, now));
  return {
    today: now,
    items,
    truncated: rows.rows.length > DUES_LIMIT,
    totals: { outstandingPaise: Number(totals.rows[0].outstanding), overduePaise: Number(totals.rows[0].overdue), overdueStudents: Number(totals.rows[0].overdue_students) },
  };
}
