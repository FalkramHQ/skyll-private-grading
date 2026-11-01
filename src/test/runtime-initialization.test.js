import { describe, expect, it, vi } from 'vitest';
import { createRetryableInitializer } from '../../api/_lib/runtimeInitialization.js';

describe('createRetryableInitializer', () => {
  it('shares an in-flight initialization attempt and keeps the successful result', async () => {
    let resolve;
    const initialize = vi.fn(() => new Promise((done) => { resolve = done; }));
    const ensureInitialized = createRetryableInitializer(initialize);

    const first = ensureInitialized();
    const second = ensureInitialized();

    expect(initialize).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    resolve();
    await first;

    await ensureInitialized();
    expect(initialize).toHaveBeenCalledTimes(1);
  });

  it('allows a later request to retry after initialization fails', async () => {
    const initialize = vi.fn()
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce(undefined);
    const ensureInitialized = createRetryableInitializer(initialize);

    await expect(ensureInitialized()).rejects.toThrow('database unavailable');
    await expect(ensureInitialized()).resolves.toBeUndefined();

    expect(initialize).toHaveBeenCalledTimes(2);
  });
});
