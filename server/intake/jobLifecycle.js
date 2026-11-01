/**
 * Canonical lifecycle for every assessment processing run.
 *
 * Queue producers create a job in `queued`. A processor must claim it before
 * doing work, record each phase, then finish it as succeeded or failed. This
 * keeps dashboards truthful even while local processors are being migrated to
 * Cloudflare Workers.
 */

export const JOB_STATUS = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED_RETRYABLE: 'failed_retryable',
  FAILED_BLOCKED: 'failed_blocked',
  CANCELLED: 'cancelled',
});

export const WORKFLOW_STEPS = Object.freeze([
  'validate_inputs',
  'parse_key',
  'ocr',
  'evidence',
  'visual_rescue',
  'grade',
  'quality_gate',
  'build_reports',
  'ready_for_review',
]);

const TERMINAL_JOB_STATUSES = new Set([
  JOB_STATUS.SUCCEEDED,
  JOB_STATUS.FAILED_RETRYABLE,
  JOB_STATUS.FAILED_BLOCKED,
  JOB_STATUS.CANCELLED,
]);

function now() { return new Date().toISOString(); }

async function readJob(db, jobId) {
  const result = await db.execute({ sql: 'SELECT * FROM processing_jobs WHERE id = ?', args: [jobId] });
  return result.rows[0] || null;
}

function assertWorker(workerId) {
  if (!String(workerId || '').trim()) throw new Error('A stable worker ID is required to claim a processing job.');
}

function assertStep(step) {
  if (!WORKFLOW_STEPS.includes(step)) throw new Error(`Unsupported workflow step: ${step}`);
}

/**
 * Atomically claim a queued job. Returning null means another processor has
 * already claimed it or the job is no longer queued; callers must not process.
 */
export async function claimJob(db, { jobId, workerId }) {
  assertWorker(workerId);
  const claimedAt = now();
  await db.execute({
    sql: `UPDATE processing_jobs
          SET status = ?, started_at = ?, worker_id = ?, error = NULL
          WHERE id = ? AND status = ?`,
    args: [JOB_STATUS.RUNNING, claimedAt, workerId, jobId, JOB_STATUS.QUEUED],
  });
  const job = await readJob(db, jobId);
  if (!job || job.status !== JOB_STATUS.RUNNING || job.worker_id !== workerId) return null;
  await db.execute({
    sql: "UPDATE tests SET status = 'processing', updated_at = ? WHERE id = ?",
    args: [claimedAt, job.test_id],
  });
  return job;
}

export async function startStep(db, { jobId, workerId, step, detail = null }) {
  assertWorker(workerId); assertStep(step);
  const job = await readJob(db, jobId);
  if (!job || job.status !== JOB_STATUS.RUNNING || job.worker_id !== workerId) {
    throw new Error('Only the worker that claimed a running job can start a workflow step.');
  }
  const progress = JSON.parse(job.progress_json || '{}');
  const steps = progress.steps || {};
  steps[step] = { status: 'running', detail, started_at: now(), completed_at: null };
  await db.execute({ sql: 'UPDATE processing_jobs SET progress_json = ? WHERE id = ?', args: [JSON.stringify({ ...progress, steps }), jobId] });
}

export async function completeStep(db, { jobId, workerId, step, detail = null }) {
  assertWorker(workerId); assertStep(step);
  const job = await readJob(db, jobId);
  if (!job || job.status !== JOB_STATUS.RUNNING || job.worker_id !== workerId) {
    throw new Error('Only the worker that claimed a running job can complete a workflow step.');
  }
  const progress = JSON.parse(job.progress_json || '{}');
  const steps = progress.steps || {};
  if (!steps[step]) throw new Error(`Cannot complete ${step} before it has started.`);
  steps[step] = { ...steps[step], status: 'succeeded', detail, completed_at: now() };
  await db.execute({ sql: 'UPDATE processing_jobs SET progress_json = ? WHERE id = ?', args: [JSON.stringify({ ...progress, steps }), jobId] });
}

export async function finishJob(db, { jobId, workerId, result = {} }) {
  assertWorker(workerId);
  const job = await readJob(db, jobId);
  if (!job || job.status !== JOB_STATUS.RUNNING || job.worker_id !== workerId) {
    throw new Error('Only the worker that claimed a running job can finish it.');
  }
  const completedAt = now();
  await db.batch([
    { sql: 'UPDATE processing_jobs SET status = ?, completed_at = ?, result_json = ?, error = NULL WHERE id = ?', args: [JOB_STATUS.SUCCEEDED, completedAt, JSON.stringify(result), jobId] },
    { sql: "UPDATE tests SET status = 'ready_for_review', updated_at = ? WHERE id = ?", args: [completedAt, job.test_id] },
  ], 'write');
}

export async function failJob(db, { jobId, workerId, error, retryable = true }) {
  assertWorker(workerId);
  const job = await readJob(db, jobId);
  if (!job || job.status !== JOB_STATUS.RUNNING || job.worker_id !== workerId) {
    throw new Error('Only the worker that claimed a running job can fail it.');
  }
  const status = retryable ? JOB_STATUS.FAILED_RETRYABLE : JOB_STATUS.FAILED_BLOCKED;
  const completedAt = now();
  await db.batch([
    { sql: 'UPDATE processing_jobs SET status = ?, completed_at = ?, error = ? WHERE id = ?', args: [status, completedAt, String(error || 'Processing failed'), jobId] },
    { sql: "UPDATE tests SET status = 'processing_failed', updated_at = ? WHERE id = ?", args: [completedAt, job.test_id] },
  ], 'write');
}

export function isTerminalJobStatus(status) {
  return TERMINAL_JOB_STATUSES.has(status);
}
