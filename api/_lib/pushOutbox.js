// Transactional push-notification outbox.
//
// Producers (the OCI worker on report publish / processing complete, the
// vl-queue recheck resolver, or any script) enqueue a notification with a cheap
// local INSERT — optionally folded into their existing db.batch so the push is
// queued atomically with the business write. The OCI worker drains the outbox
// and delivers through Expo's push service.
//
// Why an outbox instead of sending inline:
//   - Vercel serverless functions cannot reliably make fire-and-forget external
//     calls after responding, and the Hobby plan caps us at 12 functions — so
//     recheck-resolution pushes are queued by vl-queue and sent by the worker.
//   - Delivery gets retry, dead-token cleanup, and observability in one place.
//
// Targeting: a row addresses either one user (school + username, matching
// intake_installations) or a role broadcast (school + role). Expo push tokens
// are resolved at drain time from intake_installations.expo_push_token.
//
// Each drain claims one row at a time ('pending' -> 'sending', status-guarded),
// so overlapping drains or workers never send the same row twice. A worker that
// dies mid-send leaves its row 'sending'; the next drain reclaims it once the
// claim is older than claimTimeoutMs, the one case where a device may get a
// notification twice.

export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

export const PUSH_EVENT_TYPES = {
  REPORT_PUBLISHED: 'report_published',
  RECHECK_RESOLVED: 'recheck_resolved',
  PROCESSING_COMPLETE: 'processing_complete',
};

// Expo accepts at most 100 messages per send request.
const EXPO_CHUNK_SIZE = 100;
const DEFAULT_MAX_ATTEMPTS = 5;
const EXPO_TIMEOUT_MS = 15_000;
// Far above one row's send time (each Expo request is capped at EXPO_TIMEOUT_MS).
const DEFAULT_CLAIM_TIMEOUT_MS = 10 * 60_000;

export const PUSH_OUTBOX_DDL = [
  `CREATE TABLE IF NOT EXISTS push_notifications (
    id TEXT PRIMARY KEY,
    school TEXT NOT NULL,
    username TEXT,
    role TEXT,
    event_type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    data_json TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL,
    sent_at TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS push_notifications_drain_idx ON push_notifications (status, created_at)',
  'CREATE INDEX IF NOT EXISTS push_notifications_target_idx ON push_notifications (school, username)',
];

// intake_installations gains these lazily; both the API (ensureIntakeTables) and
// the worker (ensurePushOutboxTable) apply them idempotently.
export const INSTALLATION_PUSH_COLUMNS = ['expo_push_token TEXT', 'role TEXT'];

function newPushId() {
  return `push_${crypto.randomUUID()}`;
}

function dedupe(list) {
  return [...new Set(list.filter(Boolean))];
}

function parseData(json) {
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// Create the outbox table and add the installation push columns. Idempotent:
// CREATE ... IF NOT EXISTS, and ADD COLUMN is skipped once the column exists.
export async function ensurePushOutboxTable(db) {
  for (const sql of PUSH_OUTBOX_DDL) await db.execute({ sql });
  for (const column of INSTALLATION_PUSH_COLUMNS) {
    try {
      await db.execute({ sql: `ALTER TABLE intake_installations ADD COLUMN ${column}` });
    } catch {
      // Column already exists.
    }
  }
}

// Build the outbox INSERT as a statement so a producer can fold it into its own
// db.batch and keep the enqueue atomic with the write that triggered it.
export function pushOutboxStatement({
  school,
  username = null,
  role = null,
  eventType,
  title,
  body,
  data = null,
  id = newPushId(),
  createdAt = new Date().toISOString(),
}) {
  if (!school) throw new Error('pushOutboxStatement: school is required');
  if (!eventType) throw new Error('pushOutboxStatement: eventType is required');
  if (!username && !role) throw new Error('pushOutboxStatement: username or role is required');
  return {
    sql: `INSERT INTO push_notifications (id, school, username, role, event_type, title, body, data_json, status, attempts, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
    args: [id, school, username, role, eventType, String(title || '').slice(0, 200), String(body || '').slice(0, 500), data ? JSON.stringify(data) : null, createdAt],
  };
}

export function enqueuePush(db, message) {
  return db.execute(pushOutboxStatement(message));
}

// Resolve the Expo push tokens for a row's target (one user, or a role broadcast).
export async function resolvePushTokens(db, { school, username, role }) {
  if (username) {
    const result = await db.execute({
      sql: 'SELECT expo_push_token FROM intake_installations WHERE school = ? AND username = ? AND expo_push_token IS NOT NULL',
      args: [school, username],
    });
    return dedupe(result.rows.map((row) => row.expo_push_token));
  }
  if (role) {
    const result = await db.execute({
      sql: 'SELECT expo_push_token FROM intake_installations WHERE school = ? AND role = ? AND expo_push_token IS NOT NULL',
      args: [school, role],
    });
    return dedupe(result.rows.map((row) => row.expo_push_token));
  }
  return [];
}

export function chunk(list, size = EXPO_CHUNK_SIZE) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export function buildExpoMessages(tokens, { title, body, data = {}, channelId = 'default', sound = 'default' }) {
  return tokens.map((token) => ({ to: token, sound, title, body, data, channelId, priority: 'high' }));
}

// Send messages in Expo-compatible chunks. Returns one delivery record per
// message ({ token, ticket }) so callers can invalidate dead tokens. Throws on
// request-level failures (non-2xx or a top-level errors array) so the row retries.
export async function sendExpoPush(messages, { fetchImpl = fetch, accessToken, timeoutMs = EXPO_TIMEOUT_MS } = {}) {
  const deliveries = [];
  for (const batch of chunk(messages)) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    const response = await fetchImpl(EXPO_PUSH_URL, { method: 'POST', headers, body: JSON.stringify(batch), signal: AbortSignal.timeout(timeoutMs) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || Array.isArray(payload.errors)) {
      const detail = Array.isArray(payload.errors) ? payload.errors.map((e) => e.message).join('; ') : `Expo push HTTP ${response.status}`;
      throw new Error(detail);
    }
    const tickets = Array.isArray(payload.data) ? payload.data : [];
    batch.forEach((message, index) => deliveries.push({ token: message.to, ticket: tickets[index] || {} }));
  }
  return deliveries;
}

// attempts counts claims, so a retry only decides between another try and 'failed'.
async function markRetryable(db, id, error, maxAttempts) {
  await db.execute({
    sql: "UPDATE push_notifications SET last_error = ?, sent_at = NULL, status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'pending' END WHERE id = ?",
    args: [String(error).slice(0, 500), maxAttempts, id],
  });
}

// Claim the oldest pending row. sent_at holds the claim time while the row is
// 'sending' (no claimed_at column), and the status guard means only one drain
// can win a row.
function claimNextPushStatement({ at, maxAttempts }) {
  return {
    sql: `UPDATE push_notifications SET status = 'sending', sent_at = ?, attempts = attempts + 1
          WHERE id = (SELECT id FROM push_notifications WHERE status = 'pending' AND attempts < ? ORDER BY created_at LIMIT 1)
            AND status = 'pending'
          RETURNING id, school, username, role, event_type, title, body, data_json`,
    args: [at, maxAttempts],
  };
}

// Return rows whose drain died mid-send to the queue (or fail them once out of
// attempts), exactly like a transient error.
function reclaimStalePushStatement({ claimedBefore, maxAttempts }) {
  return {
    sql: `UPDATE push_notifications SET last_error = 'send claim expired', sent_at = NULL,
            status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'pending' END
          WHERE status = 'sending' AND sent_at < ?`,
    args: [maxAttempts, claimedBefore],
  };
}

// Drain pending rows: resolve tokens, deliver via Expo, and record the outcome.
//   - no registered device  -> 'skipped' (terminal; never retried)
//   - any ticket ok         -> 'sent'; other devices' ticket errors go to
//                              last_error, never a resend to devices that got it
//   - only DeviceNotRegistered -> dead tokens cleared, then 'skipped'
//   - transient error, nothing delivered -> retried until maxAttempts -> 'failed'
export async function drainPushOutbox(db, {
  limit = 100,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  fetchImpl = fetch,
  accessToken = process.env.EXPO_PUSH_ACCESS_TOKEN,
  timeoutMs = EXPO_TIMEOUT_MS,
  claimTimeoutMs = DEFAULT_CLAIM_TIMEOUT_MS,
  now = () => new Date().toISOString(),
} = {}) {
  await db.execute(reclaimStalePushStatement({ claimedBefore: new Date(Date.now() - claimTimeoutMs).toISOString(), maxAttempts }));

  let claimed = 0;
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  while (claimed < limit) {
    const result = await db.execute(claimNextPushStatement({ at: now(), maxAttempts }));
    const row = result.rows?.[0];
    if (!row) break;
    claimed += 1;
    const tokens = await resolvePushTokens(db, { school: row.school, username: row.username, role: row.role });
    if (!tokens.length) {
      await db.execute({ sql: "UPDATE push_notifications SET status = 'skipped', sent_at = ? WHERE id = ?", args: [now(), row.id] });
      skipped += 1;
      continue;
    }
    try {
      const deliveries = await sendExpoPush(buildExpoMessages(tokens, { title: row.title, body: row.body, data: parseData(row.data_json) }), { fetchImpl, accessToken, timeoutMs });
      const dead = deliveries.filter((d) => d.ticket?.status === 'error' && d.ticket?.details?.error === 'DeviceNotRegistered');
      for (const delivery of dead) {
        await db.execute({ sql: 'UPDATE intake_installations SET expo_push_token = NULL WHERE expo_push_token = ?', args: [delivery.token] });
      }
      const transient = deliveries.filter((d) => d.ticket?.status === 'error' && d.ticket?.details?.error !== 'DeviceNotRegistered');
      const okCount = deliveries.filter((d) => d.ticket?.status === 'ok').length;
      const ticketError = transient[0]?.ticket?.message || 'expo ticket error';
      if (okCount > 0) {
        // The outbox has no per-token record, so a retry would resend to every
        // device that already got it; record the failures instead.
        const partial = transient.length ? `${transient.length}/${deliveries.length} device(s) failed: ${ticketError}`.slice(0, 500) : null;
        await db.execute({ sql: "UPDATE push_notifications SET status = 'sent', sent_at = ?, last_error = ? WHERE id = ?", args: [now(), partial, row.id] });
        sent += 1;
      } else if (transient.length) {
        await markRetryable(db, row.id, ticketError, maxAttempts);
        failed += 1;
      } else {
        await db.execute({ sql: "UPDATE push_notifications SET status = 'skipped', sent_at = ?, last_error = ? WHERE id = ?", args: [now(), 'all target tokens unregistered', row.id] });
        skipped += 1;
      }
    } catch (error) {
      await markRetryable(db, row.id, error?.message || error, maxAttempts);
      failed += 1;
    }
  }
  return { claimed, sent, failed, skipped };
}
