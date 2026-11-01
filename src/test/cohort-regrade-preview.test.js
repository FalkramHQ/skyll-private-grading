import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCohortRegrade, previewCohortRegrade } from '../../api/vl-queue.js';
import { createRecheckTestDatabase } from './helpers/recheckTestDatabase.js';

const admin = { username: 'admin_a', role: 'admin', school: 'Alpha School', school_id: 'school_a' };
const crossSchool = { username: 'admin_b', role: 'admin', school: 'Beta School', school_id: 'school_b' };
const scope = { school: 'Alpha School', subject: 'Physics', grade: '11th', testId: 'test_a' };

async function seed(db) {
  const question = (id, submissionId, questionNumber, name, reviewRevision, regradedRevision, setQuestionId) => ([
    {
      sql: `INSERT INTO submission_questions (
              id, submission_id, school, subject, question_number, student_name,
              payload_json, marks_total, status, review_revision, regraded_revision, updated_at
            ) VALUES (?, ?, 'Alpha School', 'Physics', ?, ?, '{}', 5, 'published', ?, ?, '2026-07-30T10:00:00.000Z')`,
      args: [id, submissionId, questionNumber, name, reviewRevision, regradedRevision],
    },
    {
      sql: `INSERT INTO submission_questions_v2 (
              id, submission_id, exam_set_question_id, question_number,
              ai_marks, approved_marks, status, review_revision, regraded_revision,
              evidence_json, source_asset_ids_json, render_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, NULL, NULL, 'published', ?, ?, '{}', '[]', '{}', '2026-07-30T10:00:00.000Z', '2026-07-30T10:00:00.000Z')`,
      args: [id, submissionId, setQuestionId, questionNumber, reviewRevision, regradedRevision],
    },
  ]);
  await db.batch([
    { sql: "INSERT INTO schools (id, display_name) VALUES ('school_a', 'Alpha School')" },
    { sql: "INSERT INTO subjects (id, school_id, name) VALUES ('subj_a', 'school_a', 'Physics')" },
    { sql: "INSERT INTO exams (id, source_test_id, school_id, subject_id, name, grade) VALUES ('exam_a', 'test_a', 'school_a', 'subj_a', 'Physics Test', '11th')" },
    { sql: "INSERT INTO exam_sets (id, exam_id, set_code) VALUES ('set_a', 'exam_a', 'A')" },
    { sql: "INSERT INTO exam_set_questions (id, set_id, question_number, max_marks) VALUES ('esq_1', 'set_a', 'Q1', 5)" },
    { sql: "INSERT INTO exam_set_questions (id, set_id, question_number, max_marks) VALUES ('esq_2', 'set_a', 'Q2', 5)" },
    { sql: "INSERT INTO students (id, display_name) VALUES ('student_1', 'Asha')" },
    { sql: "INSERT INTO students (id, display_name) VALUES ('student_2', 'Kiran')" },
    { sql: "INSERT INTO submissions (id, exam_id, student_id, status) VALUES ('sub_1', 'exam_a', 'student_1', 'published')" },
    { sql: "INSERT INTO submissions (id, exam_id, student_id, status) VALUES ('sub_2', 'exam_a', 'student_2', 'published')" },
    { sql: "INSERT INTO test_submissions VALUES ('sub_1', 'test_a', 'student_1', 'published')" },
    { sql: "INSERT INTO test_submissions VALUES ('sub_2', 'test_a', 'student_2', 'published')" },
    ...question('question_1', 'sub_1', 'Q1', 'Asha', 1, 0, 'esq_1'),
    ...question('question_2', 'sub_1', 'Q2', 'Asha', 2, 0, 'esq_2'),
    ...question('question_3', 'sub_2', 'Q1', 'Kiran', 1, 0, 'esq_1'),
    ...question('question_4', 'sub_2', 'Q2', 'Kiran', 1, 1, 'esq_2'),
  ], 'write');
}

describe('preview-cohort-regrade', () => {
  let ctx;
  beforeEach(async () => { ctx = await createRecheckTestDatabase(); await seed(ctx.db); });
  afterEach(async () => { await ctx.close(); });

  it('returns per-student counts for exactly the set a regrade would queue', async () => {
    const preview = await previewCohortRegrade(ctx.db, admin, scope);
    expect(preview.totalQuestions).toBe(3);
    expect(preview.students).toEqual([
      { studentId: 'student_1', studentName: 'Asha', questionCount: 2 },
      { studentId: 'student_2', studentName: 'Kiran', questionCount: 1 },
    ]);

    const created = await createCohortRegrade(ctx.db, admin, scope);
    expect(created.questionCount).toBe(preview.totalQuestions);
    expect(created.studentCount).toBe(preview.students.length);
  });

  it('returns zero when nothing is pending, instead of throwing', async () => {
    await ctx.db.execute('UPDATE submission_questions SET regraded_revision = review_revision');
    await ctx.db.execute('UPDATE submission_questions_v2 SET regraded_revision = review_revision');
    const preview = await previewCohortRegrade(ctx.db, admin, scope);
    expect(preview).toEqual({ totalQuestions: 0, students: [] });
  });

  it('denies cross-school access', async () => {
    await expect(previewCohortRegrade(ctx.db, crossSchool, scope)).rejects.toThrow('School access denied');
  });
});
