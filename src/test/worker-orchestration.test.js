// @vitest-environment node
/* global process */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * Harness for the worker's orchestration layer (apps/processing-worker/index.js).
 *
 * The module validates env, opens the database and starts polling at import
 * time. With WORKER_AUTOSTART=0 and a disposable file: database it can be
 * imported and its exported job-lifecycle functions driven directly against
 * the real SQL, which no mock-based test can prove.
 */

// Column definitions mirror api/_lib/intake.js (base tables) plus migrations
// 019_processing_job_hardening, 053_worker_lease_reclaim_count and
// 001_canonical_assessment_core.
const SCHEMA = [
  'CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)',
  `CREATE TABLE processing_jobs (
    id TEXT PRIMARY KEY, test_id TEXT NOT NULL, school TEXT NOT NULL, type TEXT NOT NULL,
    status TEXT NOT NULL, payload_json TEXT NOT NULL, requested_by TEXT NOT NULL,
    requested_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, worker_id TEXT, error TEXT, result_json TEXT,
    progress_json TEXT,
    heartbeat_at TEXT, lease_expires_at TEXT, attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT, last_error_code TEXT, lease_reclaim_count INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE tests (
    id TEXT PRIMARY KEY, school TEXT NOT NULL, title TEXT NOT NULL, subject TEXT NOT NULL,
    grade TEXT NOT NULL, status TEXT NOT NULL, created_by TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE worker_heartbeats (
    worker_id TEXT PRIMARY KEY, service TEXT NOT NULL, version TEXT, status TEXT NOT NULL,
    active_job_id TEXT, details_json TEXT, last_seen_at TEXT NOT NULL, started_at TEXT NOT NULL
  )`,
  `CREATE TABLE test_submissions (
    id TEXT PRIMARY KEY, test_id TEXT NOT NULL, student_id TEXT NOT NULL, batch_id TEXT,
    status TEXT NOT NULL, active_asset_revision INTEGER NOT NULL DEFAULT 1, current_workflow_run_id TEXT,
    score REAL, max_marks REAL, review_status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(test_id, student_id)
  )`,
  `CREATE TABLE submission_questions (
    id TEXT PRIMARY KEY, submission_id TEXT NOT NULL, question_id TEXT NOT NULL, question_number TEXT NOT NULL,
    question_text TEXT, answer_key_text TEXT, rubric_json TEXT, evidence_json TEXT NOT NULL,
    source_asset_ids_json TEXT NOT NULL, ai_marks REAL, approved_marks REAL, marks_total REAL,
    status TEXT NOT NULL, review_revision INTEGER NOT NULL DEFAULT 0, regraded_revision INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, school TEXT, subject TEXT, student_name TEXT, payload_json TEXT,
    UNIQUE(submission_id, question_id)
  )`,
  `CREATE TABLE regrade_runs (
    id TEXT PRIMARY KEY, scope TEXT, status TEXT NOT NULL, requested_by TEXT, requested_at TEXT,
    started_at TEXT, completed_at TEXT, worker_id TEXT, heartbeat_at TEXT, attempt_count INTEGER DEFAULT 0, error TEXT
  )`,
];
const TABLES = ['processing_jobs', 'tests', 'worker_heartbeats', 'test_submissions', 'submission_questions', 'regrade_runs'];

let directory;
let worker;
const AT = '2026-10-07T09:00:00.000Z';
// Lease comparisons use the worker's real clock, so "expired" must be relative to now.
const PAST = new Date(Date.now() - 60 * 60_000).toISOString();
const FUTURE = '2999-01-01T00:00:00.000Z';

async function insertJob(overrides = {}) {
  const job = {
    id: 'job_1', test_id: 'test_1', school: 'Alpha School', type: 'mistral_ocr', status: 'queued',
    payload_json: '{}', requested_by: 'admin', requested_at: AT, progress_json: null,
    worker_id: null, lease_expires_at: null, attempt_count: 0, lease_reclaim_count: 0, next_attempt_at: null,
    ...overrides,
  };
  await worker.db.execute({
    sql: `INSERT INTO processing_jobs (id, test_id, school, type, status, payload_json, requested_by, requested_at, progress_json,
            worker_id, lease_expires_at, attempt_count, lease_reclaim_count, next_attempt_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [job.id, job.test_id, job.school, job.type, job.status, job.payload_json, job.requested_by, job.requested_at, job.progress_json,
      job.worker_id, job.lease_expires_at, job.attempt_count, job.lease_reclaim_count, job.next_attempt_at],
  });
  return job;
}

async function insertTest(id = 'test_1', status = 'ocr_queued') {
  await worker.db.execute({
    sql: 'INSERT INTO tests (id, school, title, subject, grade, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    args: [id, 'Alpha School', 'Unit test', 'Physics', '11', status, 'admin', AT, AT],
  });
}

const jobRow = async (id = 'job_1') => (await worker.db.execute({ sql: 'SELECT * FROM processing_jobs WHERE id = ?', args: [id] })).rows[0];
const testStatus = async (id = 'test_1') => (await worker.db.execute({ sql: 'SELECT status FROM tests WHERE id = ?', args: [id] })).rows[0]?.status;

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'skyll-worker-harness-'));
  const url = `file:${path.join(directory, 'worker.db').replaceAll('\\', '/')}`;
  Object.assign(process.env, {
    // api/_lib/auth.js builds a web libsql client from TURSO_DATABASE_URL at
    // import time and rejects file: URLs; it never connects in these tests.
    // The worker itself reads WORKER_DB_URL first and opens the file database.
    TURSO_DATABASE_URL: 'libsql://worker-harness.invalid',
    WORKER_DB_URL: url,
    TURSO_AUTH_TOKEN: 'x',
    S3_ENDPOINT: 'https://r2.example.invalid',
    S3_BUCKET: 'test-bucket',
    S3_REGION: 'auto',
    R2_ACCESS_KEY_ID: 'x',
    R2_SECRET_ACCESS_KEY: 'x',
    DATALAB_API_KEY: 'x',
    DEEPINFRA_API_KEY: 'x',
    WORKER_AUTOSTART: '0',
    OCR_ENGINE: 'datalab',
    PROCESSING_JOB_MAX_ATTEMPTS: '3',
    PROCESSING_JOB_RETRY_BASE_MS: '60000',
    PROCESSING_JOB_LEASE_MS: '300000',
    PROCESSING_SCHOOL: '',
    PROCESSING_TEST_ID: '',
    PROCESSING_JOB_TYPES: '',
    ALERT_WEBHOOK_URL: '',
  });
  worker = await import('../../apps/processing-worker/index.js');
  await worker.db.batch(SCHEMA.map((sql) => ({ sql })), 'write');
}, 20_000);

afterAll(async () => {
  worker?.db?.close?.();
  if (directory) await rm(directory, { recursive: true, force: true });
});

beforeEach(async () => {
  await worker.db.batch(TABLES.map((table) => ({ sql: `DELETE FROM ${table}` })), 'write');
});

describe('worker module boundary', () => {
  it('imports without starting the poll loop and exposes the orchestration functions', () => {
    for (const name of ['queueJob', 'claimNextJob', 'reclaimExpiredJobs', 'failJob', 'releaseCompletedJob', 'reconcileEvidenceGradeJobs', 'ungradedQuestionCount', 'heartbeatJob', 'assertWorkerSchema']) {
      expect(typeof worker[name], name).toBe('function');
    }
    expect(worker.workerId).toMatch(/^oci-/);
    expect(process.listenerCount('SIGTERM')).toBe(0);
  });

  it('asserts the schema migrations the worker depends on, including 071, 072 and 089', async () => {
    await expect(worker.assertWorkerSchema()).rejects.toThrow('019_processing_job_hardening');
    await worker.db.batch(['019_processing_job_hardening', '053_worker_lease_reclaim_count', '071_regrade_item_lease', '072_submission_graded_at', '089_exam_release']
      .map((id) => ({ sql: 'INSERT INTO schema_migrations (id, applied_at, checksum) VALUES (?, ?, ?)', args: [id, AT, 'test'] })), 'write');
    await expect(worker.assertWorkerSchema()).resolves.toBeUndefined();
    await worker.db.execute("DELETE FROM schema_migrations WHERE id = '089_exam_release'");
    await expect(worker.assertWorkerSchema()).rejects.toThrow('089_exam_release');
    await worker.db.execute("DELETE FROM schema_migrations WHERE id = '072_submission_graded_at'");
    await expect(worker.assertWorkerSchema()).rejects.toThrow('072_submission_graded_at');
    await worker.db.execute("DELETE FROM schema_migrations WHERE id = '071_regrade_item_lease'");
    await expect(worker.assertWorkerSchema()).rejects.toThrow('071_regrade_item_lease');
  });
});

describe('claiming', () => {
  it('claims a queued job exclusively for this worker and counts the attempt', async () => {
    await insertTest();
    await insertJob();
    const job = await worker.claimNextJob();
    expect(job).toMatchObject({ id: 'job_1', status: 'running', worker_id: worker.workerId, attempt_count: 1 });
    expect(job.lease_expires_at).toBeTruthy();
    expect(await testStatus()).toBe('ocr_processing');
    // Nothing else is queued, and the running job is not re-claimable.
    expect(await worker.claimNextJob()).toBeNull();
    expect((await jobRow()).attempt_count).toBe(1);
  });

  it('never claims a job another worker is running', async () => {
    await insertJob({ id: 'job_other', status: 'running', worker_id: 'oci-other', lease_expires_at: FUTURE, attempt_count: 1 });
    expect(await worker.claimNextJob()).toBeNull();
    expect(await jobRow('job_other')).toMatchObject({ status: 'running', worker_id: 'oci-other', attempt_count: 1 });
  });

  it('does not count a reclaimed job as a fresh attempt', async () => {
    await insertJob({ attempt_count: 2, progress_json: JSON.stringify({ phase: 'reclaimed', is_reclaim: 1 }) });
    const job = await worker.claimNextJob();
    expect(job.attempt_count).toBe(2);
  });

  it('heartbeats extend the lease and record the worker as busy', async () => {
    await insertJob();
    const job = await worker.claimNextJob();
    await worker.db.execute({ sql: 'UPDATE processing_jobs SET lease_expires_at = ? WHERE id = ?', args: [PAST, job.id] });
    await worker.heartbeatJob(job, 'ocr:1/3');
    const row = await jobRow();
    expect(row.lease_expires_at > PAST).toBe(true);
    expect(JSON.parse(row.progress_json).phase).toBe('ocr:1/3');
    const beat = (await worker.db.execute({ sql: 'SELECT active_job_id, status FROM worker_heartbeats WHERE worker_id = ?', args: [worker.workerId] })).rows[0];
    expect(beat).toMatchObject({ active_job_id: 'job_1', status: 'healthy' });
  });
});

describe('failing', () => {
  it('requeues a retryable failure with backoff and moves the test to *_queued', async () => {
    await insertTest('test_1', 'ocr_processing');
    await insertJob();
    const job = await worker.claimNextJob();
    const result = await worker.failJob(job, new Error('Datalab OCR failed (503)'));
    expect(result).toEqual({ retryable: true, attempts: 1 });
    const row = await jobRow();
    expect(row).toMatchObject({ status: 'queued', worker_id: null, error: 'Datalab OCR failed (503)', last_error_code: 'error' });
    expect(row.next_attempt_at).toBeTruthy();
    expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
    expect(await testStatus()).toBe('ocr_queued');
  });

  it('ends failed_retryable with *_failed once attempts are exhausted', async () => {
    await insertTest('test_1', 'grading_processing');
    await insertJob({ type: 'grade_submission', attempt_count: 2 });
    const job = await worker.claimNextJob();
    expect(job.attempt_count).toBe(3);
    const result = await worker.failJob(job, new Error('model timeout'));
    expect(result).toEqual({ retryable: false, attempts: 3 });
    expect(await jobRow()).toMatchObject({ status: 'failed_retryable', worker_id: null, next_attempt_at: null });
    expect(await testStatus()).toBe('grading_failed');
  });

  it('honours error.retryable === false immediately and names the OCR failure code', async () => {
    await insertTest('test_1', 'ocr_processing');
    await insertJob();
    const job = await worker.claimNextJob();
    const error = new Error('OCR failed for 1 of 3 asset(s): Asha answer_sheet (asset_9): Unsupported file type');
    error.retryable = false;
    error.code = 'ocr_assets_failed';
    await worker.failJob(job, error);
    expect(await jobRow()).toMatchObject({ status: 'failed_retryable', last_error_code: 'ocr_assets_failed' });
    expect(await testStatus()).toBe('ocr_failed');
  });

  it('does not drag a test whose rubric is already built back to ocr_queued while OCR retries', async () => {
    await insertTest('test_1', 'rubric_ready_for_review');
    await insertJob();
    const job = await worker.claimNextJob();
    expect(await testStatus()).toBe('rubric_ready_for_review');
    await worker.failJob(job, new Error('transient'));
    expect(await testStatus()).toBe('rubric_ready_for_review');
    expect((await jobRow()).status).toBe('queued');
  });

  it('releases a completed job without touching its succeeded status', async () => {
    await insertJob();
    const job = await worker.claimNextJob();
    await worker.db.execute({ sql: "UPDATE processing_jobs SET status = 'succeeded' WHERE id = ?", args: [job.id] });
    await worker.releaseCompletedJob(job);
    expect(await jobRow()).toMatchObject({ status: 'succeeded', worker_id: null, lease_expires_at: null });
  });
});

describe('reclaiming expired leases', () => {
  it('requeues an expired running job and counts the reclaim separately from attempts', async () => {
    await insertTest('test_1', 'evidence_processing');
    await insertJob({ type: 'materialize_evidence', status: 'running', worker_id: 'oci-dead', lease_expires_at: PAST, attempt_count: 1 });
    expect(await worker.reclaimExpiredJobs()).toBe(1);
    const row = await jobRow();
    expect(row).toMatchObject({ status: 'queued', worker_id: null, lease_reclaim_count: 1, attempt_count: 1 });
    expect(row.next_attempt_at).toBeTruthy();
    expect(JSON.parse(row.progress_json)).toMatchObject({ phase: 'reclaimed', is_reclaim: 1, reclaim_count: 1 });
    expect(await testStatus()).toBe('evidence_processing');
  });

  it('marks the job failed_retryable AND the test *_failed when reclaims are exhausted', async () => {
    await insertTest('test_1', 'evidence_processing');
    await insertJob({ type: 'materialize_evidence', status: 'running', worker_id: 'oci-dead', lease_expires_at: PAST, attempt_count: 1, lease_reclaim_count: 2 });
    await worker.reclaimExpiredJobs();
    expect(await jobRow()).toMatchObject({ status: 'failed_retryable', lease_reclaim_count: 3, last_error_code: 'worker_lease_expired', next_attempt_at: null });
    expect(await testStatus()).toBe('evidence_failed');
  });

  it('leaves live leases alone', async () => {
    await insertJob({ status: 'running', worker_id: 'oci-live', lease_expires_at: FUTURE });
    expect(await worker.reclaimExpiredJobs()).toBe(0);
    expect(await jobRow()).toMatchObject({ status: 'running', worker_id: 'oci-live' });
  });
});

describe('queueing', () => {
  it('dedupes test-level job types against queued/running jobs and fans out per-question grading', async () => {
    const first = await worker.queueJob({ testId: 'test_1', school: 'Alpha School', type: 'build_reports', payload: {}, requestedBy: 'admin', step: 'build_reports', detail: 'first' });
    const second = await worker.queueJob({ testId: 'test_1', school: 'Alpha School', type: 'build_reports', payload: {}, requestedBy: 'admin', step: 'build_reports', detail: 'second' });
    expect(second).toBe(first);
    const reports = await worker.db.execute("SELECT COUNT(*) AS count FROM processing_jobs WHERE type = 'build_reports'");
    expect(Number(reports.rows[0].count)).toBe(1);

    const gradeA = await worker.queueJob({ testId: 'test_1', school: 'Alpha School', type: 'grade_submission', payload: { submissionQuestionId: 'sq_a' }, requestedBy: 'admin', step: 'grade', detail: 'a' });
    const gradeADuplicate = await worker.queueJob({ testId: 'test_1', school: 'Alpha School', type: 'grade_submission', payload: { submissionQuestionId: 'sq_a' }, requestedBy: 'admin', step: 'grade', detail: 'a again' });
    const gradeB = await worker.queueJob({ testId: 'test_1', school: 'Alpha School', type: 'grade_submission', payload: { submissionQuestionId: 'sq_b' }, requestedBy: 'admin', step: 'grade', detail: 'b' });
    expect(gradeADuplicate).toBe(gradeA);
    expect(gradeB).not.toBe(gradeA);
  });

  it('dedupes a test-level job only against active jobs, not finished ones', async () => {
    await insertJob({ id: 'job_done', type: 'build_reports', status: 'succeeded' });
    const next = await worker.queueJob({ testId: 'test_1', school: 'Alpha School', type: 'build_reports', payload: {}, requestedBy: 'admin', step: 'build_reports', detail: 'again' });
    expect(next).not.toBe('job_done');
  });
});

describe('reconciling evidence into grade jobs', () => {
  async function seedQuestions(statuses, { visualHeldQuestionId = null, rubric = { expected_response_type: 'short_answer' } } = {}) {
    await worker.db.execute({ sql: "INSERT INTO test_submissions (id, test_id, student_id, status, created_at, updated_at) VALUES ('sub_1', 'test_1', 'stu_1', 'evidence_ready', ?, ?)", args: [AT, AT] });
    let index = 0;
    for (const [questionId, status] of Object.entries(statuses)) {
      index += 1;
      await worker.db.execute({
        sql: `INSERT INTO submission_questions (id, submission_id, question_id, question_number, rubric_json, evidence_json, source_asset_ids_json, marks_total, status, created_at, updated_at, school, subject, student_name, payload_json)
              VALUES (?, 'sub_1', ?, ?, ?, '{}', '[]', 2, ?, ?, ?, 'Alpha School', 'Physics', 'Asha', '{}')`,
        args: [questionId, `rubric_${index}`, `Q${index}`, JSON.stringify(rubric), status, AT, AT],
      });
    }
    if (visualHeldQuestionId) {
      await insertJob({ id: 'job_visual', type: 'visual_rescue', status: 'queued', payload_json: JSON.stringify({ submissionQuestionId: visualHeldQuestionId }) });
    }
  }

  it('holds questions with a pending visual_rescue and queues grading for the rest', async () => {
    await seedQuestions({ sq_visual: 'evidence_ready', sq_text: 'evidence_ready', sq_done: 'graded' }, { visualHeldQuestionId: 'sq_visual' });
    const gradable = await worker.reconcileEvidenceGradeJobs('test_1', 'Alpha School', 'admin');
    expect(gradable).toBe(1);
    const grades = await worker.db.execute("SELECT payload_json FROM processing_jobs WHERE type = 'grade_submission'");
    expect(grades.rows.map((row) => JSON.parse(row.payload_json).submissionQuestionId)).toEqual(['sq_text']);
  });

  it('holds questions whose visual rescue was unverified', async () => {
    await worker.db.execute({ sql: "INSERT INTO test_submissions (id, test_id, student_id, status, created_at, updated_at) VALUES ('sub_1', 'test_1', 'stu_1', 'evidence_ready', ?, ?)", args: [AT, AT] });
    await worker.db.execute({
      sql: `INSERT INTO submission_questions (id, submission_id, question_id, question_number, rubric_json, evidence_json, source_asset_ids_json, marks_total, status, created_at, updated_at, school, subject, student_name, payload_json)
            VALUES ('sq_unverified', 'sub_1', 'rubric_1', 'Q1', '{}', '{}', '[]', 2, 'evidence_ready', ?, ?, 'Alpha School', 'Physics', 'Asha', ?)`,
      args: [AT, AT, JSON.stringify({ reviewTags: ['visual_evidence_unverified'] })],
    });
    expect(await worker.reconcileEvidenceGradeJobs('test_1', 'Alpha School', 'admin')).toBe(0);
    const grades = await worker.db.execute("SELECT COUNT(*) AS count FROM processing_jobs WHERE type = 'grade_submission'");
    expect(Number(grades.rows[0].count)).toBe(0);
  });

  it('batches an all-MCQ submission into one grade job', async () => {
    await seedQuestions({ sq_1: 'evidence_ready', sq_2: 'evidence_ready' }, { rubric: { expected_response_type: 'mcq' } });
    expect(await worker.reconcileEvidenceGradeJobs('test_1', 'Alpha School', 'admin')).toBe(2);
    const grades = await worker.db.execute("SELECT payload_json FROM processing_jobs WHERE type = 'grade_submission'");
    expect(grades.rows.map((row) => JSON.parse(row.payload_json))).toEqual([{ submissionId: 'sub_1' }]);
  });
});

describe('report readiness', () => {
  it('counts only pending/evidence_ready questions as blocking reports', async () => {
    await worker.db.execute({ sql: "INSERT INTO test_submissions (id, test_id, student_id, status, created_at, updated_at) VALUES ('sub_1', 'test_1', 'stu_1', 'graded', ?, ?)", args: [AT, AT] });
    const statuses = { sq_a: 'graded', sq_b: 'evidence_blocked', sq_c: 'regraded', sq_d: 'approved', sq_e: 'ready_for_review' };
    let index = 0;
    for (const [id, status] of Object.entries(statuses)) {
      index += 1;
      await worker.db.execute({
        sql: `INSERT INTO submission_questions (id, submission_id, question_id, question_number, evidence_json, source_asset_ids_json, status, created_at, updated_at)
              VALUES (?, 'sub_1', ?, ?, '{}', '[]', ?, ?, ?)`,
        args: [id, `rubric_${index}`, `Q${index}`, status, AT, AT],
      });
    }
    expect(await worker.ungradedQuestionCount('test_1')).toBe(0);
    await worker.db.execute("UPDATE submission_questions SET status = 'evidence_ready' WHERE id = 'sq_a'");
    await worker.db.execute("UPDATE submission_questions SET status = 'pending' WHERE id = 'sq_b'");
    expect(await worker.ungradedQuestionCount('test_1')).toBe(2);
  });
});
