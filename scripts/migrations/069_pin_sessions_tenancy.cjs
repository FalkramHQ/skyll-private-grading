#!/usr/bin/env node

// FLKRM-175 — expire sessions that have no pinned school.
//
// Before FLKRM-175, createSession() stored only user_id and sessionForRequest()
// re-derived tenancy from all of a user's memberships using an ORDER BY
// fallback. Sessions now pin the school resolved at login into
// sessions.credential_id, and the lookup joins on it with no ordering
// fallback — so any pre-existing row (credential_id IS NULL) matches no
// membership and is rejected at lookup.
//
// This migration makes that rejection deliberate rather than accidental by
// revoking those rows up front. We expire rather than backfill on purpose:
// backfilling would mean re-deriving tenancy with the very ordering rule this
// issue removed, writing the old guess into the new column. Affected users
// simply sign in again and are pinned to the school they actually chose.
//
// Additive + idempotent — re-running is a no-op, since the WHERE clause only
// matches rows that are still unrevoked and unpinned.
const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');

try {
  require('dotenv').config({ path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'), quiet: true, override: true });
} catch {
  // OCI supplies the protected environment through systemd.
}

const migrationId = '069_pin_sessions_tenancy';
const apply = process.argv.includes('--apply');
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;

async function main() {
  if (!dbUrl || !authToken) throw new Error('Missing Turso configuration.');
  const db = createClient({ url: dbUrl, authToken });

  const table = await db.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions'");
  if (!table.rows.length) return console.log(`${migrationId}: no sessions table; nothing to do.`);

  const columns = new Set((await db.execute('PRAGMA table_info(sessions)')).rows.map((row) => row.name));
  if (!columns.has('credential_id')) {
    throw new Error(`${migrationId}: sessions.credential_id is missing; apply 006_canonical_sessions before this migration.`);
  }
  if (!columns.has('revoked_at')) {
    throw new Error(`${migrationId}: sessions.revoked_at is missing; apply 006_canonical_sessions before this migration.`);
  }

  // Fail closed: an unpinned row that has been revoked already needs no action.
  const pending = (await db.execute({
    sql: 'SELECT COUNT(*) AS n FROM sessions WHERE credential_id IS NULL AND revoked_at IS NULL',
  })).rows[0].n;
  const total = (await db.execute('SELECT COUNT(*) AS n FROM sessions')).rows[0].n;

  console.log(`${migrationId}: ${pending} of ${total} session(s) have no pinned school and are still live.`);
  if (!pending) return console.log(`${migrationId}: nothing to expire.`);
  if (!apply) return console.log(`${migrationId}: dry run; re-run with --apply to expire them.`);

  await db.execute('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)');
  const existing = await db.execute({ sql: 'SELECT 1 FROM schema_migrations WHERE id = ?', args: [migrationId] });
  if (existing.rows.length) return console.log(`${migrationId}: already applied.`);

  const now = new Date().toISOString();
  const revoke = {
    sql: 'UPDATE sessions SET revoked_at = ? WHERE credential_id IS NULL AND revoked_at IS NULL',
    args: [now],
  };
  const checksum = crypto.createHash('sha256').update(revoke.sql).digest('hex');
  await db.batch([revoke, { sql: 'INSERT INTO schema_migrations (id, applied_at, checksum) VALUES (?, ?, ?)', args: [migrationId, now, checksum] }], 'write');
  console.log(`${migrationId}: revoked ${pending} unpinned session(s) at ${now}. Affected users reauthenticate and are pinned to their chosen school.`);
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
