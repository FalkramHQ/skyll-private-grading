// Fee plans and fee settings on real SQLite (CRM M2 phase 1 S1).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import {
  BASE_SCHEMA, CLASSES_MIGRATIONS, CRM_MIGRATIONS, FEES_MIGRATIONS, SEED, actors, auditRows, grant, makeCaller, migrationStatements,
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

beforeAll(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'crm-fees-')); });
afterAll(async () => { state.db?.close(); await rm(dir, { recursive: true, force: true }); });

beforeEach(async () => {
  state.db?.close();
  state.db = createClient({ url: `file:${path.join(dir, `${Date.now()}-${Math.random()}.db`)}` });
  await state.db.batch([...BASE_SCHEMA, ...migrationStatements([...CRM_MIGRATIONS, ...CLASSES_MIGRATIONS, ...FEES_MIGRATIONS]), ...SEED], 'write');
});

const instalments = {
  name: 'Grade 10 annual',
  kind: 'instalments',
  items: [
    { label: 'Admission fee', amountPaise: 200000, dueOffsetValue: 0, dueOffsetUnit: 'days' },
    { label: 'Instalment 1', amountPaise: 1500000, dueOffsetValue: 0, dueOffsetUnit: 'days' },
    { label: 'Instalment 2', amountPaise: 1500000, dueOffsetValue: 3, dueOffsetUnit: 'months' },
  ],
};
const monthly = { name: 'Monthly tuition', kind: 'monthly', items: [], monthly: { amountPaise: 250000, count: 10, dueDay: 5 } };
const newPlan = (body = {}, actor = admin) => call(actor, 'POST', 'fees/plans', { body: { ...instalments, ...body } });

describe('CRM fee plans (S1)', () => {
  it('creates, edits, archives and restores a plan with totals, audit and version checks', async () => {
    const created = await newPlan();
    expect(created.statusCode).toBe(201);
    expect(created.body).toMatchObject({ name: 'Grade 10 annual', kind: 'instalments', course: null, monthly: null, totalPaise: 3200000, status: 'active', version: 1 });
    expect(created.body.items.map((item) => item.label)).toEqual(['Admission fee', 'Instalment 1', 'Instalment 2']);

    const edited = await call(admin, 'POST', 'fees/plans/update', {
      body: { planId: created.body.id, expectedVersion: 1, ...monthly, items: [{ label: 'Admission fee', amountPaise: 100000, dueOffsetValue: 0, dueOffsetUnit: 'days' }] },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.body).toMatchObject({ name: 'Monthly tuition', kind: 'monthly', monthly: { amountPaise: 250000, count: 10, dueDay: 5 }, totalPaise: 2600000, version: 2 });
    expect(edited.body.items).toHaveLength(1);

    const stale = await call(admin, 'POST', 'fees/plans/update', { body: { planId: created.body.id, expectedVersion: 1, ...instalments } });
    expect(stale.statusCode).toBe(409);
    expect((await call(admin, 'GET', 'fees/plans')).body.items[0].items).toHaveLength(1);

    expect((await call(admin, 'POST', 'fees/plans/archive', { body: { planId: created.body.id, expectedVersion: 2 } })).body.status).toBe('archived');
    expect((await call(admin, 'GET', 'fees/plans')).body.items).toEqual([]);
    expect((await call(admin, 'GET', 'fees/plans', { query: { status: 'archived' } })).body.items).toHaveLength(1);
    const again = await call(admin, 'POST', 'fees/plans/archive', { body: { planId: created.body.id, expectedVersion: 3 } });
    expect(again.statusCode).toBe(422);
    expect((await call(admin, 'POST', 'fees/plans/restore', { body: { planId: created.body.id, expectedVersion: 3 } })).body.status).toBe('active');

    expect((await auditRows(state.db, 'fee_plan.changed')).map((row) => row.summary.change)).toEqual(['created', 'updated', 'archived', 'restored']);
  });

  it('validates plan shape, duplicate names and the linked course', async () => {
    await newPlan();
    expect((await newPlan({ name: '  grade 10   ANNUAL ' })).statusCode).toBe(409);
    expect((await newPlan({ name: 'Empty', items: [] })).statusCode).toBe(422);
    expect((await newPlan({ ...monthly, name: 'No monthly', monthly: null })).statusCode).toBe(422);
    expect((await newPlan({ name: 'Monthly on one-time', kind: 'one_time', monthly: monthly.monthly })).statusCode).toBe(422);
    expect((await newPlan({ name: 'Too many months', ...monthly, monthly: { ...monthly.monthly, count: 25 } })).statusCode).toBe(422);
    expect((await newPlan({ name: 'Bad day', ...monthly, monthly: { ...monthly.monthly, dueDay: 31 } })).statusCode).toBe(422);
    expect((await newPlan({ name: 'Fractional', items: [{ label: 'X', amountPaise: 10.5, dueOffsetValue: 0, dueOffsetUnit: 'days' }] })).statusCode).toBe(422);
    expect((await newPlan({ name: 'Free', items: [{ label: 'X', amountPaise: 0, dueOffsetValue: 0, dueOffsetUnit: 'days' }] })).statusCode).toBe(422);

    const course = await call(admin, 'POST', 'classes/courses', { body: { name: 'Grade 10 Maths', deliveryMode: 'classroom' } });
    const linked = await newPlan({ name: 'Linked', courseId: course.body.id });
    expect(linked.body.course).toEqual({ id: course.body.id, name: 'Grade 10 Maths' });
    expect((await call(admin, 'GET', 'fees/plans', { query: { courseId: course.body.id } })).body.items.map((plan) => plan.name)).toEqual(['Linked']);

    const foreign = await call(otherAdmin, 'POST', 'classes/courses', { body: { name: 'Other', deliveryMode: 'classroom' } });
    expect((await newPlan({ name: 'Foreign course', courseId: foreign.body.id })).statusCode).toBe(422);
  });

  it('keeps plans per school and needs finance capabilities', async () => {
    const plan = await newPlan();
    expect((await call(otherAdmin, 'GET', 'fees/plans')).body.items).toEqual([]);
    expect((await call(otherAdmin, 'POST', 'fees/plans/archive', { body: { planId: plan.body.id, expectedVersion: 1 } })).statusCode).toBe(404);
    expect((await newPlan({ name: 'Grade 10 annual' }, otherAdmin)).statusCode).toBe(201);

    expect((await call(teacher, 'GET', 'fees/plans')).statusCode).toBe(403);
    expect((await call(staff, 'GET', 'fees/plans')).statusCode).toBe(403);
    await grant(state.db, 'usr_staff', ['crm.access', 'crm.finance.read']);
    expect((await call(staff, 'GET', 'fees/plans')).body.items).toHaveLength(1);
    expect((await newPlan({ name: 'Staff plan' }, staff)).statusCode).toBe(403);
    await grant(state.db, 'usr_staff', ['crm.finance.write']);
    expect((await newPlan({ name: 'Staff plan' }, staff)).statusCode).toBe(201);
    expect((await call(staff, 'GET', 'settings/fees')).statusCode).toBe(403);
  });
});

describe('CRM fee settings (S1)', () => {
  it('starts from school defaults, saves with version checks and audits changed fields', async () => {
    const initial = await call(admin, 'GET', 'settings/fees');
    expect(initial.body).toMatchObject({ prefix: 'SA', headerName: 'School A', version: 0, saved: false });

    const body = { prefix: 'SAX', headerName: 'School A Coaching', headerAddress: '12 MG Road, Pune', headerPhone: '+91 98765 43210', headerGstin: '', footerNote: 'Fees once paid are not refundable.' };
    const saved = await call(admin, 'POST', 'settings/fees', { body: { ...body, expectedVersion: 0 } });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).toMatchObject({ ...body, version: 1, saved: true });
    expect((await call(admin, 'POST', 'settings/fees', { body: { ...body, expectedVersion: 0 } })).statusCode).toBe(409);

    const updated = await call(admin, 'POST', 'settings/fees', { body: { ...body, prefix: 'SACC', expectedVersion: 1 } });
    expect(updated.body).toMatchObject({ prefix: 'SACC', version: 2 });
    expect((await call(admin, 'POST', 'settings/fees', { body: { ...body, prefix: 'sa-1', expectedVersion: 2 } })).statusCode).toBe(422);

    const audit = await auditRows(state.db, 'fee_settings.changed');
    expect(audit.map((row) => row.summary.fields)).toEqual([['prefix', 'headerName', 'headerAddress', 'headerPhone', 'footerNote'], ['prefix']]);
    expect(JSON.stringify(audit)).not.toContain('MG Road');

    expect((await call(otherAdmin, 'GET', 'settings/fees')).body).toMatchObject({ prefix: 'SB', version: 0 });
  });
});
