// Runs the real migration 059 on a temporary SQLite file so triggers, partial
// unique indexes, and `changes()`-gated audit inserts are exercised for real.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';

const require = createRequire(import.meta.url);
const { statements: migration059 } = require('../../../scripts/migrations/059_crm_access_audit.cjs');

const state = vi.hoisted(() => ({ db: null }));
const auth = vi.hoisted(() => ({
  database: vi.fn(() => state.db),
  sessionForRequest: vi.fn(),
}));
const flags = vi.hoisted(() => ({ isSchoolFeatureEnabled: vi.fn(async () => true) }));
vi.mock('../../../api/_lib/auth.js', () => auth);
vi.mock('../../../api/_lib/featureFlags.js', () => flags);

const { handleCrmRequest } = await import('../../../server/crm/router.js');

const A = 'sch_a';
const B = 'sch_b';
const admin = { user_id: 'usr_admin', username: 'a_admin', role: 'admin', school_id: A, school: 'School A' };
const staff = { user_id: 'usr_staff', username: 'a_staff', role: 'staff', school_id: A, school: 'School A' };
const teacher = { user_id: 'usr_teacher', username: 'a_teacher', role: 'teacher', school_id: A, school: 'School A' };
const platform = { user_id: 'usr_platform', username: 'skyll', role: 'skyll_admin', school_id: 'sch_platform', school: null };

let dir;

async function call(actor, method, segments, { body, query = {}, headers = {} } = {}) {
  auth.sessionForRequest.mockResolvedValue(actor);
  const res = {
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  await handleCrmRequest({ method, headers, query, body }, res, segments.split('/'));
  return res;
}

async function auditRows() {
  return (await state.db.execute('SELECT action, actor_role, entity_id, summary_json FROM crm_audit_events ORDER BY created_at, rowid')).rows;
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'crm-access-'));
});

afterAll(async () => {
  state.db?.close();
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  state.db?.close();
  state.db = createClient({ url: `file:${path.join(dir, `${Date.now()}-${Math.random()}.db`)}` });
  const now = '2026-09-24T09:00:00.000Z';
  await state.db.batch([
    "CREATE TABLE schools (id TEXT PRIMARY KEY, display_name TEXT, status TEXT, timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata')",
    "CREATE TABLE users (id TEXT PRIMARY KEY, display_name TEXT, status TEXT)",
    "CREATE TABLE school_memberships (id TEXT PRIMARY KEY, school_id TEXT, user_id TEXT, role TEXT, status TEXT)",
    "CREATE TABLE user_credentials (id TEXT PRIMARY KEY, user_id TEXT, login_id TEXT, is_primary INTEGER, status TEXT)",
    ...migration059,
    { sql: "INSERT INTO schools (id, display_name, status) VALUES (?, 'School A', 'active'), (?, 'School B', 'active')", args: [A, B] },
    "INSERT INTO users VALUES ('usr_admin','Admin A','active'),('usr_staff','Staff A','active'),('usr_teacher','Teacher A','active'),('usr_student','Student A','active'),('usr_staff_b','Staff B','active')",
    { sql: `INSERT INTO school_memberships VALUES
        ('m1', ?, 'usr_admin', 'school_admin', 'active'), ('m2', ?, 'usr_staff', 'staff', 'active'),
        ('m3', ?, 'usr_teacher', 'teacher', 'active'), ('m4', ?, 'usr_student', 'student', 'active'),
        ('m5', ?, 'usr_staff_b', 'staff', 'active')`, args: [A, A, A, A, B] },
    "INSERT INTO user_credentials VALUES ('c1','usr_staff','a_staff',1,'active')",
  ], 'write');
  void now;
});

describe('CRM grants and audit (real SQLite)', () => {
  it('lets an admin grant the Finance preset; staff then see only Overview and Fees', async () => {
    expect((await call(staff, 'GET', 'me')).statusCode).toBe(403);

    const granted = await call(admin, 'POST', 'permissions/grants', { body: { userId: 'usr_staff', preset: 'finance' } });
    expect(granted.statusCode).toBe(200);
    expect(granted.body.grants).toEqual(['crm.access', 'crm.contacts.read', 'crm.finance.read', 'crm.finance.write', 'crm.students.read']);

    const me = await call(staff, 'GET', 'me');
    expect(me.statusCode).toBe(200);
    expect(me.body.sections).toEqual(['overview', 'students', 'fees']);

    const audit = await auditRows();
    expect(audit).toHaveLength(5);
    expect(audit.every((row) => row.action === 'permission.granted' && row.actor_role === 'admin' && row.entity_id === 'usr_staff')).toBe(true);
    expect(JSON.parse(audit[0].summary_json)).toEqual(expect.objectContaining({ preset: 'finance' }));
  });

  it('writes no duplicate grants or audit rows when a grant is repeated', async () => {
    await call(admin, 'POST', 'permissions/grants', { body: { userId: 'usr_staff', capabilities: ['crm.access'] } });
    await call(admin, 'POST', 'permissions/grants', { body: { userId: 'usr_staff', capabilities: ['crm.access'] } });
    const grants = await state.db.execute("SELECT COUNT(*) AS n FROM crm_capability_grants WHERE user_id = 'usr_staff'");
    expect(Number(grants.rows[0].n)).toBe(1);
    expect(await auditRows()).toHaveLength(1);
  });

  it('revokes, keeps the history row, and audits only real changes', async () => {
    await call(admin, 'POST', 'permissions/grants', { body: { userId: 'usr_staff', capabilities: ['crm.access', 'crm.finance.read'] } });
    const revoked = await call(admin, 'POST', 'permissions/revoke', { body: { userId: 'usr_staff', capability: 'crm.finance.read' } });
    expect(revoked.body.grants).toEqual(['crm.access']);
    await call(admin, 'POST', 'permissions/revoke', { body: { userId: 'usr_staff', capability: 'crm.finance.read' } });

    const rows = await state.db.execute("SELECT capability, revoked_at FROM crm_capability_grants WHERE user_id = 'usr_staff' ORDER BY capability");
    expect(rows.rows.map((row) => [row.capability, Boolean(row.revoked_at)])).toEqual([['crm.access', false], ['crm.finance.read', true]]);
    expect((await auditRows()).map((row) => row.action)).toEqual(['permission.granted', 'permission.granted', 'permission.revoked']);

    const me = await call(staff, 'GET', 'me');
    expect(me.body.sections).toEqual(['overview']);
  });

  it('refuses grants across schools (404), to students (422), and without permission (403)', async () => {
    expect((await call(admin, 'POST', 'permissions/grants', { body: { userId: 'usr_staff_b', preset: 'finance' } })).statusCode).toBe(404);
    const student = await call(admin, 'POST', 'permissions/grants', { body: { userId: 'usr_student', preset: 'finance' } });
    expect(student.statusCode).toBe(422);
    expect(student.body.error.code).toBe('not_grantable');
    expect((await call(staff, 'POST', 'permissions/grants', { body: { userId: 'usr_staff', preset: 'finance' } })).statusCode).toBe(403);
    expect((await call(admin, 'POST', 'permissions/grants', { body: { userId: 'usr_staff' } })).statusCode).toBe(422);
    expect(await auditRows()).toHaveLength(0);
  });

  it('never lets a grantee hand out access they do not hold', async () => {
    await call(admin, 'POST', 'permissions/grants', { body: { userId: 'usr_staff', capabilities: ['crm.access', 'crm.permissions.manage'] } });
    const escalate = await call(staff, 'POST', 'permissions/grants', { body: { userId: 'usr_teacher', capabilities: ['crm.finance.read'] } });
    expect(escalate.statusCode).toBe(403);
    const allowed = await call(staff, 'POST', 'permissions/grants', { body: { userId: 'usr_teacher', capabilities: ['crm.access'] } });
    expect(allowed.statusCode).toBe(200);
  });

  it('never lets own-records access be widened school-wide by its holder', async () => {
    await call(admin, 'POST', 'permissions/grants', { body: { userId: 'usr_teacher', capabilities: ['crm.access', 'crm.permissions.manage'] } });
    const widen = await call(teacher, 'POST', 'permissions/grants', { body: { userId: 'usr_teacher', capabilities: ['crm.tasks.write'] } });
    expect(widen.statusCode).toBe(403);
    const grants = await state.db.execute("SELECT capability FROM crm_capability_grants WHERE user_id = 'usr_teacher' AND capability = 'crm.tasks.write'");
    expect(grants.rows).toHaveLength(0);
  });

  it('blocks UPDATE and DELETE on audit events, even directly in SQL', async () => {
    await call(admin, 'POST', 'permissions/grants', { body: { userId: 'usr_staff', capabilities: ['crm.access'] } });
    await expect(state.db.execute("UPDATE crm_audit_events SET action = 'x'")).rejects.toThrow(/append-only/);
    await expect(state.db.execute('DELETE FROM crm_audit_events')).rejects.toThrow(/append-only/);
    await state.db.execute("DELETE FROM crm_capability_grants WHERE user_id = 'usr_staff'");
    expect(await auditRows()).toHaveLength(1);
  });

  it('replays an idempotent request and rejects a reused key with a different body', async () => {
    const headers = { 'idempotency-key': 'grant-key-0001' };
    const first = await call(admin, 'POST', 'permissions/grants', { headers, body: { userId: 'usr_staff', capabilities: ['crm.access'] } });
    await state.db.execute("UPDATE crm_capability_grants SET revoked_at = 'x' WHERE user_id = 'usr_staff'");
    const replay = await call(admin, 'POST', 'permissions/grants', { headers, body: { userId: 'usr_staff', capabilities: ['crm.access'] } });
    expect(replay.body).toEqual(first.body);
    expect(await auditRows()).toHaveLength(1);
    const mismatch = await call(admin, 'POST', 'permissions/grants', { headers, body: { userId: 'usr_staff', capabilities: ['crm.finance.read'] } });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.body.error.code).toBe('idempotency_mismatch');
  });

  it('pages the audit log newest first, scoped to the school', async () => {
    for (const cap of ['crm.access', 'crm.students.read', 'crm.tasks.read']) {
      await call(admin, 'POST', 'permissions/grants', { body: { userId: 'usr_staff', capabilities: [cap] } });
    }
    const first = await call(admin, 'GET', 'audit', { query: { limit: '2' } });
    expect(first.statusCode).toBe(200);
    expect(first.body.items.map((item) => item.summary.capability)).toEqual(['crm.tasks.read', 'crm.students.read']);
    expect(first.body.items[0].actor).toEqual({ userId: 'usr_admin', name: 'Admin A', role: 'admin' });
    const second = await call(admin, 'GET', 'audit', { query: { limit: '2', cursor: first.body.nextCursor } });
    expect(second.body.items.map((item) => item.summary.capability)).toEqual(['crm.access']);
    expect(second.body.nextCursor).toBe(null);
    expect((await call(admin, 'GET', 'audit', { query: { cursor: 'garbage' } })).statusCode).toBe(422);
    expect((await call(admin, 'GET', 'audit', { query: { limit: '500' } })).statusCode).toBe(422);
    expect((await call(staff, 'GET', 'audit')).statusCode).toBe(403);
  });

  it('records one support.session per window when platform staff open a school', async () => {
    const headers = { 'x-skyll-school': A };
    await call(platform, 'GET', 'me', { headers });
    await call(platform, 'GET', 'me', { headers });
    await call(platform, 'POST', 'permissions/grants', { headers, body: { userId: 'usr_staff', capabilities: ['crm.access'] } });
    const audit = await auditRows();
    expect(audit.map((row) => row.action)).toEqual(['support.session', 'permission.granted']);
    expect(audit.every((row) => row.actor_role === 'skyll_admin')).toBe(true);
  });

  it('lists teachers and staff with defaults, grants, and presets', async () => {
    await call(admin, 'POST', 'permissions/grants', { body: { userId: 'usr_staff', preset: 'front_desk' } });
    const team = await call(admin, 'GET', 'permissions/team');
    expect(team.statusCode).toBe(200);
    expect(team.body.items.map((member) => [member.userId, member.role])).toEqual([['usr_staff', 'staff'], ['usr_teacher', 'teacher']]);
    expect(team.body.items[0].username).toBe('a_staff');
    expect(team.body.items[0].grants).toContain('crm.leads.write');
    expect(team.body.items[1].defaults).toContain('crm.students.read');
    expect(team.body.presets.map((preset) => preset.key)).toEqual(['admissions', 'finance', 'front_desk']);
  });
});
