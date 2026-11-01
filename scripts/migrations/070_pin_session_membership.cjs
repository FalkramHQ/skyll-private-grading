#!/usr/bin/env node

/*
 * FLKRM-175 — pin the exact membership on the session row.
 *
 * 069 pinned the school a session was created under (in sessions.credential_id)
 * and stopped re-deriving tenancy by membership ordering. A school is not quite
 * enough: school_memberships is UNIQUE(school_id, user_id, role), so one user can
 * hold two roles at the same school and the lookup would pick either. This adds
 * sessions.school_membership_id so a session carries the membership itself.
 *
 * Live sessions are backfilled from their pinned school only when exactly one
 * active membership matches (user, school) — that is the membership they signed
 * in under, not a guess. Anything else (no pin, or an ambiguous pin) is revoked
 * so the next request fails closed and the user signs in again.
 *
 * Additive + idempotent: guarded by schema_migrations, and the column add is
 * skipped if a previous partial run already landed it.
 */
const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');
require('dotenv').config({ path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'), quiet: true, override: true });

const migrationId = '070_pin_session_membership';
const apply = process.argv.includes('--apply');
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;

const addColumn = 'ALTER TABLE sessions ADD COLUMN school_membership_id TEXT';
const addIndex = 'CREATE INDEX IF NOT EXISTS sessions_membership_idx ON sessions (school_membership_id)';
// Membership for a live session's pinned school, only when it is unambiguous.
const uniqueMembership = `(SELECT CASE WHEN COUNT(*) = 1 THEN MIN(m.id) END FROM school_memberships m
                            WHERE m.user_id = sessions.user_id
                              AND m.school_id = sessions.credential_id
                              AND m.status = 'active')`;
const backfill = `UPDATE sessions SET school_membership_id = ${uniqueMembership}
                   WHERE revoked_at IS NULL AND expires_at > ? AND school_membership_id IS NULL
                     AND ${uniqueMembership} IS NOT NULL`;
const revokeUnpinned = `UPDATE sessions SET revoked_at = ?
                         WHERE revoked_at IS NULL AND expires_at > ? AND school_membership_id IS NULL`;

async function main() {
  if (!dbUrl || !authToken) throw new Error('Missing Turso configuration.');
  const db = createClient({ url: dbUrl, authToken });
  await db.execute('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)');
  const existing = await db.execute({ sql: 'SELECT 1 FROM schema_migrations WHERE id = ?', args: [migrationId] });
  if (existing.rows.length) return console.log(`${migrationId}: already applied.`);

  const columns = new Set((await db.execute('PRAGMA table_info(sessions)')).rows.map((row) => row.name));
  if (!columns.has('credential_id')) throw new Error(`${migrationId}: apply 006_canonical_sessions and 069_pin_sessions_tenancy first.`);

  const now = new Date().toISOString();
  const preview = (await db.execute({
    sql: `SELECT COUNT(*) AS live,
                 SUM(CASE WHEN ${uniqueMembership.replaceAll('sessions.', 's.')} IS NOT NULL THEN 1 ELSE 0 END) AS backfillable
            FROM sessions s WHERE s.revoked_at IS NULL AND s.expires_at > ?`,
    args: [now],
  })).rows[0];
  const live = Number(preview.live || 0);
  const backfillable = Number(preview.backfillable || 0);
  console.log(`${migrationId}: ${live} live session(s); ${backfillable} backfill to their membership, ${live - backfillable} would be revoked.`);
  if (!apply) return console.log(`${migrationId}: dry run; re-run with --apply.`);

  const statements = [
    ...(columns.has('school_membership_id') ? [] : [{ sql: addColumn }]),
    { sql: addIndex },
    { sql: backfill, args: [now] },
    { sql: revokeUnpinned, args: [now, now] },
  ];
  const checksum = crypto.createHash('sha256').update([addColumn, addIndex, backfill, revokeUnpinned].join('\n')).digest('hex');
  const results = await db.batch([...statements, { sql: 'INSERT INTO schema_migrations (id, applied_at, checksum) VALUES (?, ?, ?)', args: [migrationId, now, checksum] }], 'write');
  const [backfilled, revoked] = results.slice(-3, -1).map((result) => result.rowsAffected);
  console.log(`${migrationId}: applied at ${now}. Backfilled ${backfilled}, revoked ${revoked} session(s).`);
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
