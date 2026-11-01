// Follow-up tasks on real SQLite (migrations 059–064): the automatic lead
// follow-up, lifecycle events, own-only teacher scope, related-record privacy,
// dashboard counts, moving tasks with a lead, and school isolation (FLKRM-326 S2).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';

const require = createRequire(import.meta.url);
const migrations = ['059_crm_access_audit', '060_crm_pipeline', '061_crm_contacts', '062_crm_leads', '064_crm_lost_reason_key', '065_crm_tasks', '066_crm_guardian_rules', '067_crm_pipeline_requirements']
  .flatMap((name) => require(`../../../scripts/migrations/${name}.cjs`).statements);

const state = vi.hoisted(() => ({ db: null }));
const auth = vi.hoisted(() => ({ database: vi.fn(() => state.db), sessionForRequest: vi.fn() }));
const flags = vi.hoisted(() => ({ isSchoolFeatureEnabled: vi.fn(async () => true) }));
vi.mock('../../../api/_lib/auth.js', () => auth);
vi.mock('../../../api/_lib/featureFlags.js', () => flags);

const { handleCrmRequest } = await import('../../../server/crm/router.js');

const admin = { user_id: 'usr_admin', username: 'a_admin', role: 'admin', school_id: 'sch_a', school: 'School A' };
const otherAdmin = { user_id: 'usr_admin_b', username: 'b_admin', role: 'admin', school_id: 'sch_b', school: 'School B' };
const teacher = { user_id: 'usr_teacher', username: 'a_teacher', role: 'teacher', school_id: 'sch_a', school: 'School A' };
const staff = { user_id: 'usr_staff', username: 'a_staff', role: 'staff', school_id: 'sch_a', school: 'School A' };

const HOUR = 60 * 60 * 1000;
let dir;

async function call(actor, method, route, { body, query = {} } = {}) {
  auth.sessionForRequest.mockResolvedValue(actor);
  const res = {
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  await handleCrmRequest({ method, headers: {}, query, body }, res, route.split('/'));
  return res;
}

async function grant(userId, capabilities) {
  const now = new Date().toISOString();
  for (const capability of capabilities) {
    await state.db.execute({
      sql: 'INSERT INTO crm_capability_grants (id, school_id, user_id, capability, granted_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [`g_${userId}_${capability}`, 'sch_a', userId, capability, 'usr_admin', now, now],
    });
  }
}

const inHours = (hours) => new Date(Date.now() + hours * HOUR).toISOString();

async function newTask(actor = admin, body = {}) {
  return call(actor, 'POST', 'tasks', { body: { title: 'Call back', dueAt: inHours(48), ...body } });
}

async function newLead(body = {}, actor = admin) {
  return call(actor, 'POST', 'leads', { body: { learnerName: 'Meera', contact: { phone: '98200 11122' }, acknowledgeDuplicates: true, ...body } });
}

async function events(taskId) {
  const result = await state.db.execute({ sql: 'SELECT event_type, from_value, to_value FROM crm_task_events WHERE task_id = ? ORDER BY created_at, rowid', args: [taskId] });
  return result.rows.map((row) => [row.event_type, row.from_value, row.to_value]);
}

beforeAll(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'crm-tasks-')); });
afterAll(async () => { state.db?.close(); await rm(dir, { recursive: true, force: true }); });

beforeEach(async () => {
  state.db?.close();
  state.db = createClient({ url: `file:${path.join(dir, `${Date.now()}-${Math.random()}.db`)}` });
  await state.db.batch([
    'CREATE TABLE users (id TEXT PRIMARY KEY, display_name TEXT, status TEXT)',
    "CREATE TABLE schools (id TEXT PRIMARY KEY, display_name TEXT, status TEXT, timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata')",
    'CREATE TABLE school_memberships (id TEXT PRIMARY KEY, school_id TEXT, user_id TEXT, role TEXT, status TEXT)',
    "CREATE TABLE students (id TEXT PRIMARY KEY, school_id TEXT, display_name TEXT, status TEXT NOT NULL DEFAULT 'active')",
    ...migrations,
    "INSERT INTO schools (id, display_name, status) VALUES ('sch_a', 'School A', 'active'), ('sch_b', 'School B', 'active')",
    `INSERT INTO users VALUES ('usr_admin', 'Admin A', 'active'), ('usr_admin_b', 'Admin B', 'active'),
       ('usr_teacher', 'Teacher A', 'active'), ('usr_staff', 'Staff A', 'active')`,
    `INSERT INTO school_memberships VALUES ('m1', 'sch_a', 'usr_admin', 'school_admin', 'active'),
       ('m2', 'sch_b', 'usr_admin_b', 'school_admin', 'active'), ('m3', 'sch_a', 'usr_teacher', 'teacher', 'active'),
       ('m4', 'sch_a', 'usr_staff', 'staff', 'active')`,
    "INSERT INTO students (id, school_id, display_name) VALUES ('stu_a', 'sch_a', 'Riya'), ('stu_b', 'sch_b', 'Other')",
  ], 'write');
});

describe('CRM tasks (real SQLite)', () => {
  it('gives every new lead a follow-up task for its owner, due in 24 hours', async () => {
    const before = Date.now();
    const lead = (await newLead()).body;
    const tasks = (await call(admin, 'GET', 'tasks')).body.items;
    expect(tasks).toEqual([expect.objectContaining({
      title: 'Follow up with Meera',
      status: 'open',
      owner: { userId: 'usr_admin', name: 'Admin A' },
      related: { type: 'lead', id: lead.id, name: 'Meera', restricted: false },
    })]);
    const due = Date.parse(tasks[0].dueAt);
    expect(due).toBeGreaterThanOrEqual(before + 24 * HOUR - 1000);
    expect(due).toBeLessThanOrEqual(Date.now() + 24 * HOUR + 1000);
    expect(await events(tasks[0].id)).toEqual([['created', null, 'usr_admin']]);
    const audit = await state.db.execute("SELECT summary_json FROM crm_audit_events WHERE action = 'task.changed'");
    expect(JSON.parse(audit.rows[0].summary_json)).toEqual(expect.objectContaining({ change: 'created', auto: true, relatedType: 'lead' }));
  });

  it('runs open → done → open → cancelled → open, recording every change as an immutable event', async () => {
    let task = (await newTask()).body;
    expect(task).toEqual(expect.objectContaining({ status: 'open', priority: 'normal', owner: { userId: 'usr_admin', name: 'Admin A' }, version: 1 }));
    task = (await call(admin, 'POST', 'tasks/complete', { body: { taskId: task.id, expectedVersion: 1 } })).body;
    expect(task).toEqual(expect.objectContaining({ status: 'done', completedAt: expect.any(String) }));
    const cancelDone = await call(admin, 'POST', 'tasks/cancel', { body: { taskId: task.id, expectedVersion: 2 } });
    expect(cancelDone.statusCode).toBe(422);
    task = (await call(admin, 'POST', 'tasks/reopen', { body: { taskId: task.id, expectedVersion: 2 } })).body;
    expect(task).toEqual(expect.objectContaining({ status: 'open', completedAt: null }));
    task = (await call(admin, 'POST', 'tasks/cancel', { body: { taskId: task.id, expectedVersion: 3 } })).body;
    expect(task.status).toBe('cancelled');
    // A cancelled task can be restored (D12a); both steps stay in the history.
    task = (await call(admin, 'POST', 'tasks/reopen', { body: { taskId: task.id, expectedVersion: 4 } })).body;
    expect(task).toEqual(expect.objectContaining({ status: 'open', version: 5 }));

    expect(await events(task.id)).toEqual([
      ['created', null, 'usr_admin'], ['completed', 'open', 'done'], ['reopened', 'done', 'open'], ['cancelled', 'open', 'cancelled'],
      ['reopened', 'cancelled', 'open'],
    ]);
    const audit = await state.db.execute("SELECT summary_json FROM crm_audit_events WHERE action = 'task.changed' ORDER BY id");
    expect(audit.rows.map((row) => JSON.parse(row.summary_json).change)).toEqual(['created', 'completed', 'reopened', 'cancelled', 'reopened']);
    await expect(state.db.execute("UPDATE crm_task_events SET to_value = 'x'")).rejects.toThrow(/append-only/);
    await expect(state.db.execute('DELETE FROM crm_task_events')).rejects.toThrow(/append-only/);
  });

  it('reschedules open tasks only, auditing old and new times, and rejects stale versions', async () => {
    const task = (await newTask()).body;
    const later = inHours(72);
    const moved = await call(admin, 'POST', 'tasks/reschedule', { body: { taskId: task.id, dueAt: later, expectedVersion: 1 } });
    expect(moved.body).toEqual(expect.objectContaining({ dueAt: later, version: 2 }));
    const stale = await call(admin, 'POST', 'tasks/reschedule', { body: { taskId: task.id, dueAt: inHours(96), expectedVersion: 1 } });
    expect(stale.statusCode).toBe(409);
    expect(await events(task.id)).toEqual([['created', null, 'usr_admin'], ['rescheduled', task.dueAt, later]]);
    const audit = await state.db.execute("SELECT summary_json FROM crm_audit_events WHERE action = 'task.changed' ORDER BY id");
    expect(JSON.parse(audit.rows[1].summary_json)).toEqual({ change: 'rescheduled', fromDueAt: task.dueAt, toDueAt: later });

    await call(admin, 'POST', 'tasks/complete', { body: { taskId: task.id, expectedVersion: 2 } });
    expect((await call(admin, 'POST', 'tasks/reschedule', { body: { taskId: task.id, dueAt: inHours(5), expectedVersion: 3 } })).statusCode).toBe(422);
    expect((await newTask(admin, { dueAt: 'next tuesday' })).statusCode).toBe(422);
  });

  it('limits default teachers to their own tasks, and a grant widens that', async () => {
    const adminTask = (await newTask(admin)).body;
    const mine = await newTask(teacher, { title: 'Mark homework' });
    expect(mine.statusCode).toBe(201);
    expect((await newTask(teacher, { ownerUserId: 'usr_admin' })).statusCode).toBe(403);

    const list = await call(teacher, 'GET', 'tasks', { query: { view: 'all' } });
    expect(list.body.view).toBe('mine');
    expect(list.body.items.map((task) => task.title)).toEqual(['Mark homework']);
    expect((await call(teacher, 'POST', 'tasks/complete', { body: { taskId: adminTask.id, expectedVersion: 1 } })).statusCode).toBe(404);
    expect((await call(teacher, 'POST', 'tasks/reassign', { body: { taskId: mine.body.id, ownerUserId: 'usr_admin', expectedVersion: 1 } })).statusCode).toBe(403);
    expect((await call(teacher, 'POST', 'tasks/complete', { body: { taskId: mine.body.id, expectedVersion: 1 } })).body.status).toBe('done');
    expect((await call(teacher, 'GET', 'tasks/summary')).body).toEqual(expect.objectContaining({ scope: 'own' }));
    expect((await call(teacher, 'GET', 'tasks/summary')).body.all).toBeUndefined();

    await grant('usr_teacher', ['crm.tasks.read', 'crm.tasks.write']);
    const widened = await call(teacher, 'GET', 'tasks', { query: { view: 'all' } });
    expect(widened.body.view).toBe('all');
    expect(widened.body.items.map((task) => task.title)).toEqual(['Call back']);
  });

  it('assigns only to active members who can work tasks, or leaves a task unassigned', async () => {
    expect((await newTask(admin, { ownerUserId: 'usr_staff' })).statusCode).toBe(422);
    await grant('usr_staff', ['crm.access', 'crm.tasks.read', 'crm.tasks.write']);
    expect((await call(admin, 'GET', 'tasks/assignees')).body.items.map((item) => item.userId)).toEqual(['usr_admin', 'usr_staff', 'usr_teacher']);
    const task = (await newTask(admin, { ownerUserId: 'usr_staff' })).body;
    expect(task.owner).toEqual({ userId: 'usr_staff', name: 'Staff A' });

    const unassigned = await call(admin, 'POST', 'tasks/reassign', { body: { taskId: task.id, ownerUserId: null, expectedVersion: 1 } });
    expect(unassigned.body.owner).toBeNull();
    expect(await events(task.id)).toEqual([['created', null, 'usr_staff'], ['reassigned', 'usr_staff', null]]);
    expect((await call(admin, 'POST', 'tasks/reassign', { body: { taskId: task.id, ownerUserId: 'usr_admin_b', expectedVersion: 2 } })).statusCode).toBe(422);

    // A disabled owner shows as unassigned until someone reassigns the task.
    const staffTask = (await newTask(admin, { ownerUserId: 'usr_staff' })).body;
    await state.db.execute("UPDATE school_memberships SET status = 'disabled' WHERE user_id = 'usr_staff'");
    expect((await call(admin, 'GET', 'tasks', { query: { view: 'all' } })).body.items.find((item) => item.id === staffTask.id).owner).toBeNull();
    expect((await call(admin, 'GET', 'tasks/summary')).body.all.unassigned).toBe(2);
  });

  it('hides related names from people who cannot read that record, and links only visible records', async () => {
    const lead = (await newLead()).body;
    await call(admin, 'POST', 'tasks/reassign', {
      body: { taskId: (await call(admin, 'GET', 'tasks')).body.items[0].id, ownerUserId: 'usr_teacher', expectedVersion: 1 },
    });
    const seen = (await call(teacher, 'GET', 'tasks')).body.items[0];
    expect(seen.related).toEqual({ type: 'lead', id: lead.id, name: null, restricted: true });
    expect(JSON.stringify(seen)).not.toContain('98200');
    expect((await newTask(teacher, { related: { type: 'lead', id: lead.id } })).statusCode).toBe(403);
    expect((await call(teacher, 'GET', 'tasks', { query: { relatedType: 'lead', relatedId: lead.id } })).statusCode).toBe(403);

    const studentTask = await newTask(teacher, { related: { type: 'student', id: 'stu_a' } });
    expect(studentTask.body.related).toEqual({ type: 'student', id: 'stu_a', name: 'Riya', restricted: false });
    expect((await newTask(admin, { related: { type: 'student', id: 'stu_b' } })).statusCode).toBe(404);
    expect((await newTask(admin, { related: { type: 'lead', id: 'lead_missing' } })).statusCode).toBe(404);
  });

  it('counts overdue, today and upcoming for the badge and the dashboard', async () => {
    await newTask(admin, { dueAt: inHours(-2) });
    await newTask(admin, { dueAt: inHours(24 * 5) });
    await newTask(teacher, { dueAt: inHours(-1) });
    const summary = (await call(admin, 'GET', 'tasks/summary')).body;
    expect(summary).toEqual(expect.objectContaining({ timezone: 'Asia/Kolkata', scope: 'school' }));
    expect(summary.mine).toEqual({ overdue: 1, today: 0, upcoming: 1 });
    expect(summary.all).toEqual({ overdue: 2, today: 0, upcoming: 1, unassigned: 0 });
  });

  it('moves a lead\'s open tasks with its owner only when asked, atomically', async () => {
    await grant('usr_staff', ['crm.access', 'crm.leads.read', 'crm.leads.write', 'crm.tasks.read', 'crm.tasks.write']);
    const lead = (await newLead()).body;
    expect((await call(admin, 'GET', 'leads/detail', { query: { leadId: lead.id } })).body.ownerOpenTaskCount).toBe(1);

    const stale = await call(admin, 'POST', 'leads/owner', { body: { leadId: lead.id, ownerUserId: 'usr_staff', expectedVersion: 9, moveOpenTasks: true } });
    expect(stale.statusCode).toBe(409);
    expect((await call(admin, 'GET', 'tasks')).body.items).toHaveLength(1);

    const moved = await call(admin, 'POST', 'leads/owner', { body: { leadId: lead.id, ownerUserId: 'usr_staff', expectedVersion: 1, moveOpenTasks: true } });
    expect(moved.body).toEqual(expect.objectContaining({ movedTaskCount: 1, owner: { userId: 'usr_staff', name: 'Staff A' } }));
    expect((await call(admin, 'GET', 'tasks')).body.items).toEqual([]);
    const staffTasks = (await call(staff, 'GET', 'tasks')).body.items;
    expect(staffTasks).toHaveLength(1);
    expect(await events(staffTasks[0].id)).toEqual([['created', null, 'usr_admin'], ['reassigned', 'usr_admin', 'usr_staff']]);

    // Without the flag the tasks stay where they are.
    const kept = await call(admin, 'POST', 'leads/owner', { body: { leadId: lead.id, ownerUserId: 'usr_admin', expectedVersion: 2 } });
    expect(kept.body.movedTaskCount).toBe(0);
    expect((await call(staff, 'GET', 'tasks')).body.items).toHaveLength(1);
  });

  it('refuses to move tasks to a lead owner who has no task access', async () => {
    await grant('usr_staff', ['crm.access', 'crm.leads.read', 'crm.leads.write']);
    const lead = (await newLead()).body;
    const res = await call(admin, 'POST', 'leads/owner', { body: { leadId: lead.id, ownerUserId: 'usr_staff', expectedVersion: 1, moveOpenTasks: true } });
    expect(res.statusCode).toBe(422);
    expect(res.body.error.code).toBe('invalid_owner');
  });

  it('keeps tasks inside their school', async () => {
    const task = (await newTask(admin)).body;
    expect((await call(otherAdmin, 'GET', 'tasks', { query: { view: 'all' } })).body.items).toEqual([]);
    expect((await call(otherAdmin, 'POST', 'tasks/complete', { body: { taskId: task.id, expectedVersion: 1 } })).statusCode).toBe(404);
    expect((await call(otherAdmin, 'POST', 'tasks/reassign', { body: { taskId: task.id, ownerUserId: 'usr_admin_b', expectedVersion: 1 } })).statusCode).toBe(404);
    expect((await newTask(otherAdmin, { ownerUserId: 'usr_admin' })).statusCode).toBe(422);
    expect((await call(otherAdmin, 'GET', 'tasks/summary')).body.all).toEqual({ overdue: 0, today: 0, upcoming: 0, unassigned: 0 });
    expect((await newTask(admin, { schoolId: 'sch_b' })).statusCode).toBe(422);
  });

  it('keeps students and grant-less staff out of tasks', async () => {
    expect((await call(staff, 'GET', 'tasks')).statusCode).toBe(403);
    expect((await call({ ...staff, role: 'student', user_id: 'usr_s' }, 'GET', 'tasks')).statusCode).toBe(403);
  });
});
