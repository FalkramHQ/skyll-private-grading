// @vitest-environment node
// /api/query: scoping by canonical school id, canonical scores, and upstream
// failures that never leak to the client. Real SQL runs on an in-memory
// database with the production schema; only the LLM call is stubbed.
import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSchemaDatabase } from './helpers/schemaDatabase.js';

const state = vi.hoisted(() => ({ db: null, user: null, requireUserError: null }));

vi.mock('@libsql/client/web', () => ({
  createClient: () => ({ execute: (...args) => state.db.execute(...args) }),
}));
vi.mock('../../api/_lib/env.js', () => ({ tursoUrl: 'file:nl-query', tursoAuthToken: 'token' }));
vi.mock('../../api/_lib/auth.js', () => ({
  ensureAuthTables: async () => {},
  requireUser: async () => {
    if (state.requireUserError) throw state.requireUserError;
    return state.user;
  },
}));
vi.mock('../../api/_lib/cors.js', () => ({ handleCors: () => false }));
vi.mock('../../api/_lib/rateLimit.js', () => ({ checkRateLimit: async () => false }));

const { default: handler } = await import('../../api/query.js');
const { resetSchoolCache } = await import('../../api/_lib/canonicalSubmissions.js');

const T = '2026-09-01T10:00:00.000Z';
const teacher = (schoolId, name) => ({ username: `teacher_${schoolId}`, role: 'teacher', school: name, school_id: schoolId });

function response() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function llmReturns(filter) {
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(filter) } }] }),
    text: async () => '',
  }));
}

async function ask(body) {
  const res = response();
  await handler({ method: 'POST', query: {}, body: { q: 'show physics scores', ...body }, headers: {} }, res);
  return res;
}

async function seed(db) {
  const statements = [];
  for (const [key, schoolId, name] of [['a', 'sch_a', 'Alpha Academy'], ['b', 'sch_b', 'Beta Institute']]) {
    statements.push(
      ['INSERT INTO schools (id, slug, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [schoolId, `slug-${key}`, name, 'active', T, T]],
      ['INSERT INTO subjects (id, school_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [`subj_${key}`, schoolId, 'Physics', T, T]],
      ['INSERT INTO students (id, school, school_id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [`stu_${key}`, name, schoolId, `Student ${key.toUpperCase()}`, T, T]],
      ['INSERT INTO exams (id, school_id, subject_id, academic_year_id, name, exam_date, grade, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [`exam_${key}`, schoolId, `subj_${key}`, 'ay', `Unit test ${key}`, '2026-09-01', '9th', 'delivered', T, T]],
      // Canonical score 9/10; the report payload still carries a stale 2/10.
      ['INSERT INTO submissions (id, exam_id, student_id, status, score, max_marks, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [`sub_${key}`, `exam_${key}`, `stu_${key}`, 'graded', 9, 10, T, T]],
      ['INSERT INTO report_versions (id, submission_id, version, status, generated_at, published_at, payload_json, school, exam_id) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)', [`rv_${key}`, `sub_${key}`, 'published', T, T, JSON.stringify({ student: { name: 'Stale' }, term1: { subjects: [{ name: 'Physics', score: 2, total: 10 }] } }), name, `exam_${key}`]],
    );
  }
  // An unpublished submission is not listed.
  statements.push(['INSERT INTO submissions (id, exam_id, student_id, status, score, max_marks, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', ['sub_a_draft', 'exam_a', 'stu_a_draft', 'processing', 1, 10, T, T]]);
  await db.batch(statements.map(([sql, args]) => ({ sql, args })), 'write');
}

describe('/api/query', () => {
  beforeEach(async () => {
    resetSchoolCache();
    state.db = await createSchemaDatabase();
    await seed(state.db);
    state.requireUserError = null;
    state.user = teacher('sch_a', 'Alpha Academy');
    process.env.OPENROUTER_API_KEY = 'test-key';
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("returns canonical scores from the actor's school only", async () => {
    llmReturns({ subject: 'Physics', limit: 37 });
    const res = await ask();
    expect(res.statusCode).toBe(200);
    expect(res.body.results).toEqual([{
      studentName: 'Student A', standard: '9th', subject: 'Physics', examName: 'Unit test a',
      examDate: '2026-09-01', examType: 'subjective', score: 9, maxMarks: 10, pct: 90,
    }]);
  });

  it('applies score filters to the canonical score', async () => {
    llmReturns({ performance_band: 'top', limit: 38 });
    const res = await ask();
    expect(res.body.results.map((row) => row.studentName)).toEqual(['Student A']);
  });

  it('scopes a platform admin to their session school, never to every school', async () => {
    llmReturns({ limit: 39 });
    state.user = { username: 'sky', role: 'skyll_admin', school: 'Skyll HQ', school_id: 'sch_platform' };
    const res = await ask();
    expect(res.statusCode).toBe(200);
    expect(res.body.results).toEqual([]);
  });

  it('lets a platform admin name a school, resolved to its canonical id', async () => {
    llmReturns({ limit: 40 });
    state.user = { username: 'sky', role: 'skyll_admin', school: 'Skyll HQ', school_id: 'sch_platform' };
    const res = await ask({ school: 'Beta Institute' });
    expect(res.body.results.map((row) => row.studentName)).toEqual(['Student B']);
    const unknown = await ask({ school: 'Nowhere' });
    expect(unknown.statusCode).toBe(404);
  });

  it('ignores a school named by anyone other than platform staff', async () => {
    llmReturns({ limit: 41 });
    const res = await ask({ school: 'Beta Institute' });
    expect(res.body.results.map((row) => row.studentName)).toEqual(['Student A']);
  });

  it('refuses a session without a school id', async () => {
    llmReturns({});
    state.user = { username: 't', role: 'teacher', school: 'Alpha Academy' };
    const res = await ask();
    expect(res.statusCode).toBe(404);
  });

  it('logs the upstream error body but returns a generic message', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 401, text: async () => 'sk-or-secret-detail', json: async () => ({}) }));
    const res = await ask();
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ error: 'Query translation failed' });
    expect(JSON.stringify(res.body)).not.toContain('secret');
    expect(console.error).toHaveBeenCalled();
  });

  it('bounds the upstream call with a timeout and answers 504 when it fires', async () => {
    let signal;
    globalThis.fetch = vi.fn(async (_url, init) => {
      signal = init.signal;
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    const res = await ask();
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(res.statusCode).toBe(504);
    expect(res.body).toEqual({ error: 'Query translation timed out' });
  });

  it('routes authentication failures through the internal error handler', async () => {
    state.requireUserError = new Error('db unreachable');
    const res = await ask();
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toMatch(/^An internal error occurred\. Reference: /);
  });
});
