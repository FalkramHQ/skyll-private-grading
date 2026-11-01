// Centralized API client with retry (safe requests only), dedup, and error normalization.
// All src/lib/db.js helpers delegate here instead of calling fetch() directly.

const MAX_RETRIES = 2; // 3 total attempts (initial + 2 retries)
const BASE_DELAY_MS = 300;

// In-flight GET dedup: key = method+path, value = Promise
const _inFlight = new Map();

function retryDelay(attempt) {
  return BASE_DELAY_MS * Math.pow(2, attempt);
}

// 429 is never retried: the server asked us to back off, and an immediate
// retry spends the same quota again.
function isRetriable(status) {
  return status >= 502 && status <= 504;
}

// A POST that timed out at the gateway may still have run (AI grading, student
// quota). Only replay requests that are safe to repeat: GET/HEAD, or writes
// that carry an Idempotency-Key the server dedups on.
function isReplayable(options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return true;
  const headers = options.headers || {};
  return Object.keys(headers).some((name) => name.toLowerCase() === 'idempotency-key' && headers[name]);
}

async function doFetch(path, options, attempt = 0) {
  const retriesLeft = isReplayable(options) && attempt < MAX_RETRIES;
  let response;
  try {
    response = await fetch(path, options);
  } catch {
    // Network error — retry if attempts remain
    if (retriesLeft) {
      await new Promise((r) => setTimeout(r, retryDelay(attempt)));
      return doFetch(path, options, attempt + 1);
    }
    throw new Error('Network error — please check your connection');
  }

  if (!response.ok) {
    // Retry on 502-504 if attempts remain
    if (isRetriable(response.status) && retriesLeft) {
      await new Promise((r) => setTimeout(r, retryDelay(attempt)));
      return doFetch(path, options, attempt + 1);
    }
    // Parse error payload
    const payload = await response.json().catch(() => ({}));
    const err = new Error(payload.error || `Request failed (${response.status})`);
    err.status = response.status;
    throw err;
  }

  return response.json().catch(() => ({}));
}

/**
 * GET with retry, dedup, and error normalization.
 * @param {string} path
 * @param {string} [fallbackMessage]
 * @returns {Promise<any>}
 */
export function apiGet(path, fallbackMessage = 'Could not load data') {
  const dedupKey = `GET:${path}`;
  // If an identical GET is already in flight, reuse it
  if (_inFlight.has(dedupKey)) return _inFlight.get(dedupKey);

  const promise = doFetch(path, { credentials: 'same-origin' })
    .catch((err) => {
      err.message = err.message || fallbackMessage;
      throw err;
    })
    .finally(() => _inFlight.delete(dedupKey));

  _inFlight.set(dedupKey, promise);
  return promise;
}

/**
 * POST/PUT/DELETE with error normalization. Retried only when `idempotencyKey`
 * is given (sent as Idempotency-Key); otherwise a failure is final.
 * @param {string} path
 * @param {string} method
 * @param {object} [body]
 * @param {string} [fallbackMessage]
 * @param {{ idempotencyKey?: string }} [opts]
 * @returns {Promise<any>}
 */
export function apiSend(path, method, body, fallbackMessage = 'Request failed', { idempotencyKey } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  return doFetch(path, {
    method,
    credentials: 'same-origin',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  }).catch((err) => {
    err.message = err.message || fallbackMessage;
    throw err;
  });
}

/** Convenience wrappers */
export const apiPost = (path, body, fallback) => apiSend(path, 'POST', body, fallback);
export const apiPut = (path, body, fallback) => apiSend(path, 'PUT', body, fallback);
export const apiDelete = (path, fallback) => apiSend(path, 'DELETE', null, fallback);
