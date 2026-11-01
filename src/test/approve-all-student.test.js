// FLKRM-96: "Approve all" approves every pending question for one student in
// one assessment, and nothing else. Real SQLite (recheck test schema); only the
// session, env and the heavy cohort-regrade module are mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRecheckTestDatabase, seedCanonicalQuestionStatements } from './helpers/recheckTestDatabase.js';

const state = vi.hoisted(() => ({ db: null, user: null }));
vi.mock('@libsql/client/web', () => ({
  // vl-queue builds its client at import; delegate to this test's database.
  createClient: () => ({
    execute: (...args) => state.db.execute(...args),
    batch: (...args) => state.db.batch(...args),
  }),
}));
vi.mock('../../api/_lib/env.js', () => ({ tursoUrl: 'file:approve-all-test', tursoAuthToken: 'token' }));
vi.mock('../../api/_lib/auth.js', () => ({
  ensureAuthTables: async () => {},
  requireUser: async (_req, res, roles) => {
    if (!state.user) { res.status(401).json({ error: 'Sign in required' }); return null; }
    if (roles && !roles.includes(state.user.role)) { res.status(403).json({ error: 'forbidden' }); return null; }
    return state.user;
  },
  schoolMatches: (a, b) => Boolean(a) && a === b,
}));
vi.mock('../../api/_lib/cors.js', () => ({ handleCors: () => false }));
vi.mock('../../api/_lib/cohortRegrade.js', () => ({
  applyFeedbackToQuestion: vi.fn(), buildQuestionSnapshot: vi.fn(), COHORT_REGRADE_WORKFLOW_VERSION: 'test',
  generateQuestionFeedback: vi.fn(), parseJson: (value, fallback = {}) => { try { return JSON.parse(value); } catch { return fallback; } },
  publishSubmissionReport: vi.fn(), refreshTeacherReportModules: vi.fn(),
}));

const { default: handler } = await import('../../api/vl-queue.js');

const adminA = { username: 'admin_a', role: 'admin', school: 'Alpha School', school_id: 'school_alpha' };
const teacherA = { username: 'teacher_a', role: 'teacher', school: 'Alpha School', school_id: 'school_alpha' };
const adminB = { username: 'admin_b', role: 'admin', school: 'Beta School', school_id: 'school_beta' };
const platform = { username: 'sky', role: 'skyll_admin', school: 'Skyll', school_id: 'school_platform' };
const TEST_A = 'test_exam_a';

let harness;

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

async function approveAll(user, body) {
  state.user = user;
  const res = response();
  await handler({ method: 'POST', headers: {}, query: {}, body: { action: 'approve-cohort', ...body } }, res);
  return res;
}

async function reviewState(questionId) {
  return (await harness.db.execute({ sql: 'SELECT state, revision, reviewer_id FROM question_reviews WHERE submission_question_id = ?', args: [questionId] })).rows[0] || null;
}

beforeEach(async () => {
  harness = await createRecheckTestDatabase();
  state.db = harness.db;
  const q = (questionId, examId, questionNumber, setQuestionId) => seedCanonicalQuestionStatements({
    questionId, submissionId: `sub_${examId}`, examId, setId: `set_${examId}`, setQuestionId, questionNumber, studentId: 'student_a',
  });
  await harness.db.batch([
    // Assessment A: Q1 and Q4 pending, Q2 already approved, Q3 flagged.
    ...q('qa1', 'exam_a', 'Q1', 'esq_a1'),
    ...q('qa2', 'exam_a', 'Q2', 'esq_a2'),
    ...q('qa3', 'exam_a', 'Q3', 'esq_a3'),
    ...q('qa4', 'exam_a', 'Q4', 'esq_a4'),
    // Assessment B for the same student: must never be touched.
    ...q('qb1', 'exam_b', 'Q1', 'esq_b1'),
    "INSERT INTO question_reviews (submission_question_id, state, reviewer_id, revision, approved_at, updated_at) VALUES ('qa2', 'approved', 'someone', 3, 'earlier', 'earlier')",
    "INSERT INTO question_reviews (submission_question_id, state, reviewer_id, revision, updated_at) VALUES ('qa3', 'flagged', 'someone', 1, 'earlier')",
    "INSERT INTO question_reviews (submission_question_id, state, reviewer_id, revision, updated_at) VALUES ('qa4', 'pending', NULL, 1, 'earlier')",
  ].map((statement) => (typeof statement === 'string' ? { sql: statement } : statement)), 'write');
});

afterEach(async () => {
  await harness?.close();
});

describe('Approve all for a student (FLKRM-96)', () => {
  it('approves only pending questions in the selected assessment and reports the count', async () => {
    const res = await approveAll(adminA, { studentId: 'student_a', testId: TEST_A });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, studentId: 'student_a', testId: TEST_A, approved: 2 });

    expect(await reviewState('qa1')).toMatchObject({ state: 'approved', reviewer_id: 'admin_a', revision: 1 });
    expect(await reviewState('qa4')).toMatchObject({ state: 'approved', reviewer_id: 'admin_a', revision: 2 });
    // Already approved and flagged questions are left exactly as they were.
    expect(await reviewState('qa2')).toMatchObject({ state: 'approved', reviewer_id: 'someone', revision: 3 });
    expect(await reviewState('qa3')).toMatchObject({ state: 'flagged', reviewer_id: 'someone', revision: 1 });
    // The student's other assessment is untouched.
    expect(await reviewState('qb1')).toBeNull();

    // Legacy mirror and audit trail, one per newly approved question.
    const mirrored = (await harness.db.execute("SELECT submission_question_id FROM review_decisions WHERE state = 'approved' ORDER BY 1")).rows.map((r) => r.submission_question_id);
    expect(mirrored).toEqual(['qa1', 'qa4']);
    const events = (await harness.db.execute("SELECT submission_question_id, actor_user_id, event_type FROM question_review_events ORDER BY 1")).rows;
    expect(events).toEqual([
      { submission_question_id: 'qa1', actor_user_id: 'admin_a', event_type: 'review_decided' },
      { submission_question_id: 'qa4', actor_user_id: 'admin_a', event_type: 'review_decided' },
    ]);
  });

  it('is a no-op once nothing is pending', async () => {
    await approveAll(adminA, { studentId: 'student_a', testId: TEST_A });
    const again = await approveAll(adminA, { studentId: 'student_a', testId: TEST_A });
    expect(again.body.approved).toBe(0);
    expect((await harness.db.execute('SELECT COUNT(*) AS n FROM question_review_events')).rows[0].n).toBe(2);
  });

  it('requires the assessment, so it can never approve across tests', async () => {
    const res = await approveAll(adminA, { studentId: 'student_a' });
    expect(res.statusCode).toBe(400);
    expect((await harness.db.execute("SELECT COUNT(*) AS n FROM question_reviews WHERE state = 'approved'")).rows[0].n).toBe(1);
  });

  it('is admin-only: a teacher is refused without any write', async () => {
    const res = await approveAll(teacherA, { studentId: 'student_a', testId: TEST_A });
    expect(res.statusCode).toBe(403);
    expect(await reviewState('qa1')).toBeNull();
  });

  it("refuses another school's admin without any write, and allows platform staff", async () => {
    const res = await approveAll(adminB, { studentId: 'student_a', testId: TEST_A });
    expect(res.statusCode).toBe(403);
    expect(await reviewState('qa1')).toBeNull();

    const platformRes = await approveAll(platform, { studentId: 'student_a', testId: TEST_A });
    expect(platformRes.body.approved).toBe(2);
  });

  it('returns 404 for a student with no questions in that assessment', async () => {
    expect((await approveAll(adminA, { studentId: 'student_a', testId: 'test_missing' })).statusCode).toBe(404);
    expect((await approveAll(adminA, { studentId: 'nobody', testId: TEST_A })).statusCode).toBe(404);
  });
});
