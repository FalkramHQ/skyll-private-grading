import { beforeEach, describe, expect, it, vi } from 'vitest';

const fakeClient = vi.hoisted(() => ({
  execute: vi.fn(),
  batch: vi.fn().mockResolvedValue({}),
}));

const env = vi.hoisted(() => ({ tursoUrl: 'file:/tmp/vl-queue-test.db', tursoAuthToken: 'token' }));

const auth = vi.hoisted(() => ({
  ensureAuthTables: vi.fn().mockResolvedValue(),
  requireUser: vi.fn(),
  schoolMatches: vi.fn((actual, expected) => actual === expected),
}));

const cors = vi.hoisted(() => ({ handleCors: vi.fn(() => false) }));

const canonical = vi.hoisted(() => ({ resolveSchoolId: vi.fn() }));

const cohortRegrade = vi.hoisted(() => ({
  applyFeedbackToQuestion: vi.fn((snapshot) => snapshot),
  buildQuestionSnapshot: vi.fn(),
  COHORT_REGRADE_WORKFLOW_VERSION: 'test',
  generateQuestionFeedback: vi.fn(),
  parseJson: vi.fn((value, fallback = {}) => {
    try { return JSON.parse(value); } catch { return fallback; }
  }),
  publishSubmissionReport: vi.fn(),
  refreshTeacherReportModules: vi.fn(),
}));

const reviewerEdit = vi.hoisted(() => ({ editAnswerEvidence: vi.fn() }));
const harshZero = vi.hoisted(() => ({
  withHarshZeroTag: vi.fn((item) => item),
  resolveGradingLanguage: vi.fn(),
}));
const gradeResult = vi.hoisted(() => ({ parseMcqMarkScheme: vi.fn() }));
const answerSheetAssets = vi.hoisted(() => ({ indexIntakeAnswerSheetAssets: vi.fn() }));

vi.mock('@libsql/client/web', () => ({ createClient: vi.fn(() => fakeClient) }));
vi.mock('../../api/_lib/env.js', () => env);
vi.mock('../../api/_lib/auth.js', () => auth);
vi.mock('../../api/_lib/cors.js', () => cors);
vi.mock('../../api/_lib/canonicalSubmissions.js', () => canonical);
vi.mock('../../api/_lib/cohortRegrade.js', () => cohortRegrade);
vi.mock('../../api/_lib/reviewerEditService.js', () => reviewerEdit);
vi.mock('../../shared/harshZero.js', () => harshZero);
vi.mock('../../apps/processing-worker/gradeResult.js', () => gradeResult);
vi.mock('../../api/_lib/answerSheetAssets.js', () => answerSheetAssets);

import handler from '../../api/vl-queue.js';

function response() {
  const res = {
    statusCode: null,
    body: null,
    headers: {},
    setHeader: vi.fn(function setHeader(k, v) { this.headers[k] = v; return this; }),
    status: vi.fn(function status(code) { this.statusCode = code; return this; }),
    json: vi.fn(function json(data) { this.body = data; return this; }),
    end: vi.fn(),
  };
  return res;
}

function fakeReq(method, body = {}, query = {}) {
  return { method, body, query };
}

describe('vl-queue HTTP handler authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeClient.execute.mockImplementation(async () => ({ rows: [] }));
    canonical.resolveSchoolId.mockImplementation(async (_db, name) => {
      if (name === 'Alpha School') return 'school_a';
      if (name === 'Beta School') return 'school_b';
      return null;
    });
  });

  it('stops when authentication fails with 401 and performs no queries', async () => {
    auth.requireUser.mockImplementationOnce(async (_req, res) => {
      res.status(401).json({ error: 'Sign in required' });
      return null;
    });
    const res = response();
    await handler(fakeReq('POST', { action: 'get-cohort-regrade', runId: 'run_a' }), res);
    expect(res.statusCode).toBe(401);
    expect(fakeClient.execute).not.toHaveBeenCalled();
  });

  describe('get-cohort-regrade', () => {
    function seedRun(scopeJson) {
      fakeClient.execute.mockImplementation(async ({ sql }) => {
        if (sql.includes('FROM regrade_runs')) {
          return { rows: [{ id: 'run_a', scope: scopeJson, status: 'running', requested_by: 'admin_a', requested_at: '2026-01-01T00:00:00.000Z', question_count: 1, student_count: 1 }] };
        }
        return { rows: [] };
      });
    }

    it('derives the run school from scope so same-school admins can read their own runs', async () => {
      seedRun(JSON.stringify({ school: 'Alpha School', test_id: 'test_a', subject: 'Physics', grade: '12th' }));
      auth.requireUser.mockResolvedValueOnce({ username: 'admin_a', role: 'admin', school: 'Alpha School', school_id: 'school_a' });

      const res = response();
      await handler(fakeReq('POST', { action: 'get-cohort-regrade', runId: 'run_a' }), res);

      expect(res.statusCode).toBe(200);
      expect(res.body.status).toBe('running');
    });

    it('rejects a cross-school admin before returning run data', async () => {
      seedRun(JSON.stringify({ school: 'Alpha School' }));
      auth.requireUser.mockResolvedValueOnce({ username: 'admin_b', role: 'admin', school: 'Beta School', school_id: 'school_b' });

      const res = response();
      await handler(fakeReq('POST', { action: 'get-cohort-regrade', runId: 'run_a' }), res);

      expect(res.statusCode).toBe(403);
      expect(res.body).toEqual({ error: 'School access denied' });
    });

    it('allows a skyll_admin to read any run', async () => {
      seedRun(JSON.stringify({ school: 'Beta School' }));
      auth.requireUser.mockResolvedValueOnce({ username: 'sky_admin', role: 'skyll_admin', school: '' });

      const res = response();
      await handler(fakeReq('POST', { action: 'get-cohort-regrade', runId: 'run_a' }), res);

      expect(res.statusCode).toBe(200);
    });

    it('returns 404 when the run does not exist', async () => {
      auth.requireUser.mockResolvedValueOnce({ username: 'admin_a', role: 'admin', school: 'Alpha School', school_id: 'school_a' });
      const res = response();
      await handler(fakeReq('POST', { action: 'get-cohort-regrade', runId: 'missing' }), res);
      expect(res.statusCode).toBe(404);
    });
  });

  describe('approve-cohort', () => {
    // Full behaviour (assessment scoping, pending-only, audit, count) is
    // covered against real SQLite in approve-all-student.test.js (FLKRM-96).
    it('rejects a cross-school admin before any write is performed', async () => {
      fakeClient.execute.mockImplementation(async ({ sql }) => {
        if (sql.includes('SELECT DISTINCT e.school_id AS school_id')) return { rows: [{ school_id: 'school_b' }] };
        return { rows: [] };
      });
      auth.requireUser.mockResolvedValueOnce({ username: 'admin_a', role: 'admin', school: 'Alpha School', school_id: 'school_a' });

      const res = response();
      await handler(fakeReq('POST', { action: 'approve-cohort', studentId: 'student_x', testId: 'test_1' }), res);

      expect(res.statusCode).toBe(403);
      expect(fakeClient.batch).not.toHaveBeenCalled();
    });

    it('allows a same-school admin and scopes every query to the selected assessment', async () => {
      const queries = [];
      fakeClient.execute.mockImplementation(async ({ sql, args }) => {
        queries.push({ sql, args });
        if (sql.includes('SELECT DISTINCT e.school_id AS school_id')) return { rows: [{ school_id: 'school_a' }] };
        return { rows: [] };
      });
      auth.requireUser.mockResolvedValueOnce({ username: 'admin_a', role: 'admin', school: 'Alpha School', school_id: 'school_a' });

      const res = response();
      await handler(fakeReq('POST', { action: 'approve-cohort', studentId: 'student_x', testId: 'test_1' }), res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({ ok: true, studentId: 'student_x', testId: 'test_1', approved: 0 });
      expect(queries.length).toBeGreaterThan(0);
      for (const { sql, args } of queries) {
        expect(sql).toContain('COALESCE(e.source_test_id, e.id) = ?');
        expect(args).toEqual(['student_x', 'test_1']);
      }
    });
  });

  describe('GET summary', () => {
    it('school-scopes the pending recheck query for a school admin', async () => {
      auth.requireUser.mockResolvedValueOnce({ username: 'admin_a', role: 'admin', school: 'Alpha School', school_id: 'school_a' });

      const recheckCalls = [];
      fakeClient.execute.mockImplementation(async ({ sql, args }) => {
        if (sql.includes('FROM recheck_requests')) {
          recheckCalls.push({ sql, args });
          return { rows: [] };
        }
        return { rows: [] };
      });

      const res = response();
      await handler(fakeReq('GET', {}, { summary: 'true' }), res);

      expect(res.statusCode).toBe(200);
      expect(recheckCalls.length).toBeGreaterThan(0);
      expect(recheckCalls[0].args).toEqual(['Alpha School', 'Alpha School']);
      expect(recheckCalls[0].sql).toContain('sc.display_name = ?');
    });

    it.each([
      ['summary', { summary: 'true' }, ''],
      ['summary', { summary: 'true' }, null],
      ['full list', {}, ''],
      ['full list', {}, '   '],
    ])('refuses a non-admin with no school (%s, school=%j) before any query (FLKRM-384)', async (_mode, query, school) => {
      auth.requireUser.mockResolvedValueOnce({ username: 'admin_x', role: 'admin', school });
      const res = response();
      await handler(fakeReq('GET', {}, query), res);
      expect(res.statusCode).toBe(403);
      const dataQueries = fakeClient.execute.mock.calls
        .filter(([arg]) => /FROM (recheck_requests|exams|submission_questions_v2)/.test(String(arg?.sql || arg)));
      expect(dataQueries).toEqual([]);
    });

    it("scopes a school admin by the session's school_id, not by resolving the name (FLKRM-385)", async () => {
      // The name would resolve to school_a; the pinned session id is school_b.
      auth.requireUser.mockResolvedValueOnce({ username: 'admin_b', role: 'admin', school: 'Alpha School', school_id: 'school_b' });
      const scoped = [];
      fakeClient.execute.mockImplementation(async ({ sql, args } = {}) => {
        if (String(sql).includes('e.school_id = ?')) scoped.push(args);
        return { rows: [] };
      });
      await handler(fakeReq('GET', {}, { summary: 'true' }), response());
      expect(canonical.resolveSchoolId).not.toHaveBeenCalled();
      expect(scoped.length).toBeGreaterThan(0);
      expect(scoped.every((args) => args.includes('school_b') && !args.includes('school_a'))).toBe(true);
    });

    it('still lets a skyll_admin choose a school by name', async () => {
      auth.requireUser.mockResolvedValueOnce({ username: 'sky', role: 'skyll_admin', school: 'Skyll', school_id: 'school_p' });
      await handler(fakeReq('GET', {}, { summary: 'true', school: 'Beta School' }), response());
      expect(canonical.resolveSchoolId).toHaveBeenCalledWith(expect.anything(), 'Beta School');
    });

    it('does not leak recheck data for a skyll_admin with no school filter', async () => {
      auth.requireUser.mockResolvedValueOnce({ username: 'sky_admin', role: 'skyll_admin', school: '' });

      const recheckCalls = [];
      fakeClient.execute.mockImplementation(async ({ sql, args }) => {
        if (sql.includes('FROM recheck_requests')) {
          recheckCalls.push({ sql, args });
          return { rows: [] };
        }
        return { rows: [] };
      });

      const res = response();
      await handler(fakeReq('GET', {}, { summary: 'true' }), res);

      expect(res.statusCode).toBe(200);
      expect(recheckCalls.length).toBeGreaterThan(0);
      expect(recheckCalls[0].args).toEqual(['', '']);
    });
  });

  describe('GET full list', () => {
    it('checks each distinct school once and never scans report payloads', async () => {
      auth.requireUser.mockResolvedValueOnce({ username: 'admin_a', role: 'admin', school: 'Alpha School', school_id: 'school_a' });
      const rows = Array.from({ length: 40 }, (_, index) => ({
        id: `q${index}`, school: index % 2 ? 'Alpha School' : 'Beta School', subject: 'Physics', test_id: 'test_a',
        student_id: `student_${index}`, question_number: 'Q1', data: '{}', review_status: 'pending',
      }));
      const queried = [];
      fakeClient.execute.mockImplementation(async ({ sql } = {}) => {
        queried.push(String(sql));
        return { rows: String(sql).includes('FROM submission_questions_v2 q') ? rows : [] };
      });

      const res = response();
      await handler(fakeReq('GET', {}, { testId: 'test_a' }), res);

      expect(res.statusCode).toBe(200);
      // The SQL scope already pins school_a; the name check runs per school, not per row.
      expect(canonical.resolveSchoolId).toHaveBeenCalledTimes(2);
      expect(res.body.items).toHaveLength(20);
      expect(res.body.items.every((item) => item.school === 'Alpha School')).toBe(true);
      expect(queried.some((sql) => sql.includes('rv.payload_json'))).toBe(false);
    });
  });

  describe('finalize-cohort', () => {
    const cohortBody = { action: 'finalize-cohort', school: 'Alpha School', subject: 'Physics', grade: '12th', testId: 'test_a' };

    function seedItems(rows) {
      fakeClient.batch.mockResolvedValue([]);
      fakeClient.execute.mockImplementation(async ({ sql }) => {
        if (sql.includes('FROM submission_questions_v2 q')) return { rows };
        return { rows: [] };
      });
    }

    it('blocks a same-school teacher while questions are still pending', async () => {
      seedItems([{ id: 'q1', review_status: 'pending' }, { id: 'q2', review_status: 'approved' }]);
      auth.requireUser.mockResolvedValueOnce({ username: 'teacher_a', role: 'teacher', school: 'Alpha School', school_id: 'school_a' });

      const res = response();
      await handler(fakeReq('POST', cohortBody), res);

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: '1 items still pending review' });
      expect(fakeClient.batch).not.toHaveBeenCalled();
    });

    it('allows a same-school admin to complete with pending questions by auto-approving them', async () => {
      seedItems([{ id: 'q1', review_status: 'pending' }, { id: 'q2', review_status: 'approved' }]);
      auth.requireUser.mockResolvedValueOnce({ username: 'admin_a', role: 'admin', school: 'Alpha School', school_id: 'school_a' });

      const res = response();
      await handler(fakeReq('POST', cohortBody), res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({ ok: true, status: 'finalized' });
      // Pending item auto-approved via canonical + legacy dual-write, with audit.
      expect(fakeClient.batch).toHaveBeenCalledTimes(1);
      const [statements] = fakeClient.batch.mock.calls[0];
      expect(statements).toHaveLength(3);
      expect(statements[0].sql).toContain('INSERT INTO question_reviews');
      expect(statements[0].sql).toContain("WHERE question_reviews.state = 'pending'");
      expect(statements[0].args[0]).toBe('q1');
      expect(statements[1].sql).toContain('INSERT INTO review_decisions');
      expect(statements[2].sql).toContain('INSERT INTO question_review_events');
    });

    it('allows a skyll_admin to complete with pending questions', async () => {
      seedItems([{ id: 'q1', review_status: 'pending' }]);
      auth.requireUser.mockResolvedValueOnce({ username: 'sky_admin', role: 'skyll_admin', school: '' });

      const res = response();
      await handler(fakeReq('POST', cohortBody), res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({ ok: true, status: 'finalized' });
      expect(fakeClient.batch).toHaveBeenCalledTimes(1);
    });

    it('scopes the question read and the exam update to the school id and test', async () => {
      seedItems([]);
      auth.requireUser.mockResolvedValueOnce({ username: 'admin_a', role: 'admin', school: 'Alpha School', school_id: 'school_a' });

      const res = response();
      await handler(fakeReq('POST', cohortBody), res);

      expect(res.statusCode).toBe(200);
      const scoped = fakeClient.execute.mock.calls.map(([arg]) => arg).filter((arg) => /submission_questions_v2|UPDATE exams/.test(arg.sql));
      expect(scoped).toHaveLength(2);
      for (const { sql, args } of scoped) {
        expect(sql).toContain('COALESCE');
        expect(sql).toContain("!= 'archived'");
        expect(args.slice(-2)).toEqual(['school_a', 'test_a']);
      }
    });

    it('finalizes without auto-approval when no questions are pending', async () => {
      seedItems([{ id: 'q1', review_status: 'approved' }]);
      auth.requireUser.mockResolvedValueOnce({ username: 'teacher_a', role: 'teacher', school: 'Alpha School', school_id: 'school_a' });

      const res = response();
      await handler(fakeReq('POST', cohortBody), res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({ ok: true, status: 'finalized' });
      expect(fakeClient.batch).not.toHaveBeenCalled();
    });
  });

  describe('mark-cohort-complete', () => {
    it('rejects a cross-school admin before counting or writing', async () => {
      auth.requireUser.mockResolvedValueOnce({ username: 'admin_b', role: 'admin', school: 'Beta School', school_id: 'school_b' });

      const res = response();
      await handler(fakeReq('POST', { action: 'mark-cohort-complete', school: 'Alpha School', testId: 'test_a' }), res);

      expect(res.statusCode).toBe(403);
      expect(fakeClient.execute).not.toHaveBeenCalled();
    });

    it('marks a same-school cohort and returns the overridden pending count', async () => {
      fakeClient.execute.mockImplementation(async ({ sql }) => {
        if (sql.includes('FROM submission_questions_v2')) return { rows: [{ pending: 4, changed: 1 }] };
        return { rows: [] };
      });
      auth.requireUser.mockResolvedValueOnce({ username: 'admin_a', role: 'admin', school: 'Alpha School', school_id: 'school_a' });

      const res = response();
      await handler(fakeReq('POST', { action: 'mark-cohort-complete', school: 'Alpha School', testId: 'test_a' }), res);

      expect(res.statusCode).toBe(201);
      expect(res.body).toMatchObject({ ok: true, school: 'Alpha School', testId: 'test_a', pending: 4, changedQuestions: 1, markedBy: 'admin_a' });
      expect(fakeClient.execute.mock.calls.some(([arg]) => arg.sql.includes('INSERT INTO cohort_completion_overrides'))).toBe(true);
    });
  });

  it('rejects unsupported actions with 400', async () => {
    auth.requireUser.mockResolvedValueOnce({ username: 'admin_a', role: 'admin', school: 'Alpha School', school_id: 'school_a' });
    const res = response();
    await handler(fakeReq('POST', { action: 'unknown-action' }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Unsupported action');
  });
});
