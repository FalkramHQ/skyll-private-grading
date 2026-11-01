// useSession treats only 401 (or 200 with no user) as signed out. A 5xx/503
// from the session lookup keeps the cached session and revalidates later.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

let auth;

function reply(status, body = {}) {
  return { ok: status < 400, status, json: async () => body };
}

beforeEach(async () => {
  vi.resetModules();
  auth = await import('../lib/auth');
  localStorage.clear();
  localStorage.setItem('username', 'desk1');
  localStorage.setItem('userRole', 'staff');
  localStorage.setItem('userSchool', 'Demo School');
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function resolvedSession() {
  const hook = renderHook(() => auth.useSession());
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  return hook;
}

describe('useSession resilience', () => {
  it('keeps the cached session when the lookup returns 503', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(reply(503, { error: 'unavailable' }));
    const { result } = await resolvedSession();
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.user.username).toBe('desk1');
    expect(localStorage.getItem('username')).toBe('desk1');
  });

  it('keeps the cached session when the lookup returns 500', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(reply(500));
    const { result } = await resolvedSession();
    expect(result.current.isAuthenticated).toBe(true);
  });

  it('signs out on 401', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(reply(401, { user: null }));
    const { result } = await resolvedSession();
    expect(result.current.isAuthenticated).toBe(false);
    expect(localStorage.getItem('username')).toBeNull();
  });

  it('signs out on 200 with no user', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(reply(200, { user: null }));
    const { result } = await resolvedSession();
    expect(result.current.isAuthenticated).toBe(false);
    expect(localStorage.getItem('username')).toBeNull();
  });

  it('revalidates on the next mount after a transient failure', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(reply(503))
      .mockResolvedValueOnce(reply(401));
    await resolvedSession();
    const second = renderHook(() => auth.useSession());
    // The cached user is shown at once (no loader flash) ...
    expect(second.result.current.loading).toBe(false);
    // ... and replaced by the server's answer when it arrives.
    await waitFor(() => expect(second.result.current.isAuthenticated).toBe(false));
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});
