// Sign-in throttling holds however guesses are spread: one login from one
// address, one login from many addresses, or many logins from one address.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSchemaDatabase } from './helpers/schemaDatabase.js';

const holder = vi.hoisted(() => ({ db: null }));
vi.mock('../../api/_lib/env.js', () => ({ tursoUrl: 'libsql://test', tursoAuthToken: '' }));
vi.mock('@libsql/client/web', () => ({
  createClient: () => ({
    execute: (...args) => holder.db.execute(...args),
    batch: (...args) => holder.db.batch(...args),
  }),
}));

const { clearLoginFailures, reserveLoginAttempt, verifyPasswordOrDummy } = await import('../../api/_lib/auth.js');

const NOW = new Date('2026-01-01T10:00:00.000Z');
const from = (address) => ({ headers: { 'x-forwarded-for': address } });

async function attempts(count, req, login) {
  let last;
  for (let index = 0; index < count; index += 1) last = await reserveLoginAttempt(req, login, NOW);
  return last;
}

beforeEach(async () => {
  holder.db = await createSchemaDatabase();
});

describe('login rate limits', () => {
  it('blocks one login from one address after 10 attempts', async () => {
    expect((await attempts(10, from('1.1.1.1'), 'asha')).allowed).toBe(true);
    const blocked = await attempts(2, from('1.1.1.1'), 'asha');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThan(0);
  });

  it('blocks one login guessed from many addresses', async () => {
    for (let index = 0; index < 30; index += 1) await reserveLoginAttempt(from(`10.0.0.${index}`), 'asha', NOW);
    expect((await attempts(2, from('10.0.1.1'), 'asha')).allowed).toBe(false);
    // Another account is unaffected.
    expect((await reserveLoginAttempt(from('10.0.1.1'), 'ravi', NOW)).allowed).toBe(true);
  });

  it('blocks one address guessing many logins', async () => {
    for (let index = 0; index < 100; index += 1) await reserveLoginAttempt(from('2.2.2.2'), `user${index}`, NOW);
    expect((await attempts(2, from('2.2.2.2'), 'fresh')).allowed).toBe(false);
    expect((await reserveLoginAttempt(from('3.3.3.3'), 'fresh', NOW)).allowed).toBe(true);
  });

  it('a successful sign-in clears the login counters but not the address counter', async () => {
    const last = await attempts(9, from('4.4.4.4'), 'asha');
    await clearLoginFailures(last);
    expect((await attempts(9, from('4.4.4.4'), 'asha')).allowed).toBe(true);
    const rows = (await holder.db.execute('SELECT failure_count FROM credential_rate_limits ORDER BY failure_count DESC')).rows;
    expect(rows[0].failure_count).toBe(18);
  });

  it('fails an unknown login after running a dummy hash check', () => {
    expect(verifyPasswordOrDummy('anything', null)).toBe(false);
    expect(verifyPasswordOrDummy('anything', undefined)).toBe(false);
  });
});
