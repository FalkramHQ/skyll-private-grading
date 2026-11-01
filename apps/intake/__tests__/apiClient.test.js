import { createApiClient } from '../src/apiClient';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function response(body, ok = true, status = ok ? 200 : 500) {
  return { ok, status, json: jest.fn().mockResolvedValue(body) };
}

describe('createApiClient', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    delete global.fetch;
  });

  it('shares one in-flight request between equivalent GET callers', async () => {
    const pending = deferred();
    fetch.mockReturnValueOnce(pending.promise);
    const api = createApiClient('https://api.example.test');

    const first = api('/reports?year=2026', {}, 'token-a');
    const second = api('/reports?year=2026', {}, 'token-a');

    expect(first).toBe(second);
    expect(fetch).toHaveBeenCalledTimes(1);

    pending.resolve(response({ reports: ['ready'] }));
    await expect(first).resolves.toEqual({ reports: ['ready'] });
    await expect(second).resolves.toEqual({ reports: ['ready'] });
  });

  it('starts a new GET after the previous request settles', async () => {
    fetch
      .mockResolvedValueOnce(response({ version: 1 }))
      .mockResolvedValueOnce(response({ version: 2 }));
    const api = createApiClient('https://api.example.test');

    await expect(api('/tests', {}, 'token-a')).resolves.toEqual({ version: 1 });
    await expect(api('/tests', {}, 'token-a')).resolves.toEqual({ version: 2 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('clears a failed GET so a later request can retry', async () => {
    fetch
      .mockResolvedValueOnce(response({ error: 'Temporary failure', retryable: true }, false))
      .mockResolvedValueOnce(response({ tests: [] }));
    const api = createApiClient('https://api.example.test');

    await expect(api('/tests', {}, 'token-a')).rejects.toMatchObject({
      message: 'Temporary failure',
      details: { error: 'Temporary failure', retryable: true },
    });
    await expect(api('/tests', {}, 'token-a')).resolves.toEqual({ tests: [] });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps different users and refresh modes independent', async () => {
    const pending = deferred();
    fetch.mockReturnValue(pending.promise);
    const api = createApiClient('https://api.example.test');

    const ordinary = api('/tests', {}, 'token-a');
    const forced = api('/tests', { forceRefresh: true }, 'token-a');
    const otherUser = api('/tests', {}, 'token-b');

    expect(fetch).toHaveBeenCalledTimes(3);
    pending.resolve(response({ tests: [] }));
    await Promise.all([ordinary, forced, otherUser]);
  });

  it('never deduplicates mutations or abortable reads', async () => {
    fetch.mockResolvedValue(response({ ok: true }));
    const api = createApiClient('https://api.example.test');
    const controller = new AbortController();

    await Promise.all([
      api('/tests', { method: 'POST', body: '{}' }, 'token-a'),
      api('/tests', { method: 'POST', body: '{}' }, 'token-a'),
      api('/tests', { signal: controller.signal }, 'token-a'),
      api('/tests', { signal: controller.signal }, 'token-a'),
    ]);

    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('does not treat HTTP 304 empty bodies as successful JSON payloads', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 304,
      json: jest.fn().mockRejectedValue(new Error('Unexpected end of JSON input')),
    });
    const api = createApiClient('https://api.example.test');

    await expect(api('/tests', {}, 'token-a')).rejects.toMatchObject({
      message: 'Not modified',
      status: 304,
      notModified: true,
    });
  });

  it('times out a hung request, aborts it, and releases the caller', async () => {
    jest.useFakeTimers();
    try {
      let seenSignal;
      fetch.mockImplementation((url, init) => {
        seenSignal = init.signal;
        return new Promise(() => {});
      });
      const api = createApiClient('https://api.example.test');
      const pending = api('/api/intake/uploads', { method: 'POST', body: '{}', timeoutMs: 1000 }, 'token-a');
      const assertion = expect(pending).rejects.toMatchObject({ status: 408, code: 'timeout', timedOut: true });
      await jest.advanceTimersByTimeAsync(1001);
      await assertion;
      expect(seenSignal.aborted).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('applies a default timeout to every request', async () => {
    jest.useFakeTimers();
    try {
      fetch.mockImplementation(() => new Promise(() => {}));
      const api = createApiClient('https://api.example.test', { timeoutMs: 500 });
      const pending = api('/tests', {}, 'token-a');
      const assertion = expect(pending).rejects.toMatchObject({ status: 408 });
      await jest.advanceTimersByTimeAsync(501);
      await assertion;
    } finally {
      jest.useRealTimers();
    }
  });

  it('a timed-out GET does not poison the in-flight cache', async () => {
    jest.useFakeTimers();
    try {
      fetch.mockImplementationOnce(() => new Promise(() => {})).mockResolvedValueOnce(response({ tests: [1] }));
      const api = createApiClient('https://api.example.test', { timeoutMs: 500 });
      const first = api('/tests', {}, 'token-a');
      const assertion = expect(first).rejects.toMatchObject({ status: 408 });
      await jest.advanceTimersByTimeAsync(501);
      await assertion;
      await expect(api('/tests', {}, 'token-a')).resolves.toEqual({ tests: [1] });
    } finally {
      jest.useRealTimers();
    }
  });
});

