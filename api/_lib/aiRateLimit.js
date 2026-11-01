/**
 * Per-user sliding-window rate limiter for AI / NLQ style endpoints.
 * In-memory only — fine for Hobby single-region; not shared across isolates.
 */

const buckets = new Map();

/**
 * @param {string} key
 * @param {{ max?: number, windowMs?: number }} [opts]
 * @returns {boolean} true when the caller should be rejected (429)
 */
export function isRateLimited(key, { max = 10, windowMs = 60_000 } = {}) {
  const id = String(key || '').trim() || 'anonymous';
  const now = Date.now();
  let bucket = buckets.get(id);
  if (!bucket) {
    bucket = [];
    buckets.set(id, bucket);
  }
  while (bucket.length && bucket[0] < now - windowMs) bucket.shift();
  if (bucket.length >= max) return true;
  bucket.push(now);
  return false;
}

/** Test helper — clears all buckets. */
export function resetRateLimitBuckets() {
  buckets.clear();
}
