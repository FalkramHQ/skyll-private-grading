import { database, ensureAuthTables, requireUser } from '../../api/_lib/auth.js';
import { ensureIntakeTables } from '../../api/_lib/intake.js';
import { inActorSchool } from '../../api/_lib/schoolScope.js';
import { internalError } from '../../api/_lib/httpError.js';

/**
 * POST /api/auth/operations/jobs — manual recovery for the processing pipeline.
 *
 *   { action: 'retry_failed_jobs', testId }  reset every failed job of a test
 *   { action: 'retry_job', jobId }           reset one failed job
 *   { action: 'reconcile_status', testId }   recompute tests.status from job history
 *
 * Admins may act on their own school's tests; platform admins on any test.
 * Hive side jobs (deep signals, synthesis, mastery) are reset alongside the
 * pipeline jobs but never drive tests.status — the worker ignores them too.
 */

export const PIPELINE_STAGES = Object.freeze(['mistral_ocr', 'build_rubric', 'materialize_evidence', 'visual_rescue', 'grade_submission', 'build_reports']);

export const QUEUED_TEST_STATUS = Object.freeze({
  mistral_ocr: 'ocr_queued',
  build_rubric: 'rubric_queued',
  materialize_evidence: 'evidence_queued',
  visual_rescue: 'visual_rescue_queued',
  grade_submission: 'grading_queued',
  build_reports: 'report_queued',
});

export const FAILED_TEST_STATUS = Object.freeze({
  mistral_ocr: 'ocr_failed',
  build_rubric: 'rubric_failed',
  materialize_evidence: 'evidence_failed',
  visual_rescue: 'visual_rescue_failed',
  grade_submission: 'grading_failed',
  build_reports: 'report_failed',
});

// The status the worker records once a stage has fully succeeded. These are
// what reconcile_status restores when the stage finished but the follow-up
// transition was lost (worker crash between the batch and the next enqueue).
const SUCCEEDED_TEST_STATUS = Object.freeze({
  mistral_ocr: 'ocr_succeeded',
  build_rubric: 'rubric_ready_for_review',
  materialize_evidence: 'grading_queued',
  visual_rescue: 'grading_queued',
  grade_submission: 'report_queued',
  build_reports: 'ready_for_review',
});

// Stages that fan out into many jobs per test; every job in the current round
// must succeed for the stage to count as succeeded.
const FAN_OUT_STAGES = new Set(['visual_rescue', 'grade_submission']);

// Statuses that reflect a human or publication decision; reconciliation never
// overwrites them from job history alone.
const HUMAN_OWNED_TEST_STATUSES = new Set(['published', 'cancelled', 'report_blocked']);

const RESETTABLE_JOB_STATUSES = ['failed_retryable', 'failed'];
const ACTIVE_JOB_STATUSES = ['queued', 'running'];

const ACTIONS = new Set(['retry_failed_jobs', 'retry_job', 'reconcile_status']);

function fail(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

function isFailed(status) {
  return String(status || '').startsWith('failed');
}

function stageOrder(type) {
  return PIPELINE_STAGES.indexOf(type);
}

/**
 * The tests.status to set when the given job types are re-queued: the
 * *_queued status of the earliest pipeline stage among them, or null when
 * only hive side jobs are involved.
 */
export function retryTargetStatus(types = []) {
  const stages = [...new Set(types)].filter((type) => stageOrder(type) >= 0).sort((a, b) => stageOrder(a) - stageOrder(b));
  return stages.length ? QUEUED_TEST_STATUS[stages[0]] : null;
}

/**
 * Recompute a test's status from its job history. Rules, in order:
 *
 *  1. Human-owned statuses (published, cancelled, report_blocked) are kept.
 *  2. Only the current round is considered: jobs requested at or after the
 *     newest build_rubric job, since a rubric rebuild invalidates all later
 *     grading work. With no rubric job, every job counts.
 *  3. Single-run stages (OCR, rubric, evidence, reports) are judged by their
 *     newest job; fan-out stages (visual rescue, grading) by every job in the
 *     round. Hive side jobs are ignored.
 *  4. If any stage has a failed job, the status is the *_failed status of the
 *     EARLIEST failed stage — downstream stages depend on it.
 *  5. Otherwise the status recorded for the LAST fully succeeded stage
 *     (build_reports → ready_for_review, grading → report_queued, ...).
 *  6. With no pipeline jobs at all, the status is left unchanged.
 *
 * Callers must verify no job is queued or running before applying the result.
 * Returns { status, changed, reason }.
 */
export function reconciledTestStatus(jobs = [], currentStatus = null) {
  const current = String(currentStatus || '').trim().toLowerCase();
  if (HUMAN_OWNED_TEST_STATUSES.has(current)) return { status: current, changed: false, reason: 'human_owned_status' };

  const pipelineJobs = jobs.filter((job) => stageOrder(job.type) >= 0);
  if (!pipelineJobs.length) return { status: current, changed: false, reason: 'no_pipeline_jobs' };

  const byRequested = (a, b) => String(a.requested_at || '').localeCompare(String(b.requested_at || ''));
  const newestRubric = pipelineJobs.filter((job) => job.type === 'build_rubric').sort(byRequested).at(-1);
  const roundStart = newestRubric?.requested_at || null;
  const round = roundStart ? pipelineJobs.filter((job) => String(job.requested_at || '') >= roundStart) : pipelineJobs;

  let earliestFailedStage = null;
  let lastSucceededStage = null;
  for (const stage of PIPELINE_STAGES) {
    const stageJobs = round.filter((job) => job.type === stage).sort(byRequested);
    if (!stageJobs.length) continue;
    const judged = FAN_OUT_STAGES.has(stage) ? stageJobs : [stageJobs.at(-1)];
    if (judged.some((job) => isFailed(job.status))) {
      if (earliestFailedStage === null) earliestFailedStage = stage;
    } else if (judged.every((job) => job.status === 'succeeded')) {
      lastSucceededStage = stage;
    }
  }

  if (earliestFailedStage) {
    const status = FAILED_TEST_STATUS[earliestFailedStage];
    return { status, changed: status !== current, reason: `failed_${earliestFailedStage}` };
  }
  if (lastSucceededStage) {
    const status = SUCCEEDED_TEST_STATUS[lastSucceededStage];
    return { status, changed: status !== current, reason: `succeeded_${lastSucceededStage}` };
  }
  return { status: current, changed: false, reason: 'no_completed_stage' };
}

function resetJobsSql(where) {
  return `UPDATE processing_jobs
          SET status = 'queued', attempt_count = 0, lease_reclaim_count = 0, error = NULL, last_error_code = NULL,
              next_attempt_at = NULL, worker_id = NULL, completed_at = NULL, heartbeat_at = NULL, lease_expires_at = NULL
          WHERE ${where} AND status IN (${RESETTABLE_JOB_STATUSES.map((status) => `'${status}'`).join(', ')})`;
}

// Stage jobs that may have only one queued or running row per test
// (migration 088). Retrying must never create a second active one.
const SINGLETON_JOB_TYPES = new Set(['mistral_ocr', 'build_rubric', 'process_test']);

const isUniqueViolation = (error) => /UNIQUE constraint failed/i.test(String(error?.message || error?.cause?.message || ''));

async function activeJobTypes(db, testId) {
  const result = await db.execute({
    sql: `SELECT DISTINCT type FROM processing_jobs WHERE test_id = ? AND status IN ('queued', 'running')`,
    args: [testId],
  });
  return new Set(result.rows.map((row) => row.type));
}

async function loadAuthorizedTest(db, user, testId) {
  if (!testId) fail(400, 'testId is required');
  const result = await db.execute({ sql: 'SELECT id, school, school_id, status FROM tests WHERE id = ?', args: [testId] });
  const test = result.rows[0];
  // tests still carries the school name on legacy rows; inActorSchool compares
  // canonical ids and resolves the name only when school_id is missing.
  if (!test || (user.role !== 'skyll_admin' && !(await inActorSchool(db, user, { schoolId: test.school_id || null, schoolName: test.school })))) {
    fail(404, 'Test not found');
  }
  return test;
}

async function retryFailedJobs(db, user, testId) {
  const test = await loadAuthorizedTest(db, user, testId);
  const failed = await db.execute({
    sql: `SELECT id, type FROM processing_jobs WHERE test_id = ? AND status IN ('failed_retryable', 'failed')
          ORDER BY requested_at DESC`,
    args: [test.id],
  });
  if (!failed.rows.length) fail(409, 'This assessment has no failed jobs to retry.');
  // A stage job is retried once: its newest failed row, and only when no job of
  // that stage is already queued or running. Per-question jobs all retry.
  const active = await activeJobTypes(db, test.id);
  const seenStages = new Set();
  const retry = failed.rows.filter((row) => {
    if (!SINGLETON_JOB_TYPES.has(row.type)) return true;
    if (active.has(row.type) || seenStages.has(row.type)) return false;
    seenStages.add(row.type);
    return true;
  });
  if (!retry.length) fail(409, 'The failed stages are already queued or running again.');
  const now = new Date().toISOString();
  const testStatus = retryTargetStatus(retry.map((row) => row.type));
  const ids = retry.map((row) => row.id);
  const statements = [];
  for (let start = 0; start < ids.length; start += 200) {
    const chunk = ids.slice(start, start + 200);
    statements.push({ sql: resetJobsSql(`id IN (${chunk.map(() => '?').join(', ')})`), args: chunk });
  }
  if (testStatus) statements.push({ sql: 'UPDATE tests SET status = ?, updated_at = ? WHERE id = ?', args: [testStatus, now, test.id] });
  try {
    await db.batch(statements, 'write');
  } catch (error) {
    if (isUniqueViolation(error)) fail(409, 'A stage was queued again while retrying. Refresh and try again.');
    throw error;
  }
  return { ok: true, action: 'retry_failed_jobs', testId: test.id, jobsReset: ids.length, jobIds: ids, testStatus: testStatus || test.status, requestedBy: user.username };
}

async function retryJob(db, user, jobId) {
  if (!jobId) fail(400, 'jobId is required');
  const result = await db.execute({ sql: 'SELECT id, test_id, type, status FROM processing_jobs WHERE id = ?', args: [jobId] });
  const job = result.rows[0];
  if (!job) fail(404, 'Job not found');
  const test = await loadAuthorizedTest(db, user, job.test_id).catch(() => fail(404, 'Job not found'));
  if (!RESETTABLE_JOB_STATUSES.includes(job.status)) fail(409, `Only failed jobs can be retried (job is ${job.status}).`);
  if (SINGLETON_JOB_TYPES.has(job.type) && (await activeJobTypes(db, test.id)).has(job.type)) {
    fail(409, 'This stage is already queued or running for the assessment.');
  }
  const now = new Date().toISOString();
  const testStatus = retryTargetStatus([job.type]);
  const statements = [{ sql: resetJobsSql('id = ?'), args: [job.id] }];
  if (testStatus) statements.push({ sql: 'UPDATE tests SET status = ?, updated_at = ? WHERE id = ?', args: [testStatus, now, test.id] });
  try {
    await db.batch(statements, 'write');
  } catch (error) {
    if (isUniqueViolation(error)) fail(409, 'This stage is already queued or running for the assessment.');
    throw error;
  }
  return { ok: true, action: 'retry_job', testId: test.id, jobId: job.id, jobsReset: 1, testStatus: testStatus || test.status, requestedBy: user.username };
}

async function reconcileStatus(db, user, testId) {
  const test = await loadAuthorizedTest(db, user, testId);
  const jobs = await db.execute({
    sql: 'SELECT id, type, status, requested_at FROM processing_jobs WHERE test_id = ? ORDER BY requested_at',
    args: [test.id],
  });
  if (jobs.rows.some((job) => ACTIVE_JOB_STATUSES.includes(job.status))) fail(409, 'Jobs are still queued or running for this assessment; wait for them to finish.');
  const outcome = reconciledTestStatus(jobs.rows, test.status);
  if (outcome.changed) {
    await db.execute({ sql: 'UPDATE tests SET status = ?, updated_at = ? WHERE id = ?', args: [outcome.status, new Date().toISOString(), test.id] });
  }
  return { ok: true, action: 'reconcile_status', testId: test.id, previousStatus: test.status, testStatus: outcome.status, changed: outcome.changed, reason: outcome.reason };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    await ensureAuthTables();
    await ensureIntakeTables();
    const user = await requireUser(req, res, ['admin', 'skyll_admin']);
    if (!user) return;
    const { action, testId, jobId } = req.body || {};
    if (!ACTIONS.has(action)) return res.status(400).json({ error: 'Unsupported action', supportedActions: [...ACTIONS] });
    const db = database();
    if (action === 'retry_failed_jobs') return res.status(200).json(await retryFailedJobs(db, user, testId));
    if (action === 'retry_job') return res.status(200).json(await retryJob(db, user, jobId));
    return res.status(200).json(await reconcileStatus(db, user, testId));
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    return internalError(res, error, 'admin/operations/jobs');
  }
}
