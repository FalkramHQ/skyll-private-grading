#!/usr/bin/env node

// CRM M1b slice 2 (FLKRM-327): instructor assignment and availability
// (CRM-014, D2, D4). Additive + idempotent (Turso/sqld-safe).
//
// crm_batch_instructors       — who teaches a canonical batch, optionally for
//                               one subject. One lead per batch. Ending an
//                               assignment keeps the row (status 'ended').
// crm_availability_windows    — weekly windows (ISO weekday 1 = Monday,
//                               minutes from midnight, school local time).
//                               No windows = always available.
// crm_availability_exceptions — dated "not available" (leave, training):
//                               whole days, or a time range on those days.
const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');

try {
  require('dotenv').config({ path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'), quiet: true, override: true });
} catch {
  // OCI supplies the protected environment through systemd.
}

const migrationId = '076_crm_instructors';
const apply = process.argv.includes('--apply');
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;

const statements = [
  `CREATE TABLE IF NOT EXISTS crm_batch_instructors (
    id TEXT NOT NULL PRIMARY KEY,
    school_id TEXT NOT NULL,
    batch_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    subject_id TEXT,
    is_lead INTEGER NOT NULL DEFAULT 0 CHECK (is_lead IN (0, 1)),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
    started_at TEXT NOT NULL,
    ended_at TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (status = 'active' OR is_lead = 0)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS crm_batch_instructors_active_idx
    ON crm_batch_instructors (batch_id, user_id, IFNULL(subject_id, '')) WHERE status = 'active'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS crm_batch_instructors_lead_idx
    ON crm_batch_instructors (batch_id) WHERE status = 'active' AND is_lead = 1`,
  'CREATE INDEX IF NOT EXISTS crm_batch_instructors_user_idx ON crm_batch_instructors (school_id, user_id, status)',
  'CREATE INDEX IF NOT EXISTS crm_batch_instructors_batch_idx ON crm_batch_instructors (school_id, batch_id, status)',

  `CREATE TABLE IF NOT EXISTS crm_availability_windows (
    id TEXT NOT NULL PRIMARY KEY,
    school_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    weekday INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
    start_minute INTEGER NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
    end_minute INTEGER NOT NULL CHECK (end_minute BETWEEN 1 AND 1440),
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (end_minute > start_minute)
  )`,
  'CREATE INDEX IF NOT EXISTS crm_availability_windows_user_idx ON crm_availability_windows (school_id, user_id, weekday)',

  `CREATE TABLE IF NOT EXISTS crm_availability_exceptions (
    id TEXT NOT NULL PRIMARY KEY,
    school_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    starts_on TEXT NOT NULL,
    ends_on TEXT NOT NULL,
    start_minute INTEGER CHECK (start_minute BETWEEN 0 AND 1439),
    end_minute INTEGER CHECK (end_minute BETWEEN 1 AND 1440),
    reason TEXT NOT NULL,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    removed_at TEXT,
    CHECK (ends_on >= starts_on),
    CHECK ((start_minute IS NULL) = (end_minute IS NULL)),
    CHECK (start_minute IS NULL OR end_minute > start_minute)
  )`,
  'CREATE INDEX IF NOT EXISTS crm_availability_exceptions_user_idx ON crm_availability_exceptions (school_id, user_id, starts_on)',
];

async function main() {
  if (!apply) return console.log(`${migrationId}: dry run; ${statements.length} statements.`);
  if (!dbUrl || !authToken) throw new Error('Missing Turso configuration.');
  const db = createClient({ url: dbUrl, authToken });
  await db.execute('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)');
  const existing = await db.execute({ sql: 'SELECT 1 FROM schema_migrations WHERE id = ?', args: [migrationId] });
  if (existing.rows.length) return console.log(`${migrationId}: already applied.`);
  const now = new Date().toISOString();
  const checksum = crypto.createHash('sha256').update(statements.join('\n')).digest('hex');
  await db.batch([
    ...statements.map((sql) => ({ sql })),
    { sql: 'INSERT INTO schema_migrations (id, applied_at, checksum) VALUES (?, ?, ?)', args: [migrationId, now, checksum] },
  ], 'write');
  console.log(`${migrationId}: applied ${statements.length} statement(s) at ${now}.`);
}

module.exports = { migrationId, statements };

if (require.main === module) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
