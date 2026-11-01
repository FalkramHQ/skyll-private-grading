import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  requireMirror,
  syncCanonicalSubmission,
  syncQuestionReview,
  syncV2Question,
} from '../../api/_lib/canonicalSubmissions.js';
import { createRecheckTestDatabase } from './helpers/recheckTestDatabase.js';

async function seedBase(db) {
  const now = '2026-08-01T10:00:00.000Z';
  await db.batch([
    { sql: 'DROP TABLE IF EXISTS test_submissions' },
    { sql: `CREATE TABLE test_submissions (
      id TEXT PRIMARY KEY,
      test_id TEXT NOT NULL,
      student_id TEXT NOT NULL,
      batch_id TEXT,
      score REAL,
      max_marks REAL,
      review_status TEXT,
      created_at TEXT,
      status TEXT NOT NULL DEFAULT 'published'
    )` },
    { sql: 'DROP TABLE IF EXISTS submissions' },
    { sql: `CREATE TABLE submissions (
      id TEXT PRIMARY KEY,
      exam_id TEXT NOT NULL,
      set_id TEXT,
      student_id TEXT NOT NULL,
      batch_id_snapshot TEXT,
      status TEXT NOT NULL DEFAULT 'published',
      score REAL,
      max_marks REAL,
      review_status TEXT,
      graded_at TEXT,
      created_at TEXT,
      updated_at TEXT,
      UNIQUE(exam_id, student_id)
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS test_students (
      id TEXT PRIMARY KEY,
      test_id TEXT NOT NULL,
      student_id TEXT NOT NULL
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS file_assets (
      id TEXT PRIMARY KEY,
      test_id TEXT,
      kind TEXT,
      submission_id TEXT,
      test_student_id TEXT
    )` },
    { sql: 'ALTER TABLE exam_set_questions ADD COLUMN created_at TEXT' },
    { sql: 'ALTER TABLE exam_set_questions ADD COLUMN updated_at TEXT' },
    { sql: 'ALTER TABLE submission_questions ADD COLUMN created_at TEXT' },
    { sql: 'ALTER TABLE submission_questions ADD COLUMN question_id TEXT' },
    { sql: "INSERT INTO schools (id, display_name) VALUES ('school_a', 'Alpha School')" },
    { sql: "INSERT INTO subjects (id, school_id, name) VALUES ('subj_a', 'school_a', 'Physics')" },
    { sql: "INSERT INTO exams (id, source_test_id, school_id, subject_id, name, grade) VALUES ('exam_a', 'test_a', 'school_a', 'subj_a', 'Physics Test', '11th')" },
    { sql: "INSERT INTO exam_sets (id, exam_id, set_code) VALUES ('set_a', 'exam_a', 'A')" },
    { sql: "INSERT INTO exam_set_questions (id, set_id, question_number, max_marks, created_at, updated_at) VALUES ('esq_1', 'set_a', 'Q1', 5, ?, ?)", args: [now, now] },
    { sql: "INSERT INTO students (id, display_name) VALUES ('student_1', 'Asha')" },
    { sql: "INSERT INTO test_students (id, test_id, student_id) VALUES ('ts_1', 'test_a', 'student_1')" },
    { sql: "INSERT INTO file_assets (id, test_id, kind, submission_id, test_student_id) VALUES ('fa_1', 'test_a', 'answer_sheet', NULL, 'ts_1')" },
    { sql: `INSERT INTO test_submissions (id, test_id, student_id, score, max_marks, review_status, created_at, status)
            VALUES ('sub_1', 'test_a', 'student_1', 4, 5, 'pending', ?, 'published')` , args: [now] },
    { sql: `INSERT INTO submission_questions (
              id, submission_id, school, subject, question_number, student_name,
              payload_json, ai_marks, approved_marks, marks_total, status, created_at, updated_at
            ) VALUES ('q_1', 'sub_1', 'Alpha School', 'Physics', 'Q1', 'Asha', '{}', 4, 4, 5, 'published', ?, ?)`, args: [now, now] },
    { sql: `INSERT INTO review_decisions (
              submission_question_id, state, approved_marks, reviewer_id, reason, revision, approved_at, updated_at
            ) VALUES ('q_1', 'approved', 4, 'rev_user_1', 'Accurate steps', 1, ?, ?)`, args: [now, now] },
  ], 'write');
}

describe('dual-write synchronization integrity', () => {
  let harness;
  beforeEach(async () => {
    harness = await createRecheckTestDatabase();
    await seedBase(harness.db);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await harness.close();
  });

  it('requireMirror throws on write failure to prevent silent canonical drift', async () => {
    const brokenPromise = Promise.reject(new Error('Simulated Turso write failure on mirror table'));
    await expect(requireMirror('syncV2Question:test_scope', brokenPromise))
      .rejects.toThrow('Simulated Turso write failure on mirror table');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('canonical_mirror_failed'));
  });

  it('syncCanonicalSubmission mirrors legacy scores into submissions and is completely idempotent across sequential updates', async () => {
    const { db } = harness;
    const res1 = await syncCanonicalSubmission(db, 'sub_1', '2026-08-01T11:00:00.000Z');
    expect(res1).toMatchObject({ examId: 'exam_a', setId: 'set_a' });

    let count = (await db.execute("SELECT COUNT(*) as cnt FROM submissions WHERE id = 'sub_1'")).rows[0].cnt;
    let row = (await db.execute("SELECT score, max_marks, status FROM submissions WHERE id = 'sub_1'")).rows[0];
    expect(count).toBe(1);
    expect(row).toMatchObject({ score: 4, max_marks: 5, status: 'published' });

    // Simulate legacy table grade override and re-sync
    await db.execute("UPDATE test_submissions SET score = 5 WHERE id = 'sub_1'");
    await syncCanonicalSubmission(db, 'sub_1', '2026-08-01T12:00:00.000Z');

    count = (await db.execute("SELECT COUNT(*) as cnt FROM submissions WHERE id = 'sub_1'")).rows[0].cnt;
    row = (await db.execute("SELECT score, max_marks, status FROM submissions WHERE id = 'sub_1'")).rows[0];
    expect(count).toBe(1);
    expect(row).toMatchObject({ score: 5, max_marks: 5 });
  });

  it('syncCanonicalSubmission sets graded_at once, from the earliest report, and never moves it (FLKRM-484)', async () => {
    const { db } = harness;
    const insertReport = (id, version, generatedAt) => db.execute({
      sql: `INSERT INTO report_versions (id, submission_id, version, status, generated_at, payload_json, username, school)
            VALUES (?, 'sub_1', ?, 'published', ?, '{}', 'asha', 'Alpha School')`,
      args: [id, version, generatedAt],
    });
    const gradedAt = async () => (await db.execute("SELECT graded_at FROM submissions WHERE id = 'sub_1'")).rows[0].graded_at;

    await insertReport('report_1', 1, '2026-09-30T19:00:00.000Z');
    await syncCanonicalSubmission(db, 'sub_1', '2026-09-30T19:00:00.000Z');
    expect(await gradedAt()).toBe('2026-09-30T19:00:00.000Z');

    // A regrade or rebuilt report adds a later version and re-syncs.
    await insertReport('report_2', 2, '2026-10-02T08:00:00.000Z');
    await db.execute("UPDATE test_submissions SET score = 5, status = 'ready_for_review' WHERE id = 'sub_1'");
    await syncCanonicalSubmission(db, 'sub_1', '2026-10-02T08:00:00.000Z');
    expect(await gradedAt()).toBe('2026-09-30T19:00:00.000Z');

    // Even if the original version row disappeared, the stamp is not rewritten.
    await db.execute("DELETE FROM report_versions WHERE id = 'report_1'");
    await syncCanonicalSubmission(db, 'sub_1', '2026-10-03T08:00:00.000Z');
    expect(await gradedAt()).toBe('2026-09-30T19:00:00.000Z');
  });

  it('syncCanonicalSubmission keeps graded_at NULL until a report is built', async () => {
    const { db } = harness;
    await db.execute("UPDATE test_submissions SET status = 'graded', max_marks = NULL WHERE id = 'sub_1'");
    await syncCanonicalSubmission(db, 'sub_1', '2026-09-30T10:00:00.000Z');
    const row = (await db.execute("SELECT status, graded_at FROM submissions WHERE id = 'sub_1'")).rows[0];
    expect(row).toMatchObject({ status: 'graded', graded_at: null });
  });

  it('syncV2Question accurately mirrors per-question grades into submission_questions_v2 without row duplication', async () => {
    const { db } = harness;
    const synced = await syncV2Question(db, 'q_1', '2026-08-01T11:00:00.000Z');
    expect(synced).toMatchObject({ examId: 'exam_a', setId: 'set_a' });

    const getV2 = async () => (await db.execute("SELECT ai_marks, approved_marks, status FROM submission_questions_v2 WHERE id = 'q_1'")).rows[0];
    expect(await getV2()).toMatchObject({ ai_marks: 4, approved_marks: 4, status: 'published' });

    // Call second time after modification to confirm idempotent update
    await db.execute("UPDATE submission_questions SET approved_marks = 5, status = 'regraded' WHERE id = 'q_1'");
    await syncV2Question(db, 'q_1', '2026-08-01T12:00:00.000Z');

    expect(await getV2()).toMatchObject({ ai_marks: 4, approved_marks: 5, status: 'regraded' });
    const count = (await db.execute("SELECT COUNT(*) as cnt FROM submission_questions_v2 WHERE id = 'q_1'")).rows[0].cnt;
    expect(count).toBe(1);
  });

  it('syncQuestionReview accurately mirrors review decisions into question_reviews', async () => {
    const { db } = harness;
    await syncQuestionReview(db, 'q_1', '2026-08-01T11:00:00.000Z');
    const row = (await db.execute("SELECT state, approved_marks, reviewer_id FROM question_reviews WHERE submission_question_id = 'q_1'")).rows[0];
    expect(row).toMatchObject({ state: 'approved', approved_marks: 4, reviewer_id: 'rev_user_1' });
  });
});
