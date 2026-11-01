export function retryDelayMs(attemptCount, baseMs = 60_000, maxMs = 15 * 60_000) {
  const attempt = Math.max(1, Number(attemptCount) || 1);
  return Math.min(Math.max(1_000, Number(maxMs) || 0), Math.max(1_000, Number(baseMs) || 0) * 2 ** (attempt - 1));
}

export function retryAt(attemptCount, { baseMs, maxMs, clock = Date.now } = {}) {
  return new Date(clock() + retryDelayMs(attemptCount, baseMs, maxMs)).toISOString();
}

export function leaseExpiresAt({ leaseMs, clock = Date.now } = {}) {
  return new Date(clock() + Math.max(60_000, Number(leaseMs) || 0)).toISOString();
}

/**
 * FLKRM-157: decision for a job whose lease expired mid-run.
 *
 * Reclaims are counted separately from retry attempts. A slow but healthy job
 * that outlives its lease is requeued and must NOT consume the retry budget that
 * is reserved for real failures. Only a job reclaimed `maxReclaims` times without
 * completing (i.e. genuinely stuck) is treated as exhausted.
 */
export function reclaimDecision({ leaseReclaimCount = 0, maxReclaims = 3 } = {}) {
  const reclaims = Math.max(0, Number(leaseReclaimCount) || 0) + 1;
  return { reclaims, exhausted: reclaims >= maxReclaims };
}

/**
 * FLKRM-157: should claiming a queued job count as a fresh processing attempt?
 *
 * A job that was requeued by `reclaimExpiredJobs` carries an `is_reclaim` marker
 * in its progress_json; re-claiming it mid-recovery must not inflate attempt_count
 * and eat the real retry budget. Fresh jobs always count as an attempt.
 */
export function shouldCountClaimAsAttempt(progressJson = '') {
  try {
    return !(JSON.parse(progressJson || '{}')?.is_reclaim === 1);
  } catch {
    return true;
  }
}

export function errorCode(error) {
  const value = String(error?.code || error?.name || 'processing_error').trim().toLowerCase();
  return value.replace(/[^a-z0-9_]+/g, '_').slice(0, 80) || 'processing_error';
}

/**
 * FLKRM-373: claim a queued job for this worker.
 *
 * A job carrying the `is_reclaim` marker (lease reclaim, or a release on
 * shutdown) does not count as a fresh attempt; see shouldCountClaimAsAttempt.
 */
export function claimJobStatement({ jobId, workerId, at, leaseExpiresAt: leaseUntil }) {
  return {
    sql: `UPDATE processing_jobs
          SET status = 'running', started_at = COALESCE(started_at, ?), worker_id = ?, error = NULL,
            heartbeat_at = ?, lease_expires_at = ?, next_attempt_at = NULL,
            progress_json = ?,
            attempt_count = COALESCE(attempt_count, 0) + CASE WHEN COALESCE(json_extract(COALESCE(progress_json, '{}'), '$.is_reclaim'), 0) = 1 THEN 0 ELSE 1 END
          WHERE id = ? AND status = 'queued'`,
    args: [at, workerId, at, leaseUntil, JSON.stringify({ phase: 'claimed', updatedAt: at }), jobId],
  };
}

/**
 * FLKRM-373: extend a running job's lease without touching its progress.
 * Matches nothing once the job has been released or reclaimed elsewhere.
 */
export function extendLeaseStatement({ jobId, workerId, at, leaseExpiresAt: leaseUntil }) {
  return {
    sql: `UPDATE processing_jobs SET heartbeat_at = ?, lease_expires_at = ?
          WHERE id = ? AND status = 'running' AND worker_id = ?`,
    args: [at, leaseUntil, jobId, workerId],
  };
}

/**
 * FLKRM-373: hand a still-running job back to the queue when this worker stops.
 *
 * The job is immediately claimable (no backoff), and is marked `is_reclaim` so
 * the next claim does not count another attempt: a deploy is not a failure.
 * Nor does it count toward lease_reclaim_count, which detects stuck jobs.
 */
export function releaseOnShutdownStatement({ jobId, workerId, at }) {
  return {
    sql: `UPDATE processing_jobs
          SET status = 'queued', worker_id = NULL, heartbeat_at = NULL, lease_expires_at = NULL,
            next_attempt_at = NULL, error = NULL,
            progress_json = json_set(COALESCE(progress_json, '{}'), '$.phase', 'released_on_shutdown', '$.is_reclaim', 1, '$.updatedAt', ?)
          WHERE id = ? AND status = 'running' AND worker_id = ?`,
    args: [at, jobId, workerId],
  };
}

/**
 * FLKRM-373: extend a job's lease on a timer for as long as it runs, so a long
 * LLM call cannot outlive the lease between stage heartbeats. Beats never
 * overlap; a slow beat skips the next tick instead of queueing behind it.
 * Returns a function that stops the heartbeat.
 */
export function startLeaseHeartbeat(beat, { intervalMs, onError = () => {} }) {
  let inFlight = false;
  let stopped = false;
  const handle = setInterval(async () => {
    if (inFlight || stopped) return;
    inFlight = true;
    try { await beat(); } catch (error) { onError(error); } finally { inFlight = false; }
  }, intervalMs);
  handle.unref?.();
  return () => { stopped = true; clearInterval(handle); };
}

/**
 * FLKRM-373: graceful stop. The first signal stops claiming and gives the
 * in-flight job `graceMs` to finish; if it is still running then (or a second
 * signal arrives) the job is released back to the queue and the process exits.
 * graceMs must stay below systemd's TimeoutStopSec so release runs before SIGKILL.
 */
export function createShutdown({ graceMs, activeJob, releaseJob, exit, log = () => {} }) {
  let requested = false;
  let finalizing = null;
  function finalize(reason) {
    finalizing ||= (async () => {
      const job = activeJob();
      if (job) {
        try {
          await releaseJob(job);
          log({ event: 'job_released_on_shutdown', jobId: job.id, reason });
        } catch (error) {
          log({ event: 'job_release_failed', jobId: job.id, reason, error: String(error?.message || error) });
        }
      }
      exit();
    })();
    return finalizing;
  }
  return {
    get requested() { return requested; },
    request(signal) {
      if (requested) return finalize('repeat_signal');
      requested = true;
      log({ event: 'worker_stopping', signal, graceMs, activeJobId: activeJob()?.id || null });
      if (!activeJob()) return undefined;
      setTimeout(() => finalize('grace_expired'), graceMs).unref?.();
      return undefined;
    },
  };
}
