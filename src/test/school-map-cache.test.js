// resolveSchoolId shares one in-flight `SELECT ... FROM schools` between
// concurrent callers, never caches a failed load, and lets concurrent misses
// share a single reload.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSchoolCache, resolveSchoolId } from '../../api/_lib/canonicalSubmissions.js';
import { inActorSchool } from '../../api/_lib/schoolScope.js';

const SCHOOLS = [{ id: 'school_a', slug: 'alpha', display_name: 'Alpha School' }];

function fakeDb(results = []) {
  const queue = [...results];
  return {
    execute: vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      const next = queue.length ? queue.shift() : SCHOOLS;
      if (next instanceof Error) throw next;
      return { rows: next };
    }),
  };
}

let clock;
beforeEach(() => {
  resetSchoolCache();
  clock = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
});
afterEach(() => vi.restoreAllMocks());

describe('school map cache', () => {
  it('loads once for a burst of concurrent visibility checks on a cold cache', async () => {
    const db = fakeDb();
    const actor = { school_id: 'school_a' };
    const results = await Promise.all(Array.from({ length: 500 }, () => inActorSchool(db, actor, { schoolName: 'Alpha School' })));
    expect(results.every(Boolean)).toBe(true);
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed load', async () => {
    const db = fakeDb([new Error('connection reset')]);
    const first = await Promise.allSettled([resolveSchoolId(db, 'Alpha School'), resolveSchoolId(db, 'alpha')]);
    expect(first.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(await resolveSchoolId(db, 'Alpha School')).toBe('school_a');
    expect(db.execute).toHaveBeenCalledTimes(2);
  });

  it('reloads a stale map once for concurrent misses', async () => {
    const db = fakeDb([SCHOOLS, [...SCHOOLS, { id: 'school_b', slug: 'beta', display_name: 'Beta School' }]]);
    expect(await resolveSchoolId(db, 'Alpha School')).toBe('school_a');
    clock += 31_000;
    const results = await Promise.all(Array.from({ length: 50 }, () => resolveSchoolId(db, 'Beta School')));
    expect(results.every((id) => id === 'school_b')).toBe(true);
    expect(db.execute).toHaveBeenCalledTimes(2);
  });
});
