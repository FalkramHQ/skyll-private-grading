import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';

const TABLES = [
  'recheck_events',
  'recheck_requests',
  'question_review_events',
  'question_reviews',
  'review_decisions',
  'submission_question_revisions',
  'submission_questions_v2',
  'exam_set_questions',
  'exam_sets',
  'regrade_items',
  'regrade_runs',
  'report_modules',
  'student_report_summaries',
  'teacher_report_versions',
  'report_versions',
  'submission_questions',
  'submissions',
  'test_submissions',
  'students',
  'subjects',
  'exams',
  'schools',
];

const TEMP_PREFIX = 'skyll-recheck-test-';
const STALE_AFTER_MS = 60 * 60 * 1000;

const SCHEMA = [
  `CREATE TABLE test_submissions (
    id TEXT PRIMARY KEY,
    test_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'published'
  )`,
  `CREATE TABLE submission_questions (
    id TEXT PRIMARY KEY,
    submission_id TEXT NOT NULL,
    school TEXT NOT NULL,
    subject TEXT NOT NULL,
    question_number TEXT NOT NULL,
    student_name TEXT,
    question_text TEXT,
    answer_key_text TEXT,
    rubric_json TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}',
    ai_marks REAL,
    approved_marks REAL,
    marks_total REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'published',
    review_revision INTEGER NOT NULL DEFAULT 0,
    regraded_revision INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    UNIQUE(submission_id, subject, question_number)
  )`,
  `CREATE TABLE review_decisions (
    submission_question_id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    approved_marks REAL,
    reviewer_id TEXT,
    reason TEXT,
    revision INTEGER NOT NULL DEFAULT 0,
    approved_at TEXT,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE question_reviews (
    submission_question_id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    approved_marks REAL,
    reviewer_id TEXT,
    reason TEXT,
    revision INTEGER NOT NULL DEFAULT 0,
    approved_at TEXT,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE submissions (
    id TEXT PRIMARY KEY,
    exam_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'published',
    score REAL,
    max_marks REAL
  )`,
  `CREATE TABLE students (
    id TEXT PRIMARY KEY,
    display_name TEXT
  )`,
  `CREATE TABLE subjects (
    id TEXT PRIMARY KEY,
    school_id TEXT,
    name TEXT NOT NULL
  )`,
  `CREATE TABLE exam_sets (
    id TEXT PRIMARY KEY,
    exam_id TEXT NOT NULL,
    set_code TEXT
  )`,
  `CREATE TABLE exam_set_questions (
    id TEXT PRIMARY KEY,
    set_id TEXT NOT NULL,
    question_number TEXT NOT NULL,
    question_text TEXT,
    answer_key_text TEXT,
    max_marks REAL,
    rubric_json TEXT,
    UNIQUE(set_id, question_number)
  )`,
  `CREATE TABLE question_review_events (
    id TEXT PRIMARY KEY,
    submission_question_id TEXT NOT NULL,
    actor_user_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    before_json TEXT,
    after_json TEXT,
    comment TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE recheck_requests (
    id TEXT PRIMARY KEY,
    submission_question_id TEXT NOT NULL,
    submission_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    requested_by TEXT,
    requested_by_role TEXT,
    status TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    taken_by TEXT,
    taken_at TEXT,
    resolved_by TEXT,
    resolved_at TEXT,
    resolution_note TEXT
  )`,
  `CREATE TABLE recheck_events (
    id TEXT PRIMARY KEY,
    recheck_request_id TEXT NOT NULL,
    actor_user_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    before_json TEXT,
    after_json TEXT,
    note TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE report_versions (
    id TEXT PRIMARY KEY,
    submission_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    status TEXT NOT NULL,
    workflow_run_id TEXT,
    generated_at TEXT NOT NULL,
    published_at TEXT,
    superseded_at TEXT,
    payload_json TEXT NOT NULL,
    username TEXT NOT NULL,
    school TEXT NOT NULL,
    UNIQUE(submission_id, version)
  )`,
  `CREATE TABLE student_report_summaries (
    username TEXT PRIMARY KEY,
    school TEXT NOT NULL,
    student_name TEXT,
    class_name TEXT,
    subjects_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE teacher_report_versions (
    username TEXT PRIMARY KEY,
    school TEXT,
    payload_json TEXT NOT NULL,
    updated_at TEXT
  )`,
  `CREATE TABLE report_modules (
    id TEXT PRIMARY KEY,
    report_version_id TEXT NOT NULL,
    submission_question_id TEXT,
    module_type TEXT NOT NULL,
    module_key TEXT,
    source_revision INTEGER NOT NULL,
    dependency_json TEXT,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'published',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE regrade_runs (
    id TEXT PRIMARY KEY,
    exam_id TEXT,
    school_id TEXT,
    scope TEXT,
    status TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    worker_id TEXT,
    heartbeat_at TEXT,
    attempt_count INTEGER DEFAULT 0,
    question_count INTEGER NOT NULL DEFAULT 0,
    student_count INTEGER NOT NULL DEFAULT 0,
    workflow_version TEXT,
    model_version TEXT,
    input_manifest_json TEXT,
    output_manifest_json TEXT,
    result_json TEXT,
    error TEXT
  )`,
  `CREATE TABLE regrade_items (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    submission_id TEXT NOT NULL,
    submission_question_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    state TEXT NOT NULL,
    input_snapshot_json TEXT,
    output_json TEXT,
    error TEXT,
    started_at TEXT,
    completed_at TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    UNIQUE(run_id, submission_question_id)
  )`,
  `CREATE TABLE submission_questions_v2 (
    id TEXT PRIMARY KEY,
    submission_id TEXT NOT NULL,
    exam_set_question_id TEXT NOT NULL,
    question_number TEXT NOT NULL,
    ai_marks REAL,
    approved_marks REAL,
    status TEXT NOT NULL,
    review_revision INTEGER NOT NULL DEFAULT 0,
    regraded_revision INTEGER NOT NULL DEFAULT 0,
    evidence_json TEXT NOT NULL DEFAULT '{}',
    source_asset_ids_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT '',
    render_json TEXT,
    UNIQUE(submission_id, exam_set_question_id)
  )`,
  `CREATE TABLE submission_question_revisions (
    id TEXT PRIMARY KEY,
    submission_question_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    source TEXT NOT NULL,
    actor_user_id TEXT,
    cohort_regrade_run_id TEXT,
    snapshot_json TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(submission_question_id, revision)
  )`,
  'CREATE TABLE schools (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, slug TEXT)',
  `CREATE TABLE exams (
    id TEXT PRIMARY KEY,
    source_test_id TEXT,
    school_id TEXT,
    subject_id TEXT,
    name TEXT,
    grade TEXT,
    status TEXT NOT NULL DEFAULT 'published',
    released_at TEXT,
    released_by TEXT
  )`,
  "CREATE UNIQUE INDEX recheck_requests_one_active_question_idx ON recheck_requests (submission_question_id) WHERE status IN ('open', 'in_review', 'awaiting_regrade')",
  'CREATE INDEX recheck_events_request_created_idx ON recheck_events (recheck_request_id, created_at DESC)',
  'CREATE INDEX regrade_items_run_state_idx ON regrade_items (run_id, state)',
];

function normalizedFileUrl(filePath) {
  return `file:${path.resolve(filePath).replaceAll('\\', '/')}`;
}

export function assertIsolatedDatabaseUrl(url, allowedRoot = os.tmpdir()) {
  const value = String(url || '');
  if (!value.startsWith('file:')) {
    throw new Error('Recheck tests require a local file: database and refuse remote database URLs');
  }
  const filePath = path.resolve(value.slice('file:'.length));
  const root = path.resolve(allowedRoot);
  const relative = path.relative(root, filePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Recheck test database must be a disposable file below the test temporary directory');
  }
  return filePath;
}

export function createDeterministicClock(start = '2026-01-01T00:00:00.000Z') {
  let current = new Date(start).getTime();
  if (!Number.isFinite(current)) throw new Error('Deterministic clock requires a valid start time');
  return {
    now: () => new Date(current),
    iso: () => new Date(current).toISOString(),
    advance: (milliseconds = 1) => {
      current += Number(milliseconds);
      return new Date(current);
    },
  };
}

export function createDeterministicIds() {
  const counters = new Map();
  return (prefix) => {
    const next = (counters.get(prefix) || 0) + 1;
    counters.set(prefix, next);
    return `${prefix}_${String(next).padStart(4, '0')}`;
  };
}

export function blockExternalNetwork() {
  const previous = globalThis.fetch;
  globalThis.fetch = async (input) => {
    throw new Error(`External network access is disabled in recheck tests: ${String(input)}`);
  };
  return () => {
    if (previous === undefined) delete globalThis.fetch;
    else globalThis.fetch = previous;
  };
}

async function removeDisposableDirectory(directory) {
  try {
    await rm(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 10 });
    return true;
  } catch (error) {
    // @libsql/client can retain a native SQLite handle until process teardown
    // on Windows. The directory is still isolated below the OS temp root and
    // will be removed by the next harness process once that handle is gone.
    if (error?.code === 'EBUSY' || error?.code === 'EPERM') return false;
    throw error;
  }
}

export async function cleanStaleRecheckTestDatabases() {
  const root = os.tmpdir();
  const entries = await readdir(root, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(TEMP_PREFIX))
    .map((entry) => path.join(root, entry.name));
  const now = Date.now();
  const stale = (await Promise.all(candidates.map(async (directory) => {
    try {
      const metadata = await stat(directory);
      return now - metadata.mtimeMs >= STALE_AFTER_MS ? directory : null;
    } catch {
      return null;
    }
  }))).filter(Boolean);
  const results = await Promise.all(stale.map(removeDisposableDirectory));
  return results.filter(Boolean).length;
}

export async function createRecheckTestDatabase() {
  await cleanStaleRecheckTestDatabases();
  const directory = await mkdtemp(path.join(os.tmpdir(), TEMP_PREFIX));
  const filePath = path.join(directory, 'rechecks.db');
  const url = normalizedFileUrl(filePath);
  assertIsolatedDatabaseUrl(url, directory);
  const db = createClient({ url });
  const concurrentDb = createClient({ url });
  await db.batch(SCHEMA.map((sql) => ({ sql })), 'write');

  return {
    db,
    concurrentDb,
    directory,
    filePath,
    url,
    async reset() {
      await db.batch(TABLES.map((table) => ({ sql: `DELETE FROM ${table}` })), 'write');
    },
    async close() {
      db.close();
      concurrentDb.close();
      return removeDisposableDirectory(directory);
    },
  };
}

/**
 * Seed a question on the canonical path (and legacy dual-write row for bake-window
 * write tests). Prefer this over inserting only into `submission_questions`.
 */
export function seedCanonicalQuestionStatements({
  questionId,
  submissionId,
  school = 'Alpha School',
  schoolId = 'school_alpha',
  subject = 'Physics',
  subjectId = 'subject_physics_alpha',
  examId = 'exam_alpha',
  setId = 'set_alpha',
  setQuestionId = 'esq_alpha',
  studentId = 'student_alpha',
  studentName = 'Asha',
  questionNumber = 'Q1',
  payloadJson = '{}',
  aiMarks = null,
  approvedMarks = null,
  marksTotal = 5,
  status = 'published',
  reviewRevision = 0,
  regradedRevision = 0,
  updatedAt = '2026-07-24T11:00:00.000Z',
  includeLegacy = true,
} = {}) {
  const statements = [
    { sql: 'INSERT OR IGNORE INTO schools (id, display_name, slug) VALUES (?, ?, ?)', args: [schoolId, school, schoolId] },
    { sql: 'INSERT OR IGNORE INTO subjects (id, school_id, name) VALUES (?, ?, ?)', args: [subjectId, schoolId, subject] },
    { sql: 'INSERT OR IGNORE INTO students (id, display_name) VALUES (?, ?)', args: [studentId, studentName] },
    { sql: 'INSERT OR IGNORE INTO exams (id, source_test_id, school_id, subject_id, name, grade, status) VALUES (?, ?, ?, ?, ?, ?, ?)', args: [examId, `test_${examId}`, schoolId, subjectId, `${subject} Exam`, '12', 'published'] },
    { sql: 'INSERT OR IGNORE INTO exam_sets (id, exam_id, set_code) VALUES (?, ?, ?)', args: [setId, examId, 'A'] },
    { sql: `INSERT OR IGNORE INTO exam_set_questions (id, set_id, question_number, question_text, answer_key_text, max_marks, rubric_json)
            VALUES (?, ?, ?, '', '', ?, '{}')`, args: [setQuestionId, setId, questionNumber, marksTotal] },
    { sql: 'INSERT OR IGNORE INTO submissions (id, exam_id, student_id, status, score, max_marks) VALUES (?, ?, ?, ?, NULL, ?)', args: [submissionId, examId, studentId, status, marksTotal] },
    { sql: 'INSERT OR IGNORE INTO test_submissions (id, test_id, student_id, status) VALUES (?, ?, ?, ?)', args: [submissionId, `test_${examId}`, studentId, status] },
    {
      sql: `INSERT INTO submission_questions_v2 (
              id, submission_id, exam_set_question_id, question_number, ai_marks, approved_marks,
              status, review_revision, regraded_revision, evidence_json, source_asset_ids_json,
              created_at, updated_at, render_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', '[]', ?, ?, ?)`,
      args: [questionId, submissionId, setQuestionId, questionNumber, aiMarks, approvedMarks, status, reviewRevision, regradedRevision, updatedAt, updatedAt, payloadJson],
    },
  ];
  if (includeLegacy) {
    statements.push({
      sql: `INSERT INTO submission_questions (
              id, submission_id, school, subject, question_number, student_name,
              payload_json, ai_marks, approved_marks, marks_total, status,
              review_revision, regraded_revision, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [questionId, submissionId, school, subject, questionNumber, studentName, payloadJson, aiMarks, approvedMarks, marksTotal, status, reviewRevision, regradedRevision, updatedAt],
    });
  }
  return statements;
}
