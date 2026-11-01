import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import { loadReviewCohortSummary, countCohortPending, markCohortComplete, unmarkCohortComplete, loadCohortCompletionOverrides, cohortOverrideKey } from '../../api/vl-queue.js';

const DDL = [
  'CREATE TABLE schools (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, slug TEXT)',
  'CREATE TABLE subjects (id TEXT PRIMARY KEY, name TEXT NOT NULL)',
  'CREATE TABLE tests (id TEXT PRIMARY KEY, title TEXT, subject TEXT, grade TEXT)',
  `CREATE TABLE exams (id TEXT PRIMARY KEY, school_id TEXT, subject_id TEXT,
     source_test_id TEXT, name TEXT, grade TEXT, exam_date TEXT,
     status TEXT NOT NULL DEFAULT 'published')`,
  `CREATE TABLE submissions (id TEXT PRIMARY KEY, exam_id TEXT NOT NULL,
     student_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'published')`,
  'CREATE TABLE question_reviews (submission_question_id TEXT PRIMARY KEY, state TEXT NOT NULL)',
  `CREATE TABLE submission_questions_v2 (id TEXT PRIMARY KEY, submission_id TEXT NOT NULL,
     exam_set_question_id TEXT NOT NULL, question_number TEXT NOT NULL,
     ai_marks REAL, approved_marks REAL, status TEXT NOT NULL,
     review_revision INTEGER NOT NULL DEFAULT 0, regraded_revision INTEGER NOT NULL DEFAULT 0,
     evidence_json TEXT NOT NULL DEFAULT '{}', source_asset_ids_json TEXT NOT NULL DEFAULT '[]',
     created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '', render_json TEXT)`,
];

function question(id, submissionId, reviewRevision, regradedRevision) {
  return {
    sql: `INSERT INTO submission_questions_v2 (id, submission_id, exam_set_question_id, question_number, status, review_revision, regraded_revision)
          VALUES (?, ?, ?, 'Q1', 'published', ?, ?)`,
    args: [id, submissionId, `esq_${id}`, reviewRevision, regradedRevision],
  };
}

describe('review cohort summary', () => {
  let db;
  beforeEach(async () => {
    db = createClient({ url: ':memory:' });
    await db.batch(DDL.map((sql) => ({ sql })), 'write');
    await db.batch([
      { sql: "INSERT INTO schools (id, display_name) VALUES ('school_1', 'Partner Academy B')" },
      { sql: "INSERT INTO subjects VALUES ('subject_1', 'Chemistry')" },
      { sql: "INSERT INTO tests VALUES ('test_1', '11th Mole concept', 'Chemistry', '11th')" },
      { sql: `INSERT INTO exams VALUES ('exam_1', 'school_1', 'subject_1', 'test_1', '11th Mole concept', '11th', '2026-01-15', 'published')` },
      { sql: "INSERT INTO submissions VALUES ('sub_1', 'exam_1', 'student_1', 'published')" },
      { sql: "INSERT INTO submissions VALUES ('sub_2', 'exam_1', 'student_2', 'published')" },
      { sql: "INSERT INTO submissions VALUES ('sub_3', 'exam_1', 'student_3', 'published')" },
      // student_1 has two pending changes, student_2 has one, student_3 none.
      question('q1', 'sub_1', 2, 0),
      question('q2', 'sub_1', 1, 0),
      question('q3', 'sub_2', 1, 0),
      question('q4', 'sub_3', 1, 1),
    ], 'write');
  });
  afterEach(() => db.close());

  it('counts changed questions and distinct changed students', async () => {
    const cohorts = await loadReviewCohortSummary(db, ['1 = 1'], []);
    expect(cohorts).toHaveLength(1);
    expect(cohorts[0]).toMatchObject({
      school: 'Partner Academy B',
      testId: 'test_1',
      examName: '11th Mole concept',
      totalQuestions: 4,
      totalStudents: 3,
      changedQuestions: 3,
      changedStudents: 2,
    });
  });

  it('accurately separates cohorts across multiple tests and subjects without intermingling stats', async () => {
    await db.batch([
      { sql: "INSERT INTO subjects VALUES ('subject_2', 'Physics')" },
      { sql: "INSERT INTO tests VALUES ('test_2', '11th Kinematics', 'Physics', '11th')" },
      { sql: `INSERT INTO exams VALUES ('exam_2', 'school_1', 'subject_2', 'test_2', '11th Kinematics', '11th', '2026-02-20', 'published')` },
      { sql: "INSERT INTO submissions VALUES ('sub_4', 'exam_2', 'student_1', 'published')" },
      question('q5', 'sub_4', 5, 0),
    ], 'write');

    const cohorts = await loadReviewCohortSummary(db, ['1 = 1'], []);
    expect(cohorts).toHaveLength(2);
    const phys = cohorts.find((c) => c.testId === 'test_2');
    expect(phys).toMatchObject({
      testId: 'test_2',
      examName: '11th Kinematics',
      totalQuestions: 1,
      changedQuestions: 1,
    });
  });

  it('exposes the newest exam date and orders cohorts newest first', async () => {
    await db.batch([
      { sql: "INSERT INTO subjects VALUES ('subject_2', 'Physics')" },
      { sql: "INSERT INTO tests VALUES ('test_2', '11th Kinematics', 'Physics', '11th')" },
      { sql: `INSERT INTO exams VALUES ('exam_2', 'school_1', 'subject_2', 'test_2', '11th Kinematics', '11th', '2026-02-20', 'published')` },
      { sql: "INSERT INTO submissions VALUES ('sub_4', 'exam_2', 'student_1', 'published')" },
      question('q5', 'sub_4', 5, 0),
    ], 'write');

    const cohorts = await loadReviewCohortSummary(db, ['1 = 1'], []);
    // exam_2 (2026-02-20) is newer than exam_1 (2026-01-15), so it leads.
    expect(cohorts.map((c) => c.examDate)).toEqual(['2026-02-20', '2026-01-15']);

    // One cohort spanning several sittings reports the most recent one.
    await db.execute({ sql: `INSERT INTO exams VALUES ('exam_1b', 'school_1', 'subject_1', 'test_1', '11th Mole concept', '11th', '2026-03-05', 'published')`, args: [] });
    await db.execute({ sql: "INSERT INTO submissions VALUES ('sub_9', 'exam_1b', 'student_9', 'published')", args: [] });
    await db.execute(question('q9', 'sub_9', 1, 1));
    const merged = await loadReviewCohortSummary(db, ['1 = 1'], []);
    expect(merged.find((c) => c.testId === 'test_1').examDate).toBe('2026-03-05');
  });

  it('reports an empty exam date rather than null for undated exams', async () => {
    await db.batch([
      { sql: "INSERT INTO subjects VALUES ('subject_3', 'Biology')" },
      { sql: "INSERT INTO tests VALUES ('test_3', '12th Genetics', 'Biology', '12th')" },
      { sql: `INSERT INTO exams VALUES ('exam_3', 'school_1', 'subject_3', 'test_3', '12th Genetics', '12th', NULL, 'published')` },
      { sql: "INSERT INTO submissions VALUES ('sub_5', 'exam_3', 'student_5', 'published')" },
      question('q6', 'sub_5', 1, 1),
    ], 'write');
    const cohorts = await loadReviewCohortSummary(db, ["COALESCE(e.source_test_id, e.id) = 'test_3'"], []);
    expect(cohorts).toHaveLength(1);
    expect(cohorts[0].examDate).toBe('');
    // Undated cohorts sort last, behind the dated ones.
    const all = await loadReviewCohortSummary(db, ['1 = 1'], []);
    expect(all[all.length - 1].testId).toBe('test_3');
  });
});

describe('cohort completion overrides', () => {
  let db;
  beforeEach(async () => {
    db = createClient({ url: ':memory:' });
    await db.batch(DDL.map((sql) => ({ sql })), 'write');
    await db.batch([
      { sql: "INSERT INTO schools (id, display_name) VALUES ('school_1', 'Partner Academy B')" },
      { sql: "INSERT INTO subjects VALUES ('subject_1', 'Chemistry')" },
      { sql: "INSERT INTO tests VALUES ('test_1', '11th Mole concept', 'Chemistry', '11th')" },
      { sql: `INSERT INTO exams VALUES ('exam_1', 'school_1', 'subject_1', 'test_1', '11th Mole concept', '11th', '2026-01-15', 'published')` },
      { sql: "INSERT INTO submissions VALUES ('sub_1', 'exam_1', 'student_1', 'published')" },
      question('q1', 'sub_1', 2, 0),
      question('q2', 'sub_1', 1, 1),
    ], 'write');
    await db.execute(`CREATE TABLE cohort_completion_overrides (
      id TEXT PRIMARY KEY, school TEXT NOT NULL, test_id TEXT NOT NULL,
      subject TEXT, grade TEXT, narrative TEXT,
      marked_in_review INTEGER NOT NULL DEFAULT 0, pending_at_override INTEGER NOT NULL DEFAULT 0,
      marked_by TEXT NOT NULL, marked_at TEXT NOT NULL, released_by TEXT, released_at TEXT)`);
  });
  afterEach(() => db.close());

  it('counts the pending and changed work being overridden', async () => {
    // No review decision exists for either question, so both are pending; only
    // q1 carries a review_revision beyond its regraded_revision.
    expect(await countCohortPending(db, 'Partner Academy B', 'test_1')).toEqual({ pending: 2, changedQuestions: 1 });
  });

  it('marks, attributes, and releases a cohort completion', async () => {
    const actor = { role: 'teacher', school: 'Partner Academy B', school_id: 'school_1', username: 'teacher_1' };
    const created = await markCohortComplete(db, actor, { school: 'Partner Academy B', testId: 'test_1', pending: 2 });
    expect(created).toMatchObject({ school: 'Partner Academy B', testId: 'test_1', markedBy: 'teacher_1', pendingAtOverride: 2 });

    const overrides = await loadCohortCompletionOverrides(db, ['Partner Academy B']);
    expect(overrides.get(cohortOverrideKey('Partner Academy B', 'test_1'))).toMatchObject({
      markedBy: 'teacher_1', markedInReview: true, pendingAtOverride: 2,
    });

    // Re-marking an already-marked cohort is rejected rather than silently duplicated.
    await expect(markCohortComplete(db, actor, { school: 'Partner Academy B', testId: 'test_1' })).rejects.toThrow(/already marked/i);

    await unmarkCohortComplete(db, actor, { school: 'Partner Academy B', testId: 'test_1' });
    expect((await loadCohortCompletionOverrides(db, ['Partner Academy B'])).size).toBe(0);
    // The released row survives so the audit trail records who overrode and who undid it.
    const released = await db.execute("SELECT released_by FROM cohort_completion_overrides WHERE released_at IS NOT NULL");
    expect(released.rows[0].released_by).toBe('teacher_1');
  });

  it('denies marking a cohort outside the actor school', async () => {
    await expect(markCohortComplete(db, { role: 'teacher', school: 'Other School', school_id: 'school_other', username: 't' }, { school: 'Partner Academy B', testId: 'test_1' }))
      .rejects.toThrow(/access denied/i);
  });
});

