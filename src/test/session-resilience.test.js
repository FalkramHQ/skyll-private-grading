// A database blip during the session check must not look like "signed out".
import { describe, expect, it, vi } from 'vitest';

const holder = vi.hoisted(() => ({ execute: null }));
vi.mock('../../api/_lib/env.js', () => ({ tursoUrl: 'libsql://test', tursoAuthToken: '' }));
vi.mock('@libsql/client/web', () => ({
  createClient: () => ({ execute: (...args) => holder.execute(...args), batch: vi.fn() }),
}));

const { requireUser } = await import('../../api/_lib/auth.js');

function response() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

describe('requireUser', () => {
  it('answers 503, not 401, when the session cannot be checked', async () => {
    holder.execute = vi.fn().mockRejectedValue(new Error('connect ETIMEDOUT'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = response();
    const user = await requireUser({ headers: { authorization: 'Bearer token' } }, res);
    expect(user).toBeNull();
    expect(res.statusCode).toBe(503);
    expect(res.body.error).not.toMatch(/ETIMEDOUT/);
  });

  it('answers 401 when there is no session token', async () => {
    holder.execute = vi.fn();
    const res = response();
    expect(await requireUser({ headers: {} }, res)).toBeNull();
    expect(res.statusCode).toBe(401);
    expect(holder.execute).not.toHaveBeenCalled();
  });
});
