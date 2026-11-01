/**
 * Periodic cleanup of operational tables that otherwise grow forever.
 *
 * - worker_heartbeats: one row per worker process start; stopped workers
 *   older than the retention window are deleted (452 rows had accumulated).
 * - sessions: expired sessions are kept briefly for audit, then deleted.
 *
 * Grading data (processing_jobs, submissions, reports) is never touched here.
 */

export const DEFAULT_HOUSEKEEPING_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_HEARTBEAT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function iso(ms) {
  return new Date(ms).toISOString();
}

export async function runHousekeeping(db, {
  now = Date.now(),
  heartbeatRetentionMs = Number(process.env.HOUSEKEEPING_HEARTBEAT_RETENTION_MS || DEFAULT_HEARTBEAT_RETENTION_MS),
  sessionRetentionMs = Number(process.env.HOUSEKEEPING_SESSION_RETENTION_MS || DEFAULT_SESSION_RETENTION_MS),
} = {}) {
  const heartbeats = await db.execute({
    sql: `DELETE FROM worker_heartbeats
          WHERE status != 'healthy' AND last_seen_at < ?`,
    args: [iso(now - heartbeatRetentionMs)],
  });
  // A "healthy" row whose worker has been silent for the whole retention window
  // belongs to a process that died without a shutdown hook.
  const stale = await db.execute({
    sql: `DELETE FROM worker_heartbeats
          WHERE status = 'healthy' AND last_seen_at < ?`,
    args: [iso(now - heartbeatRetentionMs)],
  });
  const sessions = await db.execute({
    sql: `DELETE FROM sessions
          WHERE expires_at IS NOT NULL AND expires_at < ?`,
    args: [iso(now - sessionRetentionMs)],
  });
  return {
    heartbeatsDeleted: Number(heartbeats.rowsAffected || 0) + Number(stale.rowsAffected || 0),
    sessionsDeleted: Number(sessions.rowsAffected || 0),
  };
}

/** Returns a function that runs housekeeping at most once per interval. */
export function createHousekeeper(db, {
  intervalMs = Math.max(60_000, Number(process.env.HOUSEKEEPING_INTERVAL_MS || DEFAULT_HOUSEKEEPING_INTERVAL_MS)),
  now = Date.now,
  log = (entry) => console.log(JSON.stringify(entry)),
  onError = (error) => console.warn(JSON.stringify({ event: 'housekeeping_failed', error: String(error?.message || error) })),
} = {}) {
  let lastRunAt = null;
  return async function maybeRunHousekeeping() {
    const at = now();
    if (lastRunAt != null && at - lastRunAt < intervalMs) return null;
    lastRunAt = at;
    try {
      const result = await runHousekeeping(db, { now: at });
      log({ event: 'housekeeping_done', ...result });
      return result;
    } catch (error) {
      onError(error);
      return null;
    }
  };
}
