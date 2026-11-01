// FLKRM-382: /api/ai/hive pins non-admins to their own school and returns 404
// for a student outside it, instead of reading their data unscoped.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@libsql/client';

const state = vi.hoisted(() => ({ db: null, user: null }));
vi.mock('../../api/_lib/auth.js', () => ({
  database: () => state.db,
  ensureAuthTables: async () => {},
  requireUser: async (_req, res, roles) => {
    if (roles && !roles.includes(state.user.role)) { res.status(403).json({ error: 'forbidden' }); return null; }
    return state.user;
  },
}));
vi.mock('../../api/_lib/rateLimit.js', () => ({ checkRateLimit: async () => false }));
vi.mock('../../api/_lib/cors.js', () => ({ handleCors: () => false }));
vi.mock('../../api/_lib/featureFlags.js', () => ({ isSchoolFeatureEnabled: async () => true }));

const { getHive, postHiveSynthesize } = await import('../../server/ai/hive.js');

const teacherA = { user_id: 'u_ta', username: 'teach_a', role: 'teacher', school_id: 'sch_a', school: 'School A' };
const platform = { user_id: 'u_p', username: 'sky', role: 'skyll_admin', school_id: 'sch_p', school: 'Skyll' };

function response() {
  return {
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function call(handler, user, { method = 'GET', query = {}, body } = {}) {
  state.user = user;
  const res = response();
  await handler({ method, headers: {}, query, body }, res);
  return res;
}

beforeEach(async () => {
  state.db = createClient({ url: ':memory:' });
  await state.db.batch([
    'CREATE TABLE schools (id TEXT PRIMARY KEY, display_name TEXT)',
    'CREATE TABLE students (id TEXT PRIMARY KEY, school_id TEXT, display_name TEXT)',
    'CREATE TABLE user_credentials (id TEXT PRIMARY KEY, user_id TEXT, login_id TEXT, status TEXT, is_primary INTEGER)',
    'CREATE TABLE student_user_links (student_id TEXT, user_id TEXT)',
    'CREATE TABLE student_enrollments (student_id TEXT, academic_year_id TEXT, standard TEXT, status TEXT, updated_at TEXT)',
    'CREATE TABLE academic_years (id TEXT, school_id TEXT, is_current INTEGER)',
    'CREATE TABLE learner_dna_v2 (student_id TEXT PRIMARY KEY, school_id TEXT, dna_json TEXT, exam_count INTEGER, question_count INTEGER, updated_at TEXT)',
    'CREATE TABLE learner_dna (username TEXT PRIMARY KEY, dna_json TEXT, exam_count INTEGER, question_count INTEGER, updated_at TEXT)',
    'CREATE TABLE report_versions (id TEXT, username TEXT, school TEXT, submission_id TEXT, student_id TEXT, published_at TEXT, payload_json TEXT, status TEXT)',
    "INSERT INTO schools VALUES ('sch_a', 'School A'), ('sch_b', 'School B')",
    "INSERT INTO students VALUES ('stu_b', 'sch_b', 'Bina')",
    "INSERT INTO user_credentials VALUES ('c_b', 'u_b', 'bina', 'active', 1)",
    "INSERT INTO student_user_links VALUES ('stu_b', 'u_b')",
    `INSERT INTO learner_dna_v2 VALUES ('stu_b', 'sch_b', '{"primary_mode":{"mode_id":"b_mode"}}', 2, 4, 'x')`,
    `INSERT INTO learner_dna VALUES ('bina', '{"primary_mode":{"mode_id":"b_legacy"}}', 1, 1, 'x')`,
    "INSERT INTO report_versions VALUES ('rv_b', 'bina', 'School B', 'sub_b', 'stu_b', '2026-09-01', '{}', 'published')",
  ], 'write');
});

afterEach(() => state.db?.close());

describe('GET /api/ai/hive', () => {
  it("returns 404 for another school's student instead of their DNA and reports", async () => {
    const res = await call(getHive, teacherA, { query: { username: 'bina' } });
    expect(res.statusCode).toBe(404);
    expect(JSON.stringify(res.body)).not.toMatch(/b_mode|b_legacy|rv_b/);
  });

  it('ignores a non-admin schoolId pointing at another school', async () => {
    const res = await call(getHive, teacherA, { query: { username: 'bina', schoolId: 'sch_b' } });
    expect(res.statusCode).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('b_mode');
  });

  it('lets platform staff browse another school explicitly', async () => {
    const res = await call(getHive, platform, { query: { username: 'bina', schoolId: 'sch_b' } });
    expect(res.statusCode).toBe(200);
    expect(res.body.dna.primary_mode.mode_id).toBe('b_mode');
    expect(res.body.recentReports.map((r) => r.reportVersionId)).toEqual(['rv_b']);
  });
});

describe('POST /api/ai/hive/synthesize', () => {
  it("refuses another school's student by id or by a foreign schoolId", async () => {
    expect((await call(postHiveSynthesize, teacherA, { method: 'POST', body: { studentId: 'stu_b' } })).statusCode).toBe(404);
    expect((await call(postHiveSynthesize, teacherA, { method: 'POST', body: { studentId: 'stu_b', schoolId: 'sch_b' } })).statusCode).toBe(404);
  });
});
