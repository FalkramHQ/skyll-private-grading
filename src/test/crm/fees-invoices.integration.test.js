// Invoices and dues on real SQLite (CRM M2 phase 1 S2): gapless numbering per
// financial year, frozen names, void and correct rules, stop future fees, and
// the Dues list.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import {
  BASE_SCHEMA, CLASSES_MIGRATIONS, CRM_MIGRATIONS, FEES_MIGRATIONS, SEED, T, actors, auditRows, count, grant, makeCaller, migrationStatements,
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
const { admin, otherAdmin, teacher, staff } = actors;
let dir;

// 10:00 IST on 14 Oct 2026, unless a test moves the clock.
const NOW = '2026-10-14T04:30:00.000Z';
const setNow = (iso) => vi.setSystemTime(new Date(iso));

beforeAll(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'crm-invoices-')); });
afterAll(async () => { state.db?.close(); await rm(dir, { recursive: true, force: true }); });

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  setNow(NOW);
  state.db?.close();
  state.db = createClient({ url: `file:${path.join(dir, `${Math.random()}.db`)}` });
  await state.db.batch([
    ...BASE_SCHEMA,
    ...migrationStatements([...CRM_MIGRATIONS, ...CLASSES_MIGRATIONS, ...FEES_MIGRATIONS]),
    ...SEED,
    `INSERT INTO crm_contacts (id, school_id, full_name, created_at, updated_at) VALUES ('ct_mother', 'sch_a', 'Meera Iyer', '${T}', '${T}'), ('ct_father', 'sch_a', 'Ravi Iyer', '${T}', '${T}')`,
    `INSERT INTO crm_guardian_links (id, school_id, student_id, contact_id, is_primary, is_fee_payer, created_at, updated_at) VALUES
       ('gl_1', 'sch_a', 'stu_1', 'ct_mother', 1, 0, '${T}', '${T}'), ('gl_2', 'sch_a', 'stu_1', 'ct_father', 0, 1, '${T}', '${T}')`,
    `INSERT INTO crm_batch_settings (batch_id, school_id, starts_on, created_at, updated_at) VALUES ('b_math10', 'sch_a', '2026-06-15', '${T}', '${T}')`,
  ], 'write');
});
afterEach(() => { vi.useRealTimers(); });

const plan = async (body = {}) => (await call(admin, 'POST', 'fees/plans', {
  body: {
    name: 'Grade 10 annual',
    kind: 'instalments',
    items: [
      { label: 'Admission fee', amountPaise: 200000, dueOffsetValue: 0, dueOffsetUnit: 'days' },
      { label: 'Instalment 1', amountPaise: 1200000, dueOffsetValue: 0, dueOffsetUnit: 'months' },
      { label: 'Instalment 2', amountPaise: 1200000, dueOffsetValue: 4, dueOffsetUnit: 'months' },
    ],
    ...body,
  },
})).body;

async function applyPlan(planId, studentId = 'stu_1', startDate, actor = admin) {
  const preview = await call(actor, 'GET', 'fees/preview', { query: { studentId, planId, ...(startDate ? { startDate } : {}) } });
  return call(actor, 'POST', 'fees/apply', {
    body: { studentId, planId, startDate: preview.body.startDate, invoices: preview.body.invoices.map(({ dueDate, lines }) => ({ dueDate, lines })) },
  });
}

const manual = (body = {}, actor = admin) => call(actor, 'POST', 'fees/invoices', {
  body: { studentId: 'stu_2', dueDate: '2026-10-20', lines: [{ label: 'Material kit', amountPaise: 150000 }], ...body },
});

describe('Add fees (S2)', () => {
  it('previews from the batch start, then issues one numbered invoice per due date billed to the fee payer', async () => {
    const created = await plan();
    const preview = await call(admin, 'GET', 'fees/preview', { query: { studentId: 'stu_1', planId: created.id } });
    expect(preview.body).toMatchObject({ startDate: '2026-06-15', startSource: 'batch', batchName: 'Grade 10 Maths', billedTo: 'Ravi Iyer', alreadyFromPlan: 0 });
    expect(preview.body.invoices.map((invoice) => [invoice.dueDate, invoice.totalPaise])).toEqual([['2026-06-15', 1400000], ['2026-10-15', 1200000]]);

    const applied = await call(admin, 'POST', 'fees/apply', {
      body: {
        studentId: 'stu_1', planId: created.id, startDate: '2026-06-15',
        // Per-student edit: a lower second instalment, a week later.
        invoices: [preview.body.invoices[0], { dueDate: '2026-10-22', lines: [{ label: 'Instalment 2', amountPaise: 1000000 }] }].map(({ dueDate, lines }) => ({ dueDate, lines })),
      },
    });
    expect(applied.statusCode).toBe(201);
    expect(applied.body.items.map((invoice) => [invoice.number, invoice.dueDate, invoice.totalPaise, invoice.billedTo, invoice.paymentStatus, invoice.overdue])).toEqual([
      ['SA/INV/2026-27/0001', '2026-06-15', 1400000, 'Ravi Iyer', 'unpaid', true],
      ['SA/INV/2026-27/0002', '2026-10-22', 1000000, 'Ravi Iyer', 'unpaid', false],
    ]);
    expect(applied.body.items[0]).toMatchObject({ issueDate: '2026-10-14', plan: { id: created.id, name: 'Grade 10 annual' }, lines: [{ label: 'Admission fee', amountPaise: 200000 }, { label: 'Instalment 1', amountPaise: 1200000 }] });

    const audit = await auditRows(state.db, 'invoice.changed');
    expect(audit.map((row) => row.summary)).toEqual([
      { change: 'issued', number: 'SA/INV/2026-27/0001', amountPaise: 1400000 },
      { change: 'issued', number: 'SA/INV/2026-27/0002', amountPaise: 1000000 },
    ]);
    expect((await call(admin, 'GET', 'fees/preview', { query: { studentId: 'stu_1', planId: created.id } })).body.alreadyFromPlan).toBe(2);
  });

  it('starts from today without a batch start, and from a chosen date when given', async () => {
    const created = await plan();
    expect((await call(admin, 'GET', 'fees/preview', { query: { studentId: 'stu_3', planId: created.id } })).body).toMatchObject({ startDate: '2026-10-14', startSource: 'today', billedTo: null });
    expect((await call(admin, 'GET', 'fees/preview', { query: { studentId: 'stu_3', planId: created.id, startDate: '2026-11-01' } })).body.invoices[0].dueDate).toBe('2026-11-01');
    // The batch just joined wins over other batches; without a start date it counts from today.
    await state.db.execute(`INSERT INTO batch_memberships VALUES ('bm_9', 'b_sci9', 'stu_1', 'active', '${T}', NULL, '${T}', '${T}')`);
    expect((await call(admin, 'GET', 'fees/preview', { query: { studentId: 'stu_1', planId: created.id, batchId: 'b_sci9' } })).body).toMatchObject({ startDate: '2026-10-14', startSource: 'today' });
    expect((await call(admin, 'GET', 'fees/preview', { query: { studentId: 'stu_1', planId: created.id, batchId: 'b_math10' } })).body).toMatchObject({ startDate: '2026-06-15', startSource: 'batch' });
    expect((await call(admin, 'GET', 'fees/preview', { query: { studentId: 'stu_1', planId: created.id, batchId: 'b_other' } })).body.startDate).toBe('2026-06-15');
  });

  it('freezes names: renaming the student or changing the payer later leaves issued invoices alone', async () => {
    const created = await plan();
    await applyPlan(created.id);
    await state.db.execute("UPDATE students SET display_name = 'Anaya R. Iyer' WHERE id = 'stu_1'");
    await state.db.execute("UPDATE crm_contacts SET full_name = 'Ravi K. Iyer' WHERE id = 'ct_father'");
    const fees = await call(admin, 'GET', 'fees/student', { query: { studentId: 'stu_1' } });
    expect(fees.body.billedTo).toBe('Ravi K. Iyer');
    expect(fees.body.invoices.map((invoice) => invoice.billedTo)).toEqual(['Ravi Iyer', 'Ravi Iyer']);
    const stored = JSON.parse((await state.db.execute("SELECT bill_to_json FROM crm_invoices ORDER BY seq LIMIT 1")).rows[0].bill_to_json);
    expect(stored).toMatchObject({ student: { id: 'stu_1', name: 'Anaya Iyer' }, payer: { name: 'Ravi Iyer' }, school: { name: 'School A' } });
  });

  it('refuses archived plans, inactive students, other schools and empty or oversized invoices', async () => {
    const created = await plan();
    await call(admin, 'POST', 'fees/plans/archive', { body: { planId: created.id, expectedVersion: 1 } });
    expect((await applyPlan(created.id)).statusCode).toBe(422);
    const active = await plan({ name: 'Second' });
    expect((await applyPlan(active.id, 'stu_4')).statusCode).toBe(422);
    expect((await call(otherAdmin, 'GET', 'fees/preview', { query: { studentId: 'stu_1', planId: active.id } })).statusCode).toBe(404);
    expect((await call(admin, 'POST', 'fees/apply', { body: { studentId: 'stu_b1', planId: active.id, startDate: '2026-10-14', invoices: [{ dueDate: '2026-10-14', lines: [{ label: 'X', amountPaise: 100 }] }] } })).statusCode).toBe(404);
    expect((await call(admin, 'POST', 'fees/apply', { body: { studentId: 'stu_1', planId: active.id, startDate: '2026-10-14', invoices: [] } })).statusCode).toBe(422);
    expect((await call(admin, 'POST', 'fees/apply', { body: { studentId: 'stu_1', planId: active.id, startDate: '2026-10-14', invoices: [{ dueDate: '2026-10-14', lines: [] }] } })).statusCode).toBe(422);
    expect((await call(admin, 'POST', 'fees/apply', { body: { studentId: 'stu_1', planId: active.id, startDate: '2026-02-30', invoices: [{ dueDate: '2026-10-14', lines: [{ label: 'X', amountPaise: 100 }] }] } })).statusCode).toBe(422);
    const line = [{ label: 'X', amountPaise: 100 }];
    expect((await call(admin, 'POST', 'fees/apply', { body: { studentId: 'stu_1', planId: active.id, startDate: '2026-10-14', invoices: [{ dueDate: '2026-10-14', lines: line }, { dueDate: '2026-10-14', lines: line }] } })).statusCode).toBe(422);
    expect((await manual({ dueDate: '9999-12-31' })).statusCode).toBe(422);
    expect(await count(state.db, 'SELECT COUNT(*) AS n FROM crm_invoices')).toBe(0);
  });
});

describe('Invoice numbering (S2)', () => {
  it('has no gaps under concurrent writes and restarts each financial year (school time)', async () => {
    const created = await plan();
    const results = await Promise.all([
      applyPlan(created.id, 'stu_1'), applyPlan(created.id, 'stu_2'), manual(), manual({ studentId: 'stu_3' }), manual({ studentId: 'stu_1' }),
    ]);
    expect(results.map((result) => result.statusCode)).toEqual([201, 201, 201, 201, 201]);
    const seqs = (await state.db.execute("SELECT seq, number FROM crm_invoices WHERE fy = '2026-27' ORDER BY seq")).rows;
    expect(seqs.map((row) => Number(row.seq))).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(new Set(seqs.map((row) => row.number)).size).toBe(7);

    // 31 Mar 2027, 23:00 IST is still 2026-27; 1 Apr 00:30 IST starts 2027-28.
    setNow('2027-03-31T17:30:00.000Z');
    expect((await manual()).body.number).toBe('SA/INV/2026-27/0008');
    setNow('2027-03-31T19:00:00.000Z');
    expect((await manual()).body).toMatchObject({ number: 'SA/INV/2027-28/0001', issueDate: '2027-04-01' });

    // Another school counts separately; a new prefix applies from then on.
    expect((await manual({ studentId: 'stu_b1' }, otherAdmin)).body.number).toBe('SB/INV/2027-28/0001');
    await call(admin, 'POST', 'settings/fees', { body: { prefix: 'SAC', headerName: 'School A', expectedVersion: 0 } });
    expect((await manual()).body.number).toBe('SAC/INV/2027-28/0002');
  });
});

describe('Void, correct and stop future fees (S2)', () => {
  it('voids with a reason once, keeping the number', async () => {
    const invoice = (await manual()).body;
    expect((await call(admin, 'POST', 'fees/invoices/void', { body: { invoiceId: invoice.id, reason: 'x' } })).statusCode).toBe(422);
    const voided = await call(admin, 'POST', 'fees/invoices/void', { body: { invoiceId: invoice.id, reason: 'Issued to the wrong student' } });
    expect(voided.body).toMatchObject({ number: invoice.number, status: 'void', paymentStatus: 'void', balancePaise: 0, voidReason: 'Issued to the wrong student' });
    expect((await call(admin, 'POST', 'fees/invoices/void', { body: { invoiceId: invoice.id, reason: 'Again please' } })).statusCode).toBe(422);
    expect((await call(otherAdmin, 'POST', 'fees/invoices/void', { body: { invoiceId: invoice.id, reason: 'Not yours' } })).statusCode).toBe(404);
    expect((await auditRows(state.db, 'invoice.changed')).map((row) => row.summary.change)).toEqual(['issued', 'voided']);
  });

  it('corrects by voiding and re-issuing under a new number linked to the old one', async () => {
    const invoice = (await manual()).body;
    const corrected = await call(admin, 'POST', 'fees/invoices/correct', {
      body: { invoiceId: invoice.id, reason: 'Kit price changed', dueDate: '2026-10-25', lines: [{ label: 'Material kit', amountPaise: 120000 }] },
    });
    expect(corrected.statusCode).toBe(201);
    expect(corrected.body).toMatchObject({ number: 'SA/INV/2026-27/0002', totalPaise: 120000, dueDate: '2026-10-25', replacesInvoiceId: invoice.id, status: 'issued' });
    const again = await call(admin, 'POST', 'fees/invoices/correct', { body: { invoiceId: invoice.id, reason: 'Twice', dueDate: '2026-10-25', lines: [{ label: 'X', amountPaise: 1 }] } });
    expect(again.statusCode).toBe(422);
    expect(await count(state.db, 'SELECT COUNT(*) AS n FROM crm_invoices')).toBe(2);
    expect(Number((await state.db.execute("SELECT last_seq FROM crm_doc_counters")).rows[0].last_seq)).toBe(2);
    expect((await auditRows(state.db, 'invoice.changed')).map((row) => row.summary)).toEqual([
      { change: 'issued', number: 'SA/INV/2026-27/0001', amountPaise: 150000 },
      { change: 'voided', number: 'SA/INV/2026-27/0001', amountPaise: 150000, reason: 'Kit price changed' },
      { change: 'corrected', number: 'SA/INV/2026-27/0002', amountPaise: 120000, replacesInvoiceId: invoice.id },
    ]);
  });

  it('stops future fees from a date, inclusive, leaving earlier invoices', async () => {
    const created = await plan({ name: 'Monthly', kind: 'monthly', items: [], monthly: { amountPaise: 250000, count: 6, dueDay: 5 } });
    await applyPlan(created.id, 'stu_1', '2026-10-01');
    const stopped = await call(admin, 'POST', 'fees/invoices/stop-future', { body: { studentId: 'stu_1', fromDate: '2027-01-05', reason: 'Left the institute' } });
    expect(stopped.body).toEqual({ voided: 3, skipped: 0 });
    const fees = (await call(admin, 'GET', 'fees/student', { query: { studentId: 'stu_1' } })).body;
    expect(fees.invoices.map((invoice) => [invoice.dueDate, invoice.status])).toEqual([
      ['2026-10-05', 'issued'], ['2026-11-05', 'issued'], ['2026-12-05', 'issued'], ['2027-01-05', 'void'], ['2027-02-05', 'void'], ['2027-03-05', 'void'],
    ]);
    expect(fees.summary).toMatchObject({ balancePaise: 750000, overduePaise: 250000, nextDue: { dueDate: '2026-10-05', amountPaise: 250000 } });
    expect((await call(admin, 'POST', 'fees/invoices/stop-future', { body: { studentId: 'stu_1', fromDate: '2027-01-05', reason: 'Left the institute' } })).body).toEqual({ voided: 0, skipped: 0 });
  });
});

describe('Dues and access (S2)', () => {
  it('lists unpaid invoices with filters and school-wide totals', async () => {
    const created = await plan();
    await applyPlan(created.id, 'stu_1'); // 15 Jun (overdue) and 15 Oct (tomorrow)
    await manual({ dueDate: '2026-11-30' }); // stu_2, later
    const voided = (await manual({ studentId: 'stu_3', dueDate: '2026-09-01' })).body;
    await call(admin, 'POST', 'fees/invoices/void', { body: { invoiceId: voided.id, reason: 'Duplicate' } });

    const all = (await call(admin, 'GET', 'fees/dues')).body;
    expect(all.items.map((item) => [item.student.name, item.dueDate, item.overdue])).toEqual([
      ['Anaya Iyer', '2026-06-15', true], ['Anaya Iyer', '2026-10-15', false], ['Arjun Sharma', '2026-11-30', false],
    ]);
    expect(all.totals).toEqual({ outstandingPaise: 2750000, overduePaise: 1400000, overdueStudents: 1 });
    expect((await call(admin, 'GET', 'fees/dues', { query: { filter: 'overdue' } })).body.items).toHaveLength(1);
    expect((await call(admin, 'GET', 'fees/dues', { query: { filter: 'week' } })).body.items.map((item) => item.dueDate)).toEqual(['2026-10-15']);
    expect((await call(admin, 'GET', 'fees/dues', { query: { batchId: 'b_sci9' } })).body.items).toEqual([]);
    expect((await call(admin, 'GET', 'fees/dues', { query: { batchId: 'b_math10' } })).body.items).toHaveLength(3);
    expect((await call(otherAdmin, 'GET', 'fees/dues')).body.items).toEqual([]);
  });

  it('hints at siblings\' dues through a shared guardian, only with contact access (S5)', async () => {
    await state.db.execute(`INSERT INTO crm_guardian_links (id, school_id, student_id, contact_id, is_primary, created_at, updated_at) VALUES ('gl_3', 'sch_a', 'stu_2', 'ct_mother', 1, '${T}', '${T}'), ('gl_4', 'sch_a', 'stu_3', 'ct_mother', 1, '${T}', '${T}')`);
    await manual({ studentId: 'stu_2', lines: [{ label: 'Kit', amountPaise: 150000 }] });
    expect((await call(admin, 'GET', 'fees/student', { query: { studentId: 'stu_1' } })).body.siblings).toEqual([
      { studentId: 'stu_2', name: 'Arjun Sharma', guardianName: 'Meera Iyer', balancePaise: 150000 },
    ]);
    await grant(state.db, 'usr_staff', ['crm.access', 'crm.finance.read']);
    expect((await call(staff, 'GET', 'fees/student', { query: { studentId: 'stu_1' } })).body.siblings).toEqual([]);
  });

  it('needs finance read to view and finance write to issue or void', async () => {
    const invoice = (await manual()).body;
    expect((await call(teacher, 'GET', 'fees/dues')).statusCode).toBe(403);
    expect((await call(teacher, 'GET', 'fees/student', { query: { studentId: 'stu_2' } })).statusCode).toBe(403);
    await grant(state.db, 'usr_staff', ['crm.access', 'crm.finance.read']);
    expect((await call(staff, 'GET', 'fees/student', { query: { studentId: 'stu_2' } })).body.invoices).toHaveLength(1);
    expect((await manual({}, staff)).statusCode).toBe(403);
    expect((await call(staff, 'POST', 'fees/invoices/void', { body: { invoiceId: invoice.id, reason: 'Not allowed' } })).statusCode).toBe(403);
    expect((await call(staff, 'GET', 'fees/preview', { query: { studentId: 'stu_2', planId: 'x' } })).statusCode).toBe(403);
  });
});
