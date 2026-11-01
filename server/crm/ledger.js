// Fee ledger helpers shared by invoices and payments (CRM M2 phase 1, D4–D6).
// The rules themselves are database triggers (migration 083); this module
// builds the statements that respect them and turns their errors into
// messages staff can act on.
import { randomUUID } from 'node:crypto';
import { auditStatement } from './audit.js';
import { CrmHttpError } from './errors.js';

/** What has been paid towards invoice `i`: its net allocations. */
export const PAID_SQL = 'COALESCE((SELECT SUM(a.amount_paise) FROM crm_payment_allocations a WHERE a.school_id = i.school_id AND a.invoice_id = i.id), 0)';

/**
 * Bumps the gapless counter for `kind` (`invoice` | `receipt`) in `fy`. The
 * insert that follows reads `last_seq` back in the same batch. With `guard`,
 * the counter moves only if the guard holds.
 */
export function counterStatement(scope, kind, fy, now, guard = null) {
  const upsert = 'ON CONFLICT (school_id, kind, fy) DO UPDATE SET last_seq = last_seq + 1, updated_at = excluded.updated_at';
  const columns = 'INSERT INTO crm_doc_counters (school_id, kind, fy, last_seq, created_at, updated_at)';
  return guard
    ? { sql: `${columns} SELECT ?, ?, ?, 1, ?, ? WHERE ${guard.sql} ${upsert}`, args: [scope.schoolId, kind, fy, now, now, ...guard.args] }
    : { sql: `${columns} VALUES (?, ?, ?, 1, ?, ?) ${upsert}`, args: [scope.schoolId, kind, fy, now, now] };
}

/** One allocation row; with `guard`, written only if the guard holds. */
export function allocationStatement(scope, { paymentId, invoiceId, amountPaise, reason = null, now, guard = null }) {
  const values = [`alloc_${randomUUID()}`, scope.schoolId, paymentId, invoiceId, amountPaise, reason, scope.actor.user_id || null, now];
  const columns = 'INSERT INTO crm_payment_allocations (id, school_id, payment_id, invoice_id, amount_paise, reason, created_by, created_at)';
  return guard
    ? { sql: `${columns} SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql}`, args: [...values, ...guard.args] }
    : { sql: `${columns} VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, args: values };
}

/** The student's payments with money not yet allocated (their credit), oldest first. */
export async function unallocatedPayments(db, scope, studentId) {
  const result = await db.execute({
    sql: `SELECT p.id, p.amount_paise - COALESCE((SELECT SUM(a.amount_paise) FROM crm_payment_allocations a WHERE a.school_id = p.school_id AND a.payment_id = p.id), 0) AS free
          FROM crm_payments p
          WHERE p.school_id = ? AND p.student_id = ? AND p.kind = 'payment'
            AND NOT EXISTS (SELECT 1 FROM crm_payments r WHERE r.school_id = p.school_id AND r.reverses_payment_id = p.id)
          ORDER BY p.received_on, p.created_at`,
    args: [scope.schoolId, studentId],
  });
  return result.rows.map((row) => ({ id: row.id, freePaise: Number(row.free) })).filter((row) => row.freePaise > 0);
}

/**
 * D5: credit is applied automatically, oldest payment first, to invoices
 * just issued (in due-date order). `invoices` are `{ id, dueDate, totalPaise }`.
 */
export async function creditStatements(db, scope, studentId, invoices, now, guard = null) {
  const credit = await unallocatedPayments(db, scope, studentId);
  const statements = [];
  const targets = [...invoices].sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0)).map((invoice) => ({ ...invoice, left: invoice.totalPaise }));
  for (const payment of credit) {
    for (const invoice of targets) {
      if (payment.freePaise <= 0) break;
      const take = Math.min(payment.freePaise, invoice.left);
      if (take <= 0) continue;
      payment.freePaise -= take;
      invoice.left -= take;
      statements.push(
        allocationStatement(scope, { paymentId: payment.id, invoiceId: invoice.id, amountPaise: take, reason: 'Credit applied', now, guard }),
        auditStatement(scope, { action: 'allocation.changed', entityId: payment.id, now, when: guard, summary: { change: 'allocated', toInvoiceId: invoice.id, amountPaise: take, reason: 'Credit applied' } }),
      );
    }
  }
  return statements;
}

const LEDGER_ERRORS = {
  allocation_exceeds_invoice: [409, 'balance_changed', 'That is more than the invoice still owes. Balances may have changed; reload and try again.'],
  allocation_exceeds_payment: [409, 'balance_changed', 'That is more than is left of this payment. Balances may have changed; reload and try again.'],
  release_exceeds_allocation: [409, 'balance_changed', 'That is more than this payment put towards the invoice. Reload and try again.'],
  allocation_invalid: [422, 'allocation_invalid', 'Payments can only go to this student\'s issued invoices'],
  payment_reversed: [422, 'payment_reversed', 'This payment has been reversed'],
  reversal_mismatch: [422, 'reversal_mismatch', 'This payment can\'t be reversed'],
  invoice_has_payments: [422, 'invoice_has_payments', 'This invoice has payments against it. Move them to another invoice or credit first.'],
};

/** Maps a trigger's RAISE (or the one-reversal unique index) to an HTTP error; anything else passes through. */
export function ledgerError(error) {
  const message = String(error?.message || error?.cause?.message || '');
  for (const [code, [status, publicCode, text]] of Object.entries(LEDGER_ERRORS)) {
    if (message.includes(code)) return new CrmHttpError(status, publicCode, text);
  }
  if (/UNIQUE constraint failed: crm_payments\.reverses_payment_id/i.test(message)) return new CrmHttpError(422, 'already_reversed', 'This payment has already been reversed');
  return error;
}

/** Runs a ledger batch, mapping rule violations. */
export async function ledgerBatch(db, statements) {
  try {
    return await db.batch(statements, 'write');
  } catch (error) {
    throw ledgerError(error);
  }
}
