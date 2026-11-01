import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertIsolatedDatabaseUrl,
  blockExternalNetwork,
  createDeterministicClock,
  createDeterministicIds,
  createRecheckTestDatabase,
} from './helpers/recheckTestDatabase.js';

const openRequest = (id, questionId = 'question_1') => ({
  sql: `INSERT INTO recheck_requests (
    id, submission_question_id, submission_id, student_id, reason,
    requested_by, requested_by_role, status, requested_at
  ) VALUES (?, ?, 'submission_1', 'student_1', 'Please check this answer again.', 'student_login', 'student', 'open', '2026-01-01T00:00:00.000Z')`,
  args: [id, questionId],
});

const databases = [];

afterEach(async () => {
  while (databases.length) await databases.pop().close();
});

describe('isolated recheck test infrastructure', () => {
  it('rejects every remote or non-disposable database target', () => {
    for (const url of [
      'libsql://production.turso.io',
      'https://production.turso.io',
      'wss://production.turso.io',
      'file:C:/persistent/rechecks.db',
      '',
    ]) {
      expect(() => assertIsolatedDatabaseUrl(url)).toThrow();
    }

    const local = path.join(os.tmpdir(), 'skyll-recheck-contract', 'test.db');
    expect(assertIsolatedDatabaseUrl(`file:${local.replaceAll('\\', '/')}`)).toBe(path.resolve(local));
  });

  it('creates a disposable database visible to two independent clients', async () => {
    const harness = await createRecheckTestDatabase();
    databases.push(harness);

    await harness.db.execute(openRequest('recheck_1'));
    const observed = await harness.concurrentDb.execute('SELECT id, status FROM recheck_requests');

    expect(observed.rows).toEqual([{ id: 'recheck_1', status: 'open' }]);
    expect(path.dirname(harness.filePath)).toBe(harness.directory);
    expect(harness.directory.startsWith(os.tmpdir())).toBe(true);
  });

  it('resets all workflow state between tests without rebuilding the schema', async () => {
    const harness = await createRecheckTestDatabase();
    databases.push(harness);

    await harness.db.batch([
      openRequest('recheck_1'),
      {
        sql: `INSERT INTO recheck_events (
          id, recheck_request_id, actor_user_id, event_type, created_at
        ) VALUES ('event_1', 'recheck_1', 'student_login', 'requested_by_student', '2026-01-01T00:00:00.000Z')`,
      },
    ], 'write');

    await harness.reset();

    expect((await harness.db.execute('SELECT COUNT(*) AS count FROM recheck_requests')).rows[0].count).toBe(0);
    expect((await harness.db.execute('SELECT COUNT(*) AS count FROM recheck_events')).rows[0].count).toBe(0);
    await harness.db.execute(openRequest('recheck_2'));
    expect((await harness.db.execute('SELECT id FROM recheck_requests')).rows[0].id).toBe('recheck_2');
  });

  it('reproduces the active-request race with database-level duplicate protection', async () => {
    const harness = await createRecheckTestDatabase();
    databases.push(harness);

    const attempts = await Promise.allSettled([
      harness.db.execute(openRequest('recheck_1')),
      harness.concurrentDb.execute(openRequest('recheck_2')),
    ]);

    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await harness.db.execute('SELECT COUNT(*) AS count FROM recheck_requests')).rows[0].count).toBe(1);
  });

  it('provides deterministic clocks, IDs, and a fail-closed network guard', async () => {
    const clock = createDeterministicClock();
    const nextId = createDeterministicIds();
    const restoreNetwork = blockExternalNetwork();
    try {
      expect(clock.iso()).toBe('2026-01-01T00:00:00.000Z');
      expect(clock.advance(1_500).toISOString()).toBe('2026-01-01T00:00:01.500Z');
      expect(nextId('recheck')).toBe('recheck_0001');
      expect(nextId('event')).toBe('event_0001');
      expect(nextId('recheck')).toBe('recheck_0002');
      await expect(fetch('https://production.turso.io')).rejects.toThrow('External network access is disabled');
    } finally {
      restoreNetwork();
    }
  });

  it('closes both clients and performs bounded temporary-directory cleanup', async () => {
    const harness = await createRecheckTestDatabase();
    const removedImmediately = await harness.close();

    expect(typeof removedImmediately).toBe('boolean');
    await expect(harness.db.execute('SELECT 1')).rejects.toThrow();
    await expect(harness.concurrentDb.execute('SELECT 1')).rejects.toThrow();
  });
});
