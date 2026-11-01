// apiClient replays only requests that are safe to repeat. A POST that timed
// out at the gateway may already have run (AI grading, student quota), and a
// 429 asks the client to back off, not to try again at once.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiGet, apiPost, apiSend } from '../lib/apiClient';

function reply(status, body = {}) {
  return { ok: status < 400, status, json: async () => body };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function settle(promise) {
  const outcome = promise.then((value) => ({ value }), (error) => ({ error }));
  await vi.runAllTimersAsync();
  return outcome;
}

describe('apiClient retries', () => {
  it('retries a GET on 503 and returns the recovered response', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(reply(503))
      .mockResolvedValueOnce(reply(200, { ok: 1 }));
    const { value } = await settle(apiGet('/api/thing'));
    expect(value).toEqual({ ok: 1 });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('never retries a POST on 502-504', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(reply(504, { error: 'Gateway timeout' }));
    const { error } = await settle(apiPost('/api/grade', { id: 1 }));
    expect(error.status).toBe(504);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('never retries a POST after a network error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const { error } = await settle(apiPost('/api/grade', { id: 1 }));
    expect(error.message).toMatch(/Network error/);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('never retries a 429, even for a GET', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(reply(429, { error: 'Slow down' }));
    const { error } = await settle(apiGet('/api/limited'));
    expect(error.status).toBe(429);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('retries a write that carries an Idempotency-Key', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(reply(502))
      .mockResolvedValueOnce(reply(200, { saved: true }));
    const { value } = await settle(apiSend('/api/save', 'POST', { a: 1 }, 'Failed', { idempotencyKey: 'k1' }));
    expect(value).toEqual({ saved: true });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(globalThis.fetch.mock.calls[1][1].headers['Idempotency-Key']).toBe('k1');
  });
});
