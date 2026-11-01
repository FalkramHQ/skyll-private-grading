// FLKRM-381: parent-report links are public and serve the full report, so
// minting one must stay inside the caller's school. Real SQLite; only the session is mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@libsql/client';

const state = vi.hoisted(() => ({ db: null, user: null }));
vi.mock('../../api/_lib/auth.js', () => {
  return {
    database: () => state.db,
    ensureAuthTables: async () => {},
    requireUser: async (_req, res, roles) => {
      if (!state.user) { res.status(401).json({ error: 'Sign in required' }); return null; }
      if (roles && !roles.includes(state.user.role)) { res.status(403).json({ error: 'forbidden' }); return null; }
      return state.user;
    },
  };
});

const { default: reportHandler } = await import('../../server/parent/report.js');

const teacherA = { user_id: 'u_ta', role: 'teacher', school_id: 'sch_a', school: 'School A' };
const adminB = { user_id: 'u_ab', role: 'admin', school_id: 'sch_b', school: 'School B' };
const platform = { user_id: 'u_p', role: 'skyll_admin', school_id: 'sch_p', school: 'Skyll' };
const studentA = { user_id: 'u_sa', role: 'student', school_id: 'sch_a', school: 'School A' };

function response() {
  return {
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function call(user, handler, { method = 'POST', body = {}, query = {} } = {}) {
  state.user = user;
  const res = response();
  await handler({ method, headers: {}, query, body }, res);
  return res;
}

async function count(table) {
  const exists = await state.db.execute({ sql: "SELECT 1 FROM sqlite_master WHERE name = ?", args: [table] });
  if (!exists.rows.length) return 0;
  return Number((await state.db.execute(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n);
}

beforeEach(async () => {
  state.db = createClient({ url: ':memory:' });
  const payload = JSON.stringify({ student: { name: 'Asha', school: 'School A' }, overall: { score: 42 } });
  await state.db.batch([
    'CREATE TABLE schools (id TEXT PRIMARY KEY, display_name TEXT, slug TEXT)',
    "INSERT INTO schools (id, display_name) VALUES ('sch_a', 'School A'), ('sch_b', 'School B')",
    'CREATE TABLE students (id TEXT PRIMARY KEY, school_id TEXT, display_name TEXT)',
    'CREATE TABLE submissions (id TEXT PRIMARY KEY, student_id TEXT)',
    'CREATE TABLE report_versions (id TEXT PRIMARY KEY, submission_id TEXT, student_id TEXT, username TEXT, school TEXT, version INTEGER, status TEXT, payload_json TEXT, exam_id TEXT)',
    'CREATE TABLE exams (id TEXT PRIMARY KEY, released_at TEXT)',
    "INSERT INTO students VALUES ('stu_a', 'sch_a', 'Asha')",
    "INSERT INTO submissions VALUES ('sub_a', 'stu_a')",
    { sql: "INSERT INTO report_versions VALUES ('rv_a', 'sub_a', 'stu_a', 'asha', 'School A', 1, 'published', ?, NULL)", args: [payload] },
    // Legacy report with no resolvable student: scoped by its school name.
    { sql: "INSERT INTO report_versions VALUES ('rv_legacy', 'sub_legacy', NULL, 'old', 'School A', 1, 'published', ?, NULL)", args: [payload] },
  ], 'write');
});

afterEach(() => state.db?.close());

describe('POST /api/auth/parent (mint report link)', () => {
  it("refuses another school's submission and mints nothing", async () => {
    const res = await call(adminB, reportHandler, { body: { submissionId: 'sub_a' } });
    expect(res.statusCode).toBe(404);
    expect(res.body.token).toBeUndefined();
    expect(await count('parent_report_tokens')).toBe(0);
  });

  it('does not hand out an existing link to another school', async () => {
    expect((await call(teacherA, reportHandler, { body: { submissionId: 'sub_a' } })).statusCode).toBe(201);
    const res = await call(adminB, reportHandler, { body: { submissionId: 'sub_a' } });
    expect(res.statusCode).toBe(404);
    expect(res.body.token).toBeUndefined();
  });

  it('mints a working link for a same-school teacher', async () => {
    const minted = await call(teacherA, reportHandler, { body: { submissionId: 'sub_a' } });
    expect(minted.statusCode).toBe(201);
    const opened = await call(null, reportHandler, { method: 'GET', query: { token: minted.body.token } });
    expect(opened.statusCode).toBe(200);
    expect(opened.body.report).toEqual(expect.objectContaining({ studentName: 'Asha', overallScore: 42 }));
  });

  it('scopes a legacy report without a student by its school name', async () => {
    expect((await call(teacherA, reportHandler, { body: { submissionId: 'sub_legacy' } })).statusCode).toBe(201);
    expect((await call(adminB, reportHandler, { body: { submissionId: 'sub_legacy' } })).statusCode).toBe(404);
  });

  it('treats an unknown submission like a foreign one', async () => {
    expect((await call(teacherA, reportHandler, { body: { submissionId: 'sub_missing' } })).statusCode).toBe(404);
  });

  it('lets platform staff mint across schools, and keeps students out', async () => {
    expect((await call(platform, reportHandler, { body: { submissionId: 'sub_a' } })).statusCode).toBe(201);
    expect((await call(studentA, reportHandler, { body: { submissionId: 'sub_a' } })).statusCode).toBe(403);
  });
});
