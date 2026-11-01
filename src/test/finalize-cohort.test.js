// finalize-cohort completes one assessment: it never touches another test that
// shares the school/subject/grade, skips archived work, approves only
// still-pending questions (dual-write + audit), and writes in bounded batches.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRecheckTestDatabase, seedCanonicalQuestionStatements } from './helpers/recheckTestDatabase.js';
import { resetSchoolCache } from '../../api/_lib/canonicalSubmissions.js';

const state = vi.hoisted(() => ({ db: null, user: null, batchSizes: [] }));
vi.mock('@libsql/client/web', () => ({
  createClient: () => ({
    execute: (...args) => state.db.execute(...args),
    batch: (statements, mode) => { state.batchSizes.push(statements.length); return state.db.batch(statements, mode); },
  }),
}));
vi.mock('../../api/_lib/env.js', () => ({ tursoUrl: 'file:finalize-test', tursoAuthToken: 'token' }));
vi.mock('../../api/_lib/auth.js', () => ({
  ensureAuthTables: async () => {},
  requireUser: async () => state.user,
}));
vi.mock('../../api/_lib/cors.js', () => ({ handleCors: () => false }));

const { default: handler } = await import('../../api/vl-queue.js');

const adminA = { username: 'admin_a', role: 'admin', school: 'Alpha School', school_id: 'school_alpha' };
const teacherA = { username: 'teacher_a', role: 'teacher', school: 'Alpha School', school_id: 'school_alpha' };
const TEST_A = 'test_exam_a';

function response() {
  return {
    setHeader() { return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

async function finalize(user, body) {
  state.user = user;
  const res = response();
  await handler({ method: 'POST', headers: {}, query: {}, body: { action: 'finalize-cohort', school: 'Alpha School', ...body } }, res);
  return res;
}

const question = (questionId, examId, studentId, questionNumber = 'Q1') => seedCanonicalQuestionStatements({
  questionId, submissionId: `sub_${examId}_${studentId}`, examId, setId: `set_${examId}`, setQuestionId: `esq_${examId}_${questionNumber}`,
  questionNumber, studentId,
});

async function examStatus(examId) {
  return (await harness.db.execute({ sql: 'SELECT status FROM exams WHERE id = ?', args: [examId] })).rows[0].status;
}

async function reviewState(questionId) {
  return (await harness.db.execute({ sql: 'SELECT state FROM question_reviews WHERE submission_question_id = ?', args: [questionId] })).rows[0]?.state || null;
}

let harness;
beforeEach(async () => {
  resetSchoolCache();
  state.batchSizes = [];
  harness = await createRecheckTestDatabase();
  state.db = harness.db;
  await harness.db.execute('ALTER TABLE exams ADD COLUMN updated_at TEXT');
  await harness.db.batch([
    ...question('qa1', 'exam_a', 'student_1'),
    ...question('qa2', 'exam_a', 'student_2'),
    // Same school, subject and grade, different assessment: never touched.
    ...question('qb1', 'exam_b', 'student_1'),
    "INSERT INTO question_reviews (submission_question_id, state, reviewer_id, revision, updated_at) VALUES ('qa2', 'flagged', 'someone', 1, 'earlier')",
    "UPDATE exams SET status = 'in_review'",
  ].map((statement) => (typeof statement === 'string' ? { sql: statement } : statement)), 'write');
});
afterEach(async () => { await harness?.close(); });

describe('finalize-cohort', () => {
  it('requires the assessment', async () => {
    expect((await finalize(adminA, { subject: 'Physics', grade: '12' })).statusCode).toBe(400);
  });

  it('finalizes only the selected assessment and approves only pending questions, with audit', async () => {
    const res = await finalize(adminA, { testId: TEST_A });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, testId: TEST_A, approved: 1, status: 'finalized' });
    expect(await examStatus('exam_a')).toBe('published');
    expect(await examStatus('exam_b')).toBe('in_review');
    expect(await reviewState('qa1')).toBe('approved');
    expect(await reviewState('qa2')).toBe('flagged');
    expect(await reviewState('qb1')).toBeNull();
    const mirrored = (await harness.db.execute("SELECT submission_question_id FROM review_decisions WHERE state = 'approved'")).rows;
    expect(mirrored.map((row) => row.submission_question_id)).toEqual(['qa1']);
    const events = (await harness.db.execute('SELECT submission_question_id, actor_user_id, event_type FROM question_review_events')).rows;
    expect(events).toEqual([{ submission_question_id: 'qa1', actor_user_id: 'admin_a', event_type: 'review_decided' }]);
  });

  it('leaves archived submissions and exams alone', async () => {
    await harness.db.execute("UPDATE submissions SET status = 'archived' WHERE id = 'sub_exam_a_student_1'");
    const res = await finalize(teacherA, { testId: TEST_A });
    // The only pending question is archived, so a teacher may finalize.
    expect(res.statusCode).toBe(200);
    expect(await reviewState('qa1')).toBeNull();

    await harness.db.execute("UPDATE exams SET status = 'archived' WHERE id = 'exam_a'");
    await finalize(adminA, { testId: TEST_A });
    expect(await examStatus('exam_a')).toBe('archived');
  });

  it('still blocks a teacher while questions are pending', async () => {
    const res = await finalize(teacherA, { testId: TEST_A });
    expect(res.statusCode).toBe(400);
    expect(await examStatus('exam_a')).toBe('in_review');
  });

  it('writes large cohorts in batches of at most 200 statements', async () => {
    const statements = [];
    for (let index = 0; index < 150; index += 1) statements.push(...question(`qc${index}`, 'exam_c', `student_c${index}`));
    await harness.db.batch(statements, 'write');
    state.batchSizes = [];
    const res = await finalize(adminA, { testId: 'test_exam_c' });
    expect(res.body.approved).toBe(150);
    expect(state.batchSizes).toEqual([198, 198, 54]);
    expect((await harness.db.execute('SELECT COUNT(*) AS n FROM question_review_events')).rows[0].n).toBe(150);
  });

  it("does not finalize another school's assessment by name", async () => {
    const res = await finalize({ ...adminA, school: 'Beta School', school_id: 'school_beta' }, { testId: TEST_A });
    expect(res.statusCode).toBe(403);
    expect(await examStatus('exam_a')).toBe('in_review');
  });
});
