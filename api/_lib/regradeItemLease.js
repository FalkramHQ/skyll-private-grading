/**
 * Lease for cohort regrade items.
 *
 * `processCohortRegradeStep` claims one regrade_items row at a time with
 * UPDATE ... RETURNING, moving it to state 'processing'. If the process died
 * mid-item (OCI restart, Vercel timeout, model hang) the row stayed
 * 'processing' forever: finishRunIfReady never completed the run, and
 * createCohortRegrade answered 409 for that test from then on.
 *
 * `started_at` is already written at claim time and serves as the lease
 * anchor; `attempt_count` (migration 071) counts claims. Before every claim
 * the caller expires stale leases: an item processing longer than the lease
 * goes back to 'queued' while it still has attempts left, and to 'failed'
 * (error 'lease expired') once it has been claimed `maxAttempts` times.
 * A failed item makes the run 'partial', which the retry control can resume
 * and which no longer blocks new runs.
 *
 * Pure statement builders; no db access here.
 */

export const DEFAULT_COHORT_REGRADE_ITEM_LEASE_MS = 10 * 60_000;
export const DEFAULT_COHORT_REGRADE_ITEM_MAX_ATTEMPTS = 3;
export const REGRADE_ITEM_LEASE_EXPIRED_ERROR = 'lease expired';

export function regradeItemLeaseMs(env = process.env) {
  const value = Number(env.COHORT_REGRADE_ITEM_LEASE_MS);
  return Number.isFinite(value) && value >= 60_000 ? value : DEFAULT_COHORT_REGRADE_ITEM_LEASE_MS;
}

export function regradeItemMaxAttempts(env = process.env) {
  const value = Number(env.COHORT_REGRADE_ITEM_MAX_ATTEMPTS);
  return Number.isInteger(value) && value >= 1 ? value : DEFAULT_COHORT_REGRADE_ITEM_MAX_ATTEMPTS;
}

/**
 * Decide what happens to an item whose lease has lapsed. `attemptCount` is
 * the number of times it has been claimed so far.
 */
export function regradeItemLeaseDecision({ attemptCount = 0, maxAttempts = DEFAULT_COHORT_REGRADE_ITEM_MAX_ATTEMPTS } = {}) {
  const attempts = Math.max(0, Number(attemptCount) || 0);
  return attempts >= Math.max(1, Number(maxAttempts) || 1) ? 'fail' : 'requeue';
}

export function regradeItemLeaseCutoff({ now = new Date(), leaseMs = DEFAULT_COHORT_REGRADE_ITEM_LEASE_MS } = {}) {
  const at = now instanceof Date ? now.getTime() : new Date(now).getTime();
  return new Date(at - leaseMs).toISOString();
}

/**
 * Statements that release stale 'processing' items for one run. Run them as
 * one write batch before claiming. Items with attempts left return to the
 * queue (attempt_count is preserved: it counts claims); exhausted items fail
 * with a recognisable error so the run finishes 'partial' rather than hang.
 */
export function expireStaleRegradeItemsStatements({ runId, now = new Date(), leaseMs = DEFAULT_COHORT_REGRADE_ITEM_LEASE_MS, maxAttempts = DEFAULT_COHORT_REGRADE_ITEM_MAX_ATTEMPTS } = {}) {
  if (!runId) throw new Error('expireStaleRegradeItemsStatements requires runId');
  const cutoff = regradeItemLeaseCutoff({ now, leaseMs });
  const at = (now instanceof Date ? now : new Date(now)).toISOString();
  return [
    {
      sql: `UPDATE regrade_items
            SET state = 'failed', error = ?, completed_at = ?
            WHERE run_id = ? AND state = 'processing'
              AND (started_at IS NULL OR started_at < ?)
              AND COALESCE(attempt_count, 0) >= ?`,
      args: [`${REGRADE_ITEM_LEASE_EXPIRED_ERROR} after ${maxAttempts} attempt(s)`, at, runId, cutoff, maxAttempts],
    },
    {
      sql: `UPDATE regrade_items
            SET state = 'queued', started_at = NULL, error = ?
            WHERE run_id = ? AND state = 'processing'
              AND (started_at IS NULL OR started_at < ?)
              AND COALESCE(attempt_count, 0) < ?`,
      args: [`${REGRADE_ITEM_LEASE_EXPIRED_ERROR}; requeued`, runId, cutoff, maxAttempts],
    },
  ];
}

/** Claim the oldest queued item of a run, counting the attempt. */
export function claimRegradeItemStatement({ runId, now = new Date() } = {}) {
  if (!runId) throw new Error('claimRegradeItemStatement requires runId');
  const at = (now instanceof Date ? now : new Date(now)).toISOString();
  return {
    sql: `UPDATE regrade_items
          SET state = 'processing', started_at = ?, error = NULL,
              attempt_count = COALESCE(attempt_count, 0) + 1
          WHERE id = (SELECT id FROM regrade_items WHERE run_id = ? AND state = 'queued' ORDER BY rowid LIMIT 1)
            AND state = 'queued'
          RETURNING *`,
    args: [at, runId],
  };
}
