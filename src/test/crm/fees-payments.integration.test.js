// Payments on real SQLite (CRM M2 phase 1 S3): the append-only ledger,
// oldest-first allocation, credit, reversals, moves, races and receipts.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import {
  BASE_SCHEMA, CLASSES_MIGRATIONS, CRM_MIGRATIONS, FEES_MIGRATIONS, SEED, actors, auditRows, count, grant, makeCaller, migrationStatements,
} from './classesHarness.js';

const state = vi.hoisted(() => ({ db: null, user: null }));
const auth = vi.hoisted(() => ({
  database: vi.fn(() => state.db),
  sessionForRequest: vi.fn(),
  ensureAuthTables: vi.fn(async () => undefined),
  requireUser: vi.fn(async () => state.user),
}));
const flags = vi.hoisted(() => ({ isSchoolFeatureEnabled: vi.fn(async () => true) }));
vi.mock('../../../api/_lib/auth.js', () => auth);
vi.mock('../../../api/_lib/featureFlags.js', () => flags);

const { handleCrmRequest } = await import('../../../server/crm/router.js');
const call = makeCaller(auth, handleCrmRequest);
const { admin, otherAdmin, staff } = actors;
let dir;

beforeAll(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'crm-payments-')); });
afterAll(async () => { state.db?.close(); await rm(dir, { recursive: true, force: true }); });

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-14T04:30:00.000Z'));
  state.db?.close();
  state.db = createClient({ url: `file:${path.join(dir, `${Math.random()}.db`)}` });
  await state.db.batch([...BASE_SCHEMA, ...migrationStatements([...CRM_MIGRATIONS, ...CLASSES_MIGRATIONS, ...FEES_MIGRATIONS]), ...SEED], 'write');
});
afterEach(() => { vi.useRealTimers(); });

const invoice = async (dueDate, amountPaise, studentId = 'stu_1') => (await call(admin, 'POST', 'fees/invoices', {
  body: { studentId, dueDate, lines: [{ label: `Fee due ${dueDate}`, amountPaise }] },
})).body;
const pay = (body = {}, actor = admin) => call(actor, 'POST', 'fees/payments', {
  body: { studentId: 'stu_1', amountPaise: 2000000, receivedOn: '2026-10-14', method: 'upi', reference: 'UPI-REF-77881', note: 'Paid at the counter by uncle', ...body },
});
const feesOf = async (studentId = 'stu_1') => (await call(admin, 'GET', 'fees/student', { query: { studentId } })).body;
const balances = async (studentId) => (await feesOf(studentId)).invoices.map((item) => [item.number.slice(-4), item.paidPaise, item.paymentStatus]);

describe('Recording payments (S3)', () => {
  it('allocates oldest due first, numbers the receipt, and keeps references and notes out of the audit log', async () => {
    await invoice('2026-10-15', 1200000);
    await invoice('2026-06-15', 1400000);
    const paid = await pay();
    expect(paid.statusCode).toBe(201);
    expect(paid.body).toMatchObject({
      receiptNumber: 'SA/RCP/2026-27/0001', amountPaise: 2000000, method: 'upi', reference: 'UPI-REF-77881', unallocatedPaise: 0, reversal: null,
      allocations: [{ invoiceNumber: 'SA/INV/2026-27/0002', amountPaise: 1400000 }, { invoiceNumber: 'SA/INV/2026-27/0001', amountPaise: 600000 }],
    });
    expect(await balances()).toEqual([['0002', 1400000, 'paid'], ['0001', 600000, 'partly_paid']]);
    const fees = await feesOf();
    expect(fees.summary).toMatchObject({ balancePaise: 600000, overduePaise: 0, paidPaise: 2000000, creditPaise: 0 });

    const audit = await auditRows(state.db, 'payment.changed');
    expect(audit.map((row) => row.summary)).toEqual([{ change: 'recorded', receiptNumber: 'SA/RCP/2026-27/0001', amountPaise: 2000000, method: 'upi', allocatedPaise: 2000000 }]);
    expect(JSON.stringify(await state.db.execute('SELECT summary_json FROM crm_audit_events').then((r) => r.rows))).not.toMatch(/UPI-REF|uncle/);
  });

  it('turns an overpayment into credit and applies it to the next invoice', async () => {
    await invoice('2026-10-15', 500000);
    const paid = (await pay({ amountPaise: 800000 })).body;
    expect(paid.unallocatedPaise).toBe(300000);
    expect((await feesOf()).summary.creditPaise).toBe(300000);

    const next = await invoice('2026-11-15', 1000000);
    expect(next).toMatchObject({ paidPaise: 300000, paymentStatus: 'partly_paid', balancePaise: 700000 });
    expect((await feesOf()).summary).toMatchObject({ creditPaise: 0, balancePaise: 700000 });
    expect((await auditRows(state.db, 'allocation.changed')).map((row) => row.summary)).toEqual([
      { change: 'allocated', toInvoiceId: next.id, amountPaise: 300000, reason: 'Credit applied' },
    ]);
  });

  it('takes manual allocations, and refuses over-allocation, other students\' invoices, future dates and other schools', async () => {
    const first = await invoice('2026-06-15', 1400000);
    const second = await invoice('2026-10-15', 1200000);
    const other = await invoice('2026-10-15', 100000, 'stu_2');
    const manual = await pay({ amountPaise: 500000, allocations: [{ invoiceId: second.id, amountPaise: 500000 }] });
    expect(manual.body.allocations).toEqual([{ invoiceId: second.id, invoiceNumber: second.number, amountPaise: 500000 }]);

    expect((await pay({ amountPaise: 800000, allocations: [{ invoiceId: second.id, amountPaise: 800000 }] })).statusCode).toBe(409);
    expect((await pay({ amountPaise: 100000, allocations: [{ invoiceId: other.id, amountPaise: 100000 }] })).statusCode).toBe(409);
    expect((await pay({ amountPaise: 100000, allocations: [{ invoiceId: first.id, amountPaise: 200000 }] })).statusCode).toBe(422);
    expect((await pay({ receivedOn: '2026-10-15' })).statusCode).toBe(422);
    expect((await pay({ method: 'crypto' })).statusCode).toBe(422);
    expect((await pay({ amountPaise: 0 })).statusCode).toBe(422);
    expect((await pay({ studentId: 'stu_b1' })).statusCode).toBe(404);
    expect((await pay({}, otherAdmin)).statusCode).toBe(404);
    // Only the first payment exists, so its receipt number is the only one used.
    expect((await state.db.execute('SELECT receipt_number FROM crm_payments')).rows.map((row) => row.receipt_number)).toEqual(['SA/RCP/2026-27/0001']);
  });

  it('records a payment once per Idempotency-Key, even when the retry races the first request', async () => {
    await invoice('2026-10-15', 1000000);
    const keyed = async (key, amountPaise = 400000) => {
      auth.sessionForRequest.mockResolvedValue(admin);
      const res = { status(code) { this.statusCode = code; return this; }, json(payload) { this.body = payload; return this; } };
      await handleCrmRequest({
        method: 'POST', headers: { 'idempotency-key': key }, query: {},
        body: { studentId: 'stu_1', amountPaise, receivedOn: '2026-10-14', method: 'cash' },
      }, res, ['fees', 'payments']);
      return res;
    };
    const [a, b] = await Promise.all([keyed('pay-key-0001'), keyed('pay-key-0001')]);
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(a.body.id).toBe(b.body.id);
    const again = await keyed('pay-key-0001');
    expect(again.body).toMatchObject({ id: a.body.id, receiptNumber: 'SA/RCP/2026-27/0001' });
    expect((await keyed('pay-key-0001', 500000)).statusCode).toBe(409);
    expect(await count(state.db, "SELECT COUNT(*) AS n FROM crm_payments")).toBe(1);
    expect((await keyed('pay-key-0002')).body.receiptNumber).toBe('SA/RCP/2026-27/0002');
  });

  it('lets only one of two racing payments take the same balance, without using a receipt number for the loser', async () => {
    const due = await invoice('2026-10-15', 1000000);
    const [a, b] = await Promise.all([
      pay({ amountPaise: 1000000, allocations: [{ invoiceId: due.id, amountPaise: 1000000 }] }),
      pay({ amountPaise: 1000000, allocations: [{ invoiceId: due.id, amountPaise: 1000000 }] }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    expect(await balances()).toEqual([['0001', 1000000, 'paid']]);
    expect((await pay({ amountPaise: 100 })).body.receiptNumber).toBe('SA/RCP/2026-27/0002');
  });
});

describe('Reversals and moves (S3)', () => {
  it('reverses once with a reason, releasing what the payment paid', async () => {
    await invoice('2026-06-15', 1400000);
    await invoice('2026-10-15', 1200000);
    const paid = (await pay({ method: 'cheque', reference: 'CHQ 004512' })).body;
    expect((await call(admin, 'POST', 'fees/payments/reverse', { body: { paymentId: paid.id, reason: 'x' } })).statusCode).toBe(422);
    const [one, two] = await Promise.all([
      call(admin, 'POST', 'fees/payments/reverse', { body: { paymentId: paid.id, reason: 'Cheque bounced' } }),
      call(admin, 'POST', 'fees/payments/reverse', { body: { paymentId: paid.id, reason: 'Cheque bounced' } }),
    ]);
    expect([one.statusCode, two.statusCode].sort()).toEqual([200, 422]);
    const reversed = (one.statusCode === 200 ? one : two).body;
    expect(reversed).toMatchObject({ reversal: { reason: 'Cheque bounced' }, allocations: [], unallocatedPaise: 0 });
    expect(await balances()).toEqual([['0001', 0, 'unpaid'], ['0002', 0, 'unpaid']]);
    expect((await feesOf()).summary).toMatchObject({ balancePaise: 2600000, creditPaise: 0, overduePaise: 1400000 });
    expect((await auditRows(state.db, 'payment.changed')).map((row) => row.summary.change)).toEqual(['recorded', 'reversed']);
    expect((await call(admin, 'POST', 'fees/allocations/move', { body: { paymentId: paid.id, toInvoiceId: (await feesOf()).invoices[0].id, amountPaise: 100, reason: 'Try again' } })).statusCode).toBe(422);
    // The ledger only grows.
    expect(await count(state.db, 'SELECT COUNT(*) AS n FROM crm_payments')).toBe(2);
    expect(await count(state.db, 'SELECT COUNT(*) AS n FROM crm_payment_allocations')).toBe(4);
  });

  it('moves money between invoices and credit with a reason, never more than is there', async () => {
    const first = await invoice('2026-06-15', 1000000);
    const second = await invoice('2026-10-15', 1000000);
    const paid = (await pay({ amountPaise: 1000000, allocations: [{ invoiceId: first.id, amountPaise: 1000000 }] })).body;
    const move = (body) => call(admin, 'POST', 'fees/allocations/move', { body: { paymentId: paid.id, reason: 'Meant for October', ...body } });

    expect((await move({ fromInvoiceId: first.id, toInvoiceId: second.id, amountPaise: 400000 })).body.allocations.map((item) => item.amountPaise)).toEqual([600000, 400000]);
    expect((await move({ fromInvoiceId: first.id, amountPaise: 600001 })).statusCode).toBe(409);
    expect((await move({ fromInvoiceId: first.id, amountPaise: 600000 })).body.unallocatedPaise).toBe(600000);
    expect((await move({ toInvoiceId: second.id, amountPaise: 700000 })).statusCode).toBe(409);
    expect((await move({ toInvoiceId: second.id, amountPaise: 600000 })).body.unallocatedPaise).toBe(0);
    expect((await move({ fromInvoiceId: first.id, toInvoiceId: first.id, amountPaise: 1 })).statusCode).toBe(422);
    expect(await balances()).toEqual([['0001', 0, 'unpaid'], ['0002', 1000000, 'paid']]);
    expect((await auditRows(state.db, 'allocation.changed')).map((row) => row.summary.change)).toEqual(['moved', 'released', 'allocated']);
  });

  it('refuses to void or correct an invoice with money on it, and stop future fees skips it', async () => {
    const due = await invoice('2026-11-15', 1000000);
    await invoice('2026-12-15', 1000000);
    await pay({ amountPaise: 100000 });
    const voided = await call(admin, 'POST', 'fees/invoices/void', { body: { invoiceId: due.id, reason: 'Wrong amount' } });
    expect(voided.statusCode).toBe(422);
    expect(voided.body.error.code).toBe('invoice_has_payments');
    expect((await call(admin, 'POST', 'fees/invoices/correct', { body: { invoiceId: due.id, reason: 'Wrong amount', dueDate: '2026-11-15', lines: [{ label: 'X', amountPaise: 1 }] } })).statusCode).toBe(422);
    expect((await call(admin, 'POST', 'fees/invoices/stop-future', { body: { studentId: 'stu_1', fromDate: '2026-11-01', reason: 'Leaving' } })).body).toEqual({ voided: 1, skipped: 1 });
    expect(await count(state.db, 'SELECT COUNT(*) AS n FROM crm_invoices')).toBe(2);
  });
});

describe('Payments list and access (S3)', () => {
  it('lists payments by date and method with today\'s collection by method, reversed ones excluded', async () => {
    await invoice('2026-10-15', 5000000);
    await pay({ amountPaise: 100000, method: 'cash' });
    await pay({ amountPaise: 250000, method: 'upi' });
    const bounced = (await pay({ amountPaise: 300000, method: 'cheque' })).body;
    await call(admin, 'POST', 'fees/payments/reverse', { body: { paymentId: bounced.id, reason: 'Cheque bounced' } });
    await pay({ amountPaise: 50000, method: 'cash', receivedOn: '2026-10-01' });

    const list = (await call(admin, 'GET', 'fees/payments')).body;
    expect(list).toMatchObject({ from: '2026-09-14', to: '2026-10-14' });
    expect(list.items.map((item) => [item.receivedOn, item.method, Boolean(item.reversal)])).toEqual([
      ['2026-10-14', 'cheque', true], ['2026-10-14', 'upi', false], ['2026-10-14', 'cash', false], ['2026-10-01', 'cash', false],
    ]);
    expect(list.totals).toMatchObject({ totalPaise: 400000, count: 3 });
    expect(list.todayTotals).toMatchObject({ totalPaise: 350000, count: 2, byMethod: { cash: 100000, upi: 250000, cheque: 0 } });
    expect((await call(admin, 'GET', 'fees/payments', { query: { method: 'cash', from: '2026-10-02' } })).body.items).toHaveLength(1);
    expect((await call(admin, 'GET', 'fees/payments', { query: { from: '2026-10-15', to: '2026-10-01' } })).statusCode).toBe(422);
    expect((await call(otherAdmin, 'GET', 'fees/payments')).body.items).toEqual([]);
  });

  it('needs finance write to record, reverse or move, and keeps payments per school', async () => {
    await invoice('2026-10-15', 100000);
    const paid = (await pay({ amountPaise: 100000 })).body;
    await grant(state.db, 'usr_staff', ['crm.access', 'crm.finance.read']);
    expect((await call(staff, 'GET', 'fees/payments')).body.items).toHaveLength(1);
    expect((await pay({}, staff)).statusCode).toBe(403);
    expect((await call(staff, 'POST', 'fees/payments/reverse', { body: { paymentId: paid.id, reason: 'Not allowed' } })).statusCode).toBe(403);
    expect((await call(otherAdmin, 'POST', 'fees/payments/reverse', { body: { paymentId: paid.id, reason: 'Not yours' } })).statusCode).toBe(404);
    expect((await call(otherAdmin, 'POST', 'fees/allocations/move', { body: { paymentId: paid.id, fromInvoiceId: 'x', amountPaise: 1, reason: 'Not yours' } })).statusCode).toBe(404);
  });
});
