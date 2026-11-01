// Payments, receipts and allocations (CRM-017/018, CRM M2 phase 1 S3, D5/D6).
//
// The ledger is append-only. A payment is allocated to the student's invoices
// (oldest due first unless staff choose); what is left is credit. A mistake is
// reversed with a reason, which releases the payment's allocations. Every
// write is one batch, and the triggers from migration 083 re-check balances
// inside it, so two people recording payments at once can't over-allocate.
// Audit summaries never carry the reference or the internal note.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  PAYMENT_METHODS, financialYear, moveAllocationBody, oldestFirst, paymentsQuery, recordPaymentBody, reversePaymentBody,
} from '../../shared/crm/fees.js';
import { addDays } from '../../shared/crm/time.js';
import { auditStatement } from './audit.js';
import { CrmHttpError, crmErrors } from './errors.js';
import { feeSettings } from './feePlans.js';
import {
  INVOICE_SELECT, linesFor, loadStudent, payerName, serializeInvoice, summarize, today,
} from './invoices.js';
import { idempotencyKey } from './idempotency.js';
import { PAID_SQL, allocationStatement, counterStatement, ledgerBatch } from './ledger.js';
import { can } from './permissions.js';

export { moveAllocationBody, paymentsQuery, recordPaymentBody, reversePaymentBody };
export const studentFeesQuery = z.object({ studentId: z.string().trim().min(1).max(128) });

export const PAYMENT_SELECT = `
  SELECT p.*, s.display_name AS student_name, r.reason AS reversal_reason, r.created_at AS reversed_at
  FROM crm_payments p
  LEFT JOIN students s ON s.id = p.student_id AND s.school_id = p.school_id
  LEFT JOIN crm_payments r ON r.school_id = p.school_id AND r.reverses_payment_id = p.id`;

/** Net allocations per payment: `{ paymentId: [{ invoiceId, invoiceNumber, amountPaise }] }`. */
export async function allocationsFor(db, scope, paymentIds) {
  if (!paymentIds.length) return {};
  const result = await db.execute({
    sql: `SELECT a.payment_id, a.invoice_id, i.number, i.due_date, SUM(a.amount_paise) AS net
          FROM crm_payment_allocations a JOIN crm_invoices i ON i.id = a.invoice_id AND i.school_id = a.school_id
          WHERE a.school_id = ? AND a.payment_id IN (${paymentIds.map(() => '?').join(', ')})
          GROUP BY a.payment_id, a.invoice_id HAVING SUM(a.amount_paise) > 0
          ORDER BY i.due_date, i.seq`,
    args: [scope.schoolId, ...paymentIds],
  });
  const byPayment = {};
  for (const row of result.rows) (byPayment[row.payment_id] ||= []).push({ invoiceId: row.invoice_id, invoiceNumber: row.number, amountPaise: Number(row.net) });
  return byPayment;
}

export function serializePayment(row, allocations = []) {
  const amountPaise = Number(row.amount_paise);
  const allocatedPaise = allocations.reduce((sum, item) => sum + item.amountPaise, 0);
  return {
    id: row.id,
    receiptNumber: row.receipt_number,
    student: { id: row.student_id, name: row.student_name || null },
    amountPaise,
    receivedOn: row.received_on,
    method: row.method,
    reference: row.reference || null,
    payerName: row.payer_name || null,
    note: row.note || null,
    recordedAt: row.created_at,
    allocations,
    // A reversed payment's allocations are released, so it leaves no credit.
    unallocatedPaise: row.reversal_reason ? 0 : amountPaise - allocatedPaise,
    reversal: row.reversal_reason ? { reason: row.reversal_reason, at: row.reversed_at } : null,
  };
}

export async function loadPayment(db, scope, paymentId) {
  const result = await db.execute({ sql: `${PAYMENT_SELECT} WHERE p.id = ? AND p.school_id = ? AND p.kind = 'payment'`, args: [paymentId, scope.schoolId] });
  const row = result.rows[0];
  if (!row) throw crmErrors.notFound();
  return serializePayment(row, (await allocationsFor(db, scope, [row.id]))[row.id] || []);
}

async function openInvoices(db, scope, studentId) {
  const result = await db.execute({
    sql: `${INVOICE_SELECT} WHERE i.school_id = ? AND i.student_id = ? AND i.status = 'issued' ORDER BY i.due_date, i.seq`,
    args: [scope.schoolId, studentId],
  });
  const now = today(scope);
  return result.rows.map((row) => serializeInvoice(row, null, now)).filter((invoice) => invoice.balancePaise > 0);
}

/** The payment an earlier request with this Idempotency-Key recorded, if any. */
async function paymentForRequest(db, scope, key) {
  if (!key) return null;
  const found = await db.execute({
    sql: 'SELECT payment_id FROM crm_payment_requests WHERE school_id = ? AND user_id = ? AND request_key = ?',
    args: [scope.schoolId, scope.actor.user_id || '', key],
  });
  return found.rows[0] ? loadPayment(db, scope, found.rows[0].payment_id) : null;
}

export async function recordPayment({ db, scope, input, req }) {
  const body = input.body;
  // A retried or doubled request returns the payment already recorded (and
  // its receipt number) instead of recording the money twice.
  const key = idempotencyKey(req);
  const earlier = await paymentForRequest(db, scope, key);
  if (earlier) return earlier;
  const student = await loadStudent(db, scope, body.studentId);
  const now = today(scope);
  if (body.receivedOn > now) throw crmErrors.validation([{ path: 'receivedOn', message: 'The date received can\'t be in the future' }]);
  const open = await openInvoices(db, scope, student.id);
  const allocations = body.allocations ?? oldestFirst(open, body.amountPaise);
  const byId = new Map(open.map((invoice) => [invoice.id, invoice]));
  const invalid = allocations.find((item) => !byId.has(item.invoiceId) || item.amountPaise > byId.get(item.invoiceId).balancePaise);
  if (invalid) {
    throw new CrmHttpError(409, 'balance_changed', byId.has(invalid.invoiceId)
      ? 'That is more than the invoice still owes. Balances may have changed; reload and try again.'
      : 'Payments can only go to this student\'s unpaid invoices');
  }
  const [settings, payer] = await Promise.all([feeSettings(db, scope), body.payerName ? body.payerName : payerName(db, scope, student.id)]);
  const paymentId = `pay_${randomUUID()}`;
  const fy = financialYear(now);
  const stamp = new Date().toISOString();
  const allocatedPaise = allocations.reduce((sum, item) => sum + item.amountPaise, 0);
  const claim = key
    ? [{
      sql: 'INSERT INTO crm_payment_requests (school_id, user_id, request_key, payment_id, created_at) VALUES (?, ?, ?, ?, ?)',
      args: [scope.schoolId, scope.actor.user_id || '', key, paymentId, stamp],
    }]
    : [];
  const statements = [
    ...claim,
    counterStatement(scope, 'receipt', fy, stamp),
    {
      sql: `INSERT INTO crm_payments (id, school_id, student_id, kind, amount_paise, received_on, method, reference, payer_name, note, receipt_number, fy, seq, created_by, created_at)
            SELECT ?, ?, ?, 'payment', ?, ?, ?, ?, ?, ?, ? || printf('%04d', c.last_seq), c.fy, c.last_seq, ?, ?
            FROM crm_doc_counters c WHERE c.school_id = ? AND c.kind = 'receipt' AND c.fy = ?`,
      args: [
        paymentId, scope.schoolId, student.id, body.amountPaise, body.receivedOn, body.method, body.reference || null, payer || null, body.note || null,
        `${settings.prefix}/RCP/${fy}/`, scope.actor.user_id || null, stamp, scope.schoolId, fy,
      ],
    },
    ...allocations.map((item) => allocationStatement(scope, { paymentId, invoiceId: item.invoiceId, amountPaise: item.amountPaise, now: stamp })),
    auditStatement(scope, {
      action: 'payment.changed', entityId: paymentId, now: stamp,
      summary: { change: 'recorded', receiptNumber: '', amountPaise: body.amountPaise, method: body.method, allocatedPaise },
      computed: { key: 'receiptNumber', sql: '(SELECT receipt_number FROM crm_payments WHERE id = ? AND school_id = ?)', args: [paymentId, scope.schoolId] },
    }),
  ];
  try {
    await ledgerBatch(db, statements);
  } catch (error) {
    // The same key won a race in another request: return that payment.
    if (key && /UNIQUE constraint failed: crm_payment_requests/i.test(String(error?.message || error?.cause?.message || ''))) {
      const winner = await paymentForRequest(db, scope, key);
      if (winner) return winner;
    }
    throw error;
  }
  return loadPayment(db, scope, paymentId);
}

/** D5: a reversal entry (reason) that releases everything the payment paid. */
export async function reversePayment({ db, scope, input }) {
  const { paymentId, reason } = input.body;
  const payment = await loadPayment(db, scope, paymentId);
  if (payment.reversal) throw new CrmHttpError(422, 'already_reversed', 'This payment has already been reversed');
  const stamp = new Date().toISOString();
  await ledgerBatch(db, [
    {
      sql: `INSERT INTO crm_payments (id, school_id, student_id, kind, reverses_payment_id, amount_paise, received_on, method, reason, created_by, created_at)
            VALUES (?, ?, ?, 'reversal', ?, ?, ?, ?, ?, ?, ?)`,
      args: [`rev_${randomUUID()}`, scope.schoolId, payment.student.id, payment.id, payment.amountPaise, today(scope), payment.method, reason, scope.actor.user_id || null, stamp],
    },
    // Releases are computed in SQL so an allocation moved meanwhile is still released exactly.
    {
      sql: `INSERT INTO crm_payment_allocations (id, school_id, payment_id, invoice_id, amount_paise, reason, created_by, created_at)
            SELECT 'alloc_' || lower(hex(randomblob(16))), school_id, payment_id, invoice_id, -SUM(amount_paise), ?, ?, ?
            FROM crm_payment_allocations WHERE school_id = ? AND payment_id = ?
            GROUP BY invoice_id HAVING SUM(amount_paise) > 0`,
      args: ['Payment reversed', scope.actor.user_id || null, stamp, scope.schoolId, payment.id],
    },
    auditStatement(scope, {
      action: 'payment.changed', entityId: payment.id, now: stamp,
      summary: { change: 'reversed', receiptNumber: payment.receiptNumber, amountPaise: payment.amountPaise, method: payment.method, reason },
    }),
  ]);
  return loadPayment(db, scope, payment.id);
}

/** D5: moving money is a release plus an allocation, with a reason. */
export async function moveAllocation({ db, scope, input }) {
  const body = input.body;
  const payment = await loadPayment(db, scope, body.paymentId);
  if (payment.reversal) throw new CrmHttpError(422, 'payment_reversed', 'This payment has been reversed');
  const stamp = new Date().toISOString();
  const statements = [];
  if (body.fromInvoiceId) statements.push(allocationStatement(scope, { paymentId: payment.id, invoiceId: body.fromInvoiceId, amountPaise: -body.amountPaise, reason: body.reason, now: stamp }));
  if (body.toInvoiceId) statements.push(allocationStatement(scope, { paymentId: payment.id, invoiceId: body.toInvoiceId, amountPaise: body.amountPaise, reason: body.reason, now: stamp }));
  const change = body.fromInvoiceId && body.toInvoiceId ? 'moved' : body.toInvoiceId ? 'allocated' : 'released';
  statements.push(auditStatement(scope, {
    action: 'allocation.changed', entityId: payment.id, now: stamp,
    summary: {
      change, amountPaise: body.amountPaise, reason: body.reason,
      ...(body.fromInvoiceId ? { fromInvoiceId: body.fromInvoiceId } : {}), ...(body.toInvoiceId ? { toInvoiceId: body.toInvoiceId } : {}),
    },
  }));
  await ledgerBatch(db, statements);
  return loadPayment(db, scope, payment.id);
}

/** Fees → Payments (D8): payments by date received, with totals by method; reversed ones excluded from totals. */
export async function listPayments({ db, scope, input }) {
  const now = today(scope);
  const to = input.query.to || now;
  const from = input.query.from || addDays(to, -30);
  if (from > to) throw crmErrors.validation([{ path: 'from', message: 'The start date must be on or before the end date' }]);
  const clauses = ["p.school_id = ?", "p.kind = 'payment'", 'p.received_on >= ?', 'p.received_on <= ?'];
  const args = [scope.schoolId, from, to];
  if (input.query.method) { clauses.push('p.method = ?'); args.push(input.query.method); }
  const notReversed = 'NOT EXISTS (SELECT 1 FROM crm_payments r WHERE r.school_id = p.school_id AND r.reverses_payment_id = p.id)';
  const byMethodSql = (where) => `SELECT p.method, SUM(p.amount_paise) AS total, COUNT(*) AS n FROM crm_payments p WHERE ${where} AND ${notReversed} GROUP BY p.method`;
  const [rows, range, todays] = await Promise.all([
    db.execute({ sql: `${PAYMENT_SELECT} WHERE ${clauses.join(' AND ')} ORDER BY p.received_on DESC, p.created_at DESC LIMIT 501`, args }),
    db.execute({ sql: byMethodSql(clauses.join(' AND ')), args }),
    db.execute({ sql: byMethodSql("p.school_id = ? AND p.kind = 'payment' AND p.received_on = ?"), args: [scope.schoolId, now] }),
  ]);
  const page = rows.rows.slice(0, 500);
  const allocations = await allocationsFor(db, scope, page.map((row) => row.id));
  // Totals come from SQL over the whole range, not from the (capped) list.
  const totalsOf = (result) => ({
    totalPaise: result.rows.reduce((sum, row) => sum + Number(row.total), 0),
    count: result.rows.reduce((sum, row) => sum + Number(row.n), 0),
    byMethod: Object.fromEntries(PAYMENT_METHODS.map((method) => [method, Number(result.rows.find((row) => row.method === method)?.total || 0)])),
  });
  return {
    from, to, today: now, items: page.map((row) => serializePayment(row, allocations[row.id] || [])), truncated: rows.rows.length > 500,
    totals: totalsOf(range), todayTotals: totalsOf(todays),
  };
}

/**
 * D9: other students who share a guardian with this one and owe fees, so the
 * front desk can mention them. Guardian names are contact data, so this needs
 * crm.contacts.read as well.
 */
async function siblingDues(db, scope, studentId) {
  if (!can(scope, 'crm.contacts.read')) return [];
  const result = await db.execute({
    sql: `SELECT s.id, s.display_name, MIN(c.full_name) AS guardian_name,
                 (SELECT COALESCE(SUM(i.total_paise - ${PAID_SQL}), 0) FROM crm_invoices i
                  WHERE i.school_id = s.school_id AND i.student_id = s.id AND i.status = 'issued') AS due
          FROM crm_guardian_links mine
          JOIN crm_guardian_links theirs ON theirs.school_id = mine.school_id AND theirs.contact_id = mine.contact_id
                                        AND theirs.student_id <> mine.student_id AND theirs.status = 'active'
          JOIN crm_contacts c ON c.id = mine.contact_id AND c.school_id = mine.school_id AND c.anonymised_at IS NULL
          JOIN students s ON s.id = theirs.student_id AND s.school_id = mine.school_id
          WHERE mine.school_id = ? AND mine.student_id = ? AND mine.status = 'active'
          GROUP BY s.id ORDER BY s.display_name COLLATE NOCASE`,
    args: [scope.schoolId, studentId],
  });
  return result.rows.filter((row) => Number(row.due) > 0)
    .map((row) => ({ studentId: row.id, name: row.display_name, guardianName: row.guardian_name || null, balancePaise: Number(row.due) }));
}

/** The student profile's Fees card: invoices, payments, balance and credit. */
export async function studentFees({ db, scope, input }) {
  const student = await loadStudent(db, scope, input.query.studentId);
  const [rows, payer, courses, payments, siblings] = await Promise.all([
    db.execute({ sql: `${INVOICE_SELECT} WHERE i.school_id = ? AND i.student_id = ? ORDER BY i.due_date, i.seq`, args: [scope.schoolId, student.id] }),
    payerName(db, scope, student.id),
    db.execute({
      sql: `SELECT DISTINCT bs.course_id FROM batch_memberships m JOIN batches b ON b.id = m.batch_id AND b.school_id = ?
            JOIN crm_batch_settings bs ON bs.batch_id = b.id AND bs.school_id = b.school_id
            WHERE m.student_id = ? AND m.status = 'active' AND bs.course_id IS NOT NULL`,
      args: [scope.schoolId, student.id],
    }),
    db.execute({ sql: `${PAYMENT_SELECT} WHERE p.school_id = ? AND p.student_id = ? AND p.kind = 'payment' ORDER BY p.received_on DESC, p.created_at DESC`, args: [scope.schoolId, student.id] }),
    siblingDues(db, scope, student.id),
  ]);
  const [lines, allocations] = await Promise.all([
    linesFor(db, scope, rows.rows.map((row) => row.id)),
    allocationsFor(db, scope, payments.rows.map((row) => row.id)),
  ]);
  const now = today(scope);
  const invoices = rows.rows.map((row) => serializeInvoice(row, lines[row.id] || [], now));
  const paymentItems = payments.rows.map((row) => serializePayment(row, allocations[row.id] || []));
  const creditPaise = paymentItems.reduce((sum, payment) => sum + payment.unallocatedPaise, 0);
  return {
    student, billedTo: payer, today: now, summary: summarize(invoices, creditPaise), invoices, payments: paymentItems, courseIds: courses.rows.map((row) => row.course_id), siblings,
  };
}
