const inFlightReads = new Map();

/**
 * React Native's fetch has no timeout of its own (OkHttp is configured with
 * 0 = wait forever), so a request on a dead connection could hold an upload
 * slot for good. Every call is aborted after this long unless the caller
 * passes its own `timeoutMs`.
 */
export const DEFAULT_API_TIMEOUT_MS = 30_000;

export function timeoutError(timeoutMs) {
  const error = new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`);
  error.status = 408;
  error.code = 'timeout';
  error.timedOut = true;
  return error;
}

function normalizedHeadersKey(headers) {
  return Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), String(value)])
    .sort(([left], [right]) => left.localeCompare(right));
}

function inFlightKey({ url, method, token, headers, forceRefresh }) {
  return JSON.stringify([
    method,
    url,
    token || '',
    normalizedHeadersKey(headers),
    forceRefresh,
  ]);
}

export function createApiClient(apiOrigin, { timeoutMs: defaultTimeoutMs = DEFAULT_API_TIMEOUT_MS } = {}) {
  return function api(path, options = {}, token = null) {
    const { forceRefresh = false, headers: optionHeaders = {}, timeoutMs = defaultTimeoutMs, ...requestOptions } = options;
    const method = String(requestOptions.method || 'GET').toUpperCase();
    const url = `${apiOrigin}${path}`;
    const headers = {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...optionHeaders,
      ...(forceRefresh ? { 'Cache-Control': 'no-cache' } : {}),
    };

    const execute = async () => {
      const callerSignal = requestOptions.signal || null;
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      let timedOut = false;
      let timer = null;
      const onCallerAbort = () => controller?.abort();
      if (controller && callerSignal) {
        if (callerSignal.aborted) controller.abort();
        else callerSignal.addEventListener?.('abort', onCallerAbort);
      }
      const timeout = new Promise((_, reject) => {
        if (!(Number(timeoutMs) > 0)) return;
        timer = setTimeout(() => {
          timedOut = true;
          controller?.abort();
          reject(timeoutError(timeoutMs));
        }, timeoutMs);
      });
      try {
        // The race guarantees the caller is released even if abort is ignored.
        return await Promise.race([readResponse(controller?.signal || callerSignal), timeout]);
      } catch (error) {
        if (timedOut) throw timeoutError(timeoutMs);
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
        callerSignal?.removeEventListener?.('abort', onCallerAbort);
      }
    };

    const readResponse = async (signal) => {
      const response = await fetch(url, {
        headers,
        ...requestOptions,
        ...(signal ? { signal } : {}),
        method,
      });
      // 304 bodies are empty. Treating that as `{}` would wipe SWR state when
      // callers do `setX(result.x || [])`. Surface not-modified so loaders keep
      // the already-painted cache.
      if (response.status === 304) {
        const error = new Error('Not modified');
        error.status = 304;
        error.notModified = true;
        throw error;
      }
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(body.error || 'Request failed');
        error.status = response.status;
        error.code = body.code || null;
        error.details = body;
        throw error;
      }
      return body;
    };

    // Sharing an abortable request would let one caller cancel work belonging
    // to another. Bodies are also excluded even for unusual GET/HEAD requests.
    const canDeduplicate = ['GET', 'HEAD'].includes(method)
      && requestOptions.body == null
      && requestOptions.signal == null;
    if (!canDeduplicate) return execute();

    const key = inFlightKey({ url, method, token, headers, forceRefresh });
    const existing = inFlightReads.get(key);
    if (existing) return existing;

    const request = execute().finally(() => {
      if (inFlightReads.get(key) === request) inFlightReads.delete(key);
    });
    inFlightReads.set(key, request);
    return request;
  };
}
