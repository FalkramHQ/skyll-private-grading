// Turso-backed fixed-window rate limiter for AI / NLQ endpoints.
// Falls back to in-memory buckets when the database is unavailable.
// Table: rate_limit_buckets (bucket_key TEXT, window_start INTEGER, count INTEGER)

import { client as db } from './tursoClient.js';
import { isRateLimited } from './aiRateLimit.js';

let _tableReady = false;

async function ensureTable() {
  if (_tableReady || !db) return _tableReady;
  try {
    await db.execute(
      `CREATE TABLE IF NOT EXISTS rate_limit_buckets (
        bucket_key TEXT NOT NULL,
        window_start INTEGER NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (bucket_key, window_start)
      )`,
    );
    _tableReady = true;
  } catch {
    // Non-fatal — fall back to in-memory
    _tableReady = false;
  }
  return _tableReady;
}

/**
 * Async rate-limit check backed by Turso. Falls back to the in-memory
 * sliding-window limiter if the database is not available.
 *
 * @param {string} key — bucket key (e.g. username or "action:user")
 * @param {{ max?: number, windowMs?: number }} [opts]
 * @returns {Promise<boolean>} true when the caller should be rejected (429)
 */
export async function checkRateLimit(key, { max = 10, windowMs = 60_000 } = {}) {
  const id = String(key || '').trim() || 'anonymous';

  // Try Turso-backed fixed-window limiter
  if (await ensureTable()) {
    const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
    try {
      // Atomic increment via UPSERT
      await db.execute({
        sql: `INSERT INTO rate_limit_buckets (bucket_key, window_start, count)
             VALUES (?, ?, 1)
             ON CONFLICT (bucket_key, window_start)
             DO UPDATE SET count = count + 1`,
        args: [id, windowStart],
      });
      const result = await db.execute({
        sql: `SELECT count FROM rate_limit_buckets WHERE bucket_key = ? AND window_start = ?`,
        args: [id, windowStart],
      });
      const count = result.rows[0]?.count ?? 0;

      // Opportunistic cleanup: remove expired windows for this key
      if (Math.random() < 0.05) {
        db.execute({
          sql: `DELETE FROM rate_limit_buckets WHERE bucket_key = ? AND window_start < ?`,
          args: [id, windowStart],
        }).catch(() => {});
      }

      return count > max;
    } catch {
      // DB error — fall through to in-memory
    }
  }

  // In-memory fallback (sliding window)
  return isRateLimited(id, { max, windowMs });
}
