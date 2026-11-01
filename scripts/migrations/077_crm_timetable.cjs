#!/usr/bin/env node

// CRM M1b slice 3 (FLKRM-327): timetable rules and class sessions (CRM-015,
// D5–D7). Additive + idempotent (Turso/sqld-safe).
//
// crm_timetable_rules — a recurring slot for a batch: weekdays (ISO, JSON
//   list), wall-clock start/end in `timezone`, from/until dates. Editing
//   closes the version and starts a new one in the same `series_id`.
// crm_class_sessions  — one dated class. Generated from a rule (rule_id,
//   series_id) or added one-off (both NULL). starts_at/ends_at are UTC.
//   status: scheduled → held (first attendance save) | cancelled.
//   A series has at most one session per local date.
const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');

try {
  require('dotenv').config({ path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'), quiet: true, override: true });
} catch {
  // OCI supplies the protected environment through systemd.
}

const migrationId = '077_crm_timetable';
const apply = process.argv.includes('--apply');
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;

const statements = [
  `CREATE TABLE IF NOT EXISTS crm_timetable_rules (
    id TEXT NOT NULL PRIMARY KEY,
    school_id TEXT NOT NULL,
    series_id TEXT NOT NULL,
    previous_rule_id TEXT,
    batch_id TEXT NOT NULL,
    subject_id TEXT,
    instructor_user_id TEXT NOT NULL,
    weekdays TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    timezone TEXT NOT NULL,
    room_id TEXT,
    online_url TEXT,
    valid_from TEXT NOT NULL,
    valid_until TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
    version INTEGER NOT NULL DEFAULT 1,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (end_time > start_time)
  )`,
  'CREATE INDEX IF NOT EXISTS crm_timetable_rules_batch_idx ON crm_timetable_rules (school_id, batch_id, status)',
  'CREATE INDEX IF NOT EXISTS crm_timetable_rules_series_idx ON crm_timetable_rules (school_id, series_id)',

  `CREATE TABLE IF NOT EXISTS crm_class_sessions (
    id TEXT NOT NULL PRIMARY KEY,
    school_id TEXT NOT NULL,
    batch_id TEXT NOT NULL,
    rule_id TEXT,
    series_id TEXT,
    subject_id TEXT,
    instructor_user_id TEXT NOT NULL,
    room_id TEXT,
    online_url TEXT,
    local_date TEXT NOT NULL,
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    capacity INTEGER CHECK (capacity IS NULL OR capacity > 0),
    status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'held', 'cancelled')),
    cancel_reason TEXT,
    cancelled_by TEXT,
    cancelled_at TEXT,
    is_edited INTEGER NOT NULL DEFAULT 0 CHECK (is_edited IN (0, 1)),
    conflict_override INTEGER NOT NULL DEFAULT 0 CHECK (conflict_override IN (0, 1)),
    version INTEGER NOT NULL DEFAULT 1,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (ends_at > starts_at),
    CHECK ((rule_id IS NULL) = (series_id IS NULL)),
    CHECK (status != 'cancelled' OR cancel_reason IS NOT NULL)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS crm_class_sessions_series_date_idx
    ON crm_class_sessions (series_id, local_date) WHERE series_id IS NOT NULL`,
  'CREATE INDEX IF NOT EXISTS crm_class_sessions_time_idx ON crm_class_sessions (school_id, starts_at)',
  'CREATE INDEX IF NOT EXISTS crm_class_sessions_batch_idx ON crm_class_sessions (school_id, batch_id, starts_at)',
  'CREATE INDEX IF NOT EXISTS crm_class_sessions_instructor_idx ON crm_class_sessions (school_id, instructor_user_id, starts_at)',
  'CREATE INDEX IF NOT EXISTS crm_class_sessions_room_idx ON crm_class_sessions (school_id, room_id, starts_at)',
  'CREATE INDEX IF NOT EXISTS crm_class_sessions_rule_idx ON crm_class_sessions (school_id, rule_id, local_date)',
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
