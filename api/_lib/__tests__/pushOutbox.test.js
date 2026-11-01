import { describe, expect, test, vi } from 'vitest';
import { createClient } from '@libsql/client';
import {
  buildExpoMessages,
  chunk,
  drainPushOutbox,
  enqueuePush,
  ensurePushOutboxTable,
  pushOutboxStatement,
  resolvePushTokens,
  sendExpoPush,
  EXPO_PUSH_URL,
  PUSH_EVENT_TYPES,
} from '../pushOutbox.js';

// A fake libSQL client: hands out the programmed pending rows one claim at a
// time, serves token lookups, and records every outcome UPDATE so tests can
// assert it.
function makeDb({ pendingRows = [], tokensByUsername = {}, tokensByRole = {} } = {}) {
  const updates = [];
  const queue = [...pendingRows];
  const execute = vi.fn(async ({ sql, args = [] }) => {
    if (sql.includes("SET status = 'sending'")) return { rows: queue.length ? [queue.shift()] : [] };
    if (sql.includes("WHERE status = 'sending'")) return { rows: [], rowsAffected: 0 };
    if (sql.includes('FROM intake_installations') && sql.includes('username = ?')) {
      return { rows: (tokensByUsername[args[1]] || []).map((token) => ({ expo_push_token: token })) };
    }
    if (sql.includes('FROM intake_installations') && sql.includes('role = ?')) {
      return { rows: (tokensByRole[args[1]] || []).map((token) => ({ expo_push_token: token })) };
    }
    if (sql.includes('UPDATE push_notifications') || sql.includes('UPDATE intake_installations SET expo_push_token = NULL')) {
      updates.push({ sql, args });
      return { rows: [] };
    }
    return { rows: [] };
  });
  return { execute, updates, batch: vi.fn(async () => {}) };
}

const okFetch = (tickets) => vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: tickets }) }));
const statusUpdate = (db, value) => db.updates.find((u) => u.sql.includes(`status = '${value}'`));

const pendingRow = (overrides = {}) => ({
  id: 'push_1', school: 'Test School', username: 'asha', role: null,
  event_type: PUSH_EVENT_TYPES.REPORT_PUBLISHED, title: 'Your report is ready',
  body: 'You scored 18 out of 25.', data_json: '{"screen":"student"}', ...overrides,
});

describe('pushOutboxStatement', () => {
  test('builds a pending INSERT with bounded fields', () => {
    const statement = pushOutboxStatement({
      id: 'push_x', school: 'S', username: 'u', eventType: PUSH_EVENT_TYPES.REPORT_PUBLISHED,
      title: 'T', body: 'B', data: { screen: 'student' }, createdAt: '2026-09-16T00:00:00.000Z',
    });
    expect(statement.sql).toContain("INSERT INTO push_notifications");
    expect(statement.sql).toContain("'pending', 0, ?");
    expect(statement.args).toEqual(['push_x', 'S', 'u', null, 'report_published', 'T', 'B', '{"screen":"student"}', '2026-09-16T00:00:00.000Z']);
  });

  test('serialises a role broadcast with a null username', () => {
    const statement = pushOutboxStatement({ id: 'p', school: 'S', role: 'admin', eventType: PUSH_EVENT_TYPES.PROCESSING_COMPLETE, title: 'T', body: 'B' });
    expect(statement.args[2]).toBeNull();
    expect(statement.args[3]).toBe('admin');
    expect(statement.args[7]).toBeNull();
  });

  test('rejects a message with no school, event, or target', () => {
    expect(() => pushOutboxStatement({ username: 'u', eventType: 'x', title: 't', body: 'b' })).toThrow(/school is required/);
    expect(() => pushOutboxStatement({ school: 'S', username: 'u', title: 't', body: 'b' })).toThrow(/eventType is required/);
    expect(() => pushOutboxStatement({ school: 'S', eventType: 'x', title: 't', body: 'b' })).toThrow(/username or role is required/);
  });

  test('enqueuePush executes the statement against the db', async () => {
    const db = makeDb();
    await enqueuePush(db, { id: 'push_e', school: 'S', username: 'u', eventType: PUSH_EVENT_TYPES.RECHECK_RESOLVED, title: 'T', body: 'B' });
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(db.execute.mock.calls[0][0].sql).toContain('INSERT INTO push_notifications');
  });
});

describe('resolvePushTokens', () => {
  test('resolves and de-duplicates tokens for a username', async () => {
    const db = makeDb({ tokensByUsername: { asha: ['tok_a', 'tok_a', 'tok_b'] } });
    await expect(resolvePushTokens(db, { school: 'S', username: 'asha' })).resolves.toEqual(['tok_a', 'tok_b']);
  });

  test('resolves tokens for a role broadcast', async () => {
    const db = makeDb({ tokensByRole: { admin: ['tok_admin'] } });
    await expect(resolvePushTokens(db, { school: 'S', role: 'admin' })).resolves.toEqual(['tok_admin']);
  });

  test('returns empty when neither username nor role is given', async () => {
    const db = makeDb();
    await expect(resolvePushTokens(db, { school: 'S' })).resolves.toEqual([]);
  });
});

describe('chunk / buildExpoMessages', () => {
  test('chunks into Expo-sized batches', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 2)).toEqual([]);
  });

  test('builds a push message per token with a high priority + channel', () => {
    const messages = buildExpoMessages(['tok_a'], { title: 'T', body: 'B', data: { screen: 'student' } });
    expect(messages).toEqual([{ to: 'tok_a', sound: 'default', title: 'T', body: 'B', data: { screen: 'student' }, channelId: 'default', priority: 'high' }]);
  });
});

describe('sendExpoPush', () => {
  test('posts to the Expo endpoint with an auth header when a token is set', async () => {
    const fetchImpl = okFetch([{ status: 'ok', id: 't1' }]);
    const deliveries = await sendExpoPush([{ to: 'tok_a', title: 'T', body: 'B' }], { fetchImpl, accessToken: 'secret' });
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe(EXPO_PUSH_URL);
    expect(options.headers.Authorization).toBe('Bearer secret');
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(deliveries).toEqual([{ token: 'tok_a', ticket: { status: 'ok', id: 't1' } }]);
  });

  test('splits more than 100 messages across multiple requests', async () => {
    const messages = buildExpoMessages(Array.from({ length: 150 }, (_, i) => `tok_${i}`), { title: 'T', body: 'B' });
    const fetchImpl = vi.fn(async (_url, options) => {
      const sent = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => ({ data: sent.map(() => ({ status: 'ok' })) }) };
    });
    const deliveries = await sendExpoPush(messages, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toHaveLength(100);
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toHaveLength(50);
    expect(deliveries).toHaveLength(150);
  });

  test('throws on a request-level error so the row retries', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({ errors: [{ message: 'rate limited' }] }) }));
    await expect(sendExpoPush([{ to: 'tok_a' }], { fetchImpl })).rejects.toThrow(/rate limited/);
  });

  test('aborts a request that hangs past the timeout', async () => {
    const fetchImpl = vi.fn((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason));
    }));
    await expect(sendExpoPush([{ to: 'tok_a' }], { fetchImpl, timeoutMs: 20 })).rejects.toThrow(/timed out|timeout/i);
  });
});

describe('drainPushOutbox', () => {
  test('returns zeros when nothing is pending', async () => {
    const db = makeDb({ pendingRows: [] });
    await expect(drainPushOutbox(db, { fetchImpl: okFetch([]) })).resolves.toEqual({ claimed: 0, sent: 0, failed: 0, skipped: 0 });
  });

  test('delivers to a student device and marks the row sent', async () => {
    const db = makeDb({ pendingRows: [pendingRow()], tokensByUsername: { asha: ['tok_a', 'tok_b'] } });
    const fetchImpl = okFetch([{ status: 'ok', id: 't1' }, { status: 'ok', id: 't2' }]);
    const stats = await drainPushOutbox(db, { fetchImpl, now: () => 'NOW' });
    expect(stats).toEqual({ claimed: 1, sent: 1, failed: 0, skipped: 0 });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual([
      { to: 'tok_a', sound: 'default', title: 'Your report is ready', body: 'You scored 18 out of 25.', data: { screen: 'student' }, channelId: 'default', priority: 'high' },
      { to: 'tok_b', sound: 'default', title: 'Your report is ready', body: 'You scored 18 out of 25.', data: { screen: 'student' }, channelId: 'default', priority: 'high' },
    ]);
    expect(statusUpdate(db, 'sent').args).toEqual(['NOW', null, 'push_1']);
  });

  test('skips a row when the target has no registered device', async () => {
    const db = makeDb({ pendingRows: [pendingRow()], tokensByUsername: {} });
    const fetchImpl = okFetch([]);
    const stats = await drainPushOutbox(db, { fetchImpl, now: () => 'NOW' });
    expect(stats).toEqual({ claimed: 1, sent: 0, failed: 0, skipped: 1 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(statusUpdate(db, 'skipped')).toBeTruthy();
  });

  test('clears a DeviceNotRegistered token and skips when every target is dead', async () => {
    const db = makeDb({ pendingRows: [pendingRow()], tokensByUsername: { asha: ['dead_tok'] } });
    const fetchImpl = okFetch([{ status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }]);
    const stats = await drainPushOutbox(db, { fetchImpl, now: () => 'NOW' });
    expect(stats).toEqual({ claimed: 1, sent: 0, failed: 0, skipped: 1 });
    const cleared = db.updates.find((u) => u.sql.includes('UPDATE intake_installations SET expo_push_token = NULL'));
    expect(cleared.args).toEqual(['dead_tok']);
    expect(statusUpdate(db, 'skipped')).toBeTruthy();
  });

  test('retries a transient ticket error and records the attempt cap', async () => {
    const db = makeDb({ pendingRows: [pendingRow()], tokensByUsername: { asha: ['tok_a'] } });
    const fetchImpl = okFetch([{ status: 'error', message: 'internal', details: { error: 'InternalError' } }]);
    const stats = await drainPushOutbox(db, { fetchImpl, maxAttempts: 5 });
    expect(stats).toEqual({ claimed: 1, sent: 0, failed: 1, skipped: 0 });
    const retry = db.updates.find((u) => u.sql.includes("THEN 'failed' ELSE 'pending'"));
    expect(retry.args).toEqual(['internal', 5, 'push_1']);
  });

  test('marks a partly delivered row sent instead of resending to devices that got it', async () => {
    const db = makeDb({ pendingRows: [pendingRow()], tokensByUsername: { asha: ['tok_a', 'tok_b'] } });
    const fetchImpl = okFetch([{ status: 'ok', id: 't1' }, { status: 'error', message: 'rate', details: { error: 'MessageRateExceeded' } }]);
    const stats = await drainPushOutbox(db, { fetchImpl, now: () => 'NOW' });
    expect(stats).toEqual({ claimed: 1, sent: 1, failed: 0, skipped: 0 });
    expect(statusUpdate(db, 'sent').args).toEqual(['NOW', '1/2 device(s) failed: rate', 'push_1']);
    expect(db.updates.find((u) => u.sql.includes("THEN 'failed' ELSE 'pending'"))).toBeUndefined();
  });

  test('retries when the Expo request itself throws', async () => {
    const db = makeDb({ pendingRows: [pendingRow()], tokensByUsername: { asha: ['tok_a'] } });
    const fetchImpl = vi.fn(async () => { throw new Error('network down'); });
    const stats = await drainPushOutbox(db, { fetchImpl, maxAttempts: 3 });
    expect(stats).toEqual({ claimed: 1, sent: 0, failed: 1, skipped: 0 });
    const retry = db.updates.find((u) => u.sql.includes("THEN 'failed' ELSE 'pending'"));
    expect(retry.args).toEqual(['network down', 3, 'push_1']);
  });
});

describe('drainPushOutbox on a real database', () => {
  async function outboxDb(rows) {
    const db = createClient({ url: ':memory:' });
    await db.execute(`CREATE TABLE intake_installations (installation_id TEXT PRIMARY KEY, school TEXT NOT NULL, username TEXT NOT NULL)`);
    await ensurePushOutboxTable(db);
    await db.execute({ sql: "INSERT INTO intake_installations (installation_id, school, username, expo_push_token) VALUES ('i1', 'S', 'asha', 'tok_a')" });
    for (const row of rows) await enqueuePush(db, { school: 'S', username: 'asha', eventType: PUSH_EVENT_TYPES.REPORT_PUBLISHED, title: 'T', body: 'B', ...row });
    return db;
  }
  const statusOf = async (db, id) => (await db.execute({ sql: 'SELECT status, attempts, last_error FROM push_notifications WHERE id = ?', args: [id] })).rows[0];

  test('overlapping drains send each row exactly once', async () => {
    const db = await outboxDb([{ id: 'p1', createdAt: '2026-10-21T00:00:01.000Z' }, { id: 'p2', createdAt: '2026-10-21T00:00:02.000Z' }]);
    const fetchImpl = vi.fn(async (_url, options) => ({ ok: true, status: 200, json: async () => ({ data: JSON.parse(options.body).map(() => ({ status: 'ok' })) }) }));
    const [a, b] = await Promise.all([drainPushOutbox(db, { fetchImpl }), drainPushOutbox(db, { fetchImpl })]);
    expect(a.claimed + b.claimed).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(await statusOf(db, 'p1')).toMatchObject({ status: 'sent', attempts: 1 });
    expect(await statusOf(db, 'p2')).toMatchObject({ status: 'sent', attempts: 1 });
  });

  test('a row left sending by a dead drain is reclaimed once its claim expires', async () => {
    const db = await outboxDb([{ id: 'p1' }]);
    await db.execute("UPDATE push_notifications SET status = 'sending', attempts = 1, sent_at = '2020-01-01T00:00:00.000Z' WHERE id = 'p1'");
    const fetchImpl = okFetch([{ status: 'ok' }]);
    await expect(drainPushOutbox(db, { fetchImpl, claimTimeoutMs: 365 * 24 * 3_600_000 * 100 })).resolves.toMatchObject({ claimed: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(drainPushOutbox(db, { fetchImpl })).resolves.toMatchObject({ claimed: 1, sent: 1 });
    expect(await statusOf(db, 'p1')).toMatchObject({ status: 'sent', attempts: 2 });
  });

  test('a row that keeps failing is marked failed after maxAttempts claims', async () => {
    const db = await outboxDb([{ id: 'p1' }]);
    const fetchImpl = vi.fn(async () => { throw new Error('network down'); });
    for (let i = 0; i < 3; i += 1) await drainPushOutbox(db, { fetchImpl, maxAttempts: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(await statusOf(db, 'p1')).toMatchObject({ status: 'failed', attempts: 2, last_error: 'network down' });
  });
});
