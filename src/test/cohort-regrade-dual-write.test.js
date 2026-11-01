import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/_lib/cohortRegrade.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    generateQuestionFeedback: vi.fn(async () => ({
      whatWentCorrect: 'The first calculation is correct.',
      needsAttention: 'The final unit is missing.',
      nextStep: 'Write the final value with units.',
      gradingReasoning: 'One of two required parts is correct.',
      model: 'test-model',
    })),
    publishSubmissionReport: vi.fn(async () => null),
  };
});

import { processCohortRegradeStep } from '../../api/vl-queue.js';
import { createRecheckTestDatabase } from './helpers/recheckTestDatabase.js';

const actor = { username: 'admin_a', role: 'skyll_admin', school: '' };

describe('cohort regrade v2 dual-write', () => {
  let ctx;
  beforeEach(async () => { ctx = await createRecheckTestDatabase(); });
  afterEach(async () => { await ctx.close(); });

  it('marks the question regraded in both submission_questions and submission_questions_v2', async () => {
    const { db } = ctx;
    const snapshot = {
      questionId: 'question_a', submissionId: 'submission_a', questionNumber: 'Q1',
      approvedMarks: 3, marksTotal: 5, attempted: true,
      studentAnswer: 'Original answer',
      payload: {
        studentAnswer: { attempted: true, studentWrote: 'Original answer' },
        grade: { marks: 1, allocated: 5, status: 'partial' },
      },
    };
    await db.batch([
      { sql: `INSERT INTO test_submissions (id, test_id, student_id, status)
              VALUES ('submission_a', 'test_a', 'student_a', 'published')` },
      { sql: `INSERT INTO submission_questions (
                id, submission_id, school, subject, question_number, student_name,
                payload_json, ai_marks, approved_marks, marks_total, status,
                review_revision, regraded_revision, updated_at
              ) VALUES (
                'question_a', 'submission_a', 'Alpha School', 'Physics', 'Q1', 'Asha',
                '{}', 1, 3, 5, 'published', 2, 0, '2026-07-30T10:00:00.000Z'
              )` },
      { sql: `INSERT INTO submission_questions_v2 (
                id, submission_id, exam_set_question_id, question_number,
                ai_marks, approved_marks, status, review_revision, regraded_revision,
                evidence_json, source_asset_ids_json, created_at, updated_at
              ) VALUES (
                'question_a', 'submission_a', 'esq_1', 'Q1',
                1, 3, 'published', 2, 0,
                '{}', '[]', '2026-07-30T10:00:00.000Z', '2026-07-30T10:00:00.000Z'
              )` },
      { sql: `INSERT INTO regrade_runs (id, scope, status, requested_by, requested_at)
              VALUES ('run_a', '{"school":"Alpha School","subject":"Physics","grade":"11th","test_id":"test_a"}',
                      'queued', 'admin_a', '2026-07-30T10:00:00.000Z')` },
      { sql: `INSERT INTO regrade_items (id, run_id, submission_id, submission_question_id, revision, state, input_snapshot_json)
              VALUES ('item_a', 'run_a', 'submission_a', 'question_a', 2, 'queued', ?)`,
        args: [JSON.stringify(snapshot)] },
    ], 'write');

    await processCohortRegradeStep(db, actor, { id: 'run_a', status: 'queued' });

    const v1 = (await db.execute("SELECT regraded_revision, status, approved_marks FROM submission_questions WHERE id = 'question_a'")).rows[0];
    const v2 = (await db.execute("SELECT regraded_revision, status, approved_marks, ai_marks FROM submission_questions_v2 WHERE id = 'question_a'")).rows[0];
    const item = (await db.execute("SELECT state FROM regrade_items WHERE id = 'item_a'")).rows[0];

    expect(item.state).toBe('completed');
    expect(v1).toMatchObject({ regraded_revision: 2, status: 'regraded', approved_marks: 3 });
    // ai_marks keeps the AI's original mark; approved_marks carries the teacher's.
    expect(v2).toMatchObject({ regraded_revision: 2, status: 'regraded', approved_marks: 3, ai_marks: 1 });
    expect((await db.execute("SELECT ai_marks FROM submission_questions WHERE id = 'question_a'")).rows[0].ai_marks).toBe(1);
  });
});
