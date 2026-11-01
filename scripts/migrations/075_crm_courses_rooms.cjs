#!/usr/bin/env node

// CRM M1b slice 1 (FLKRM-327): courses, CRM batch settings and rooms
// (CRM-013, D1, D7, D13). Additive + idempotent (Turso/sqld-safe).
//
// crm_courses        — the catalogue: what the institute sells. A batch (the
//                      canonical class group) links to at most one course.
// crm_batch_settings — CRM extras for a canonical `batches` row, keyed by
//                      batch_id: course link, dates, capacity, default room or
//                      online link. `batches` itself gets no new columns.
// crm_rooms          — the school's room list, so room clashes can be checked.
//
// Also adds the missing school-first index on `batches`.
const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');

try {
  require('dotenv').config({ path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'), quiet: true, override: true });
} catch {
  // OCI supplies the protected environment through systemd.
}

const migrationId = '075_crm_courses_rooms';
const apply = process.argv.includes('--apply');
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;

const statements = [
  `CREATE TABLE IF NOT EXISTS crm_courses (
    id TEXT NOT NULL PRIMARY KEY,
    school_id TEXT NOT NULL,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    program TEXT,
    subject_id TEXT,
    level TEXT,
    duration_value INTEGER CHECK (duration_value IS NULL OR duration_value > 0),
    duration_unit TEXT CHECK (duration_unit IN ('weeks', 'months', 'years')),
    delivery_mode TEXT NOT NULL DEFAULT 'classroom' CHECK (delivery_mode IN ('classroom', 'online', 'hybrid')),
    academic_year_id TEXT,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    version INTEGER NOT NULL DEFAULT 1,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((duration_value IS NULL) = (duration_unit IS NULL))
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS crm_courses_name_idx ON crm_courses (school_id, name_key)',
  'CREATE INDEX IF NOT EXISTS crm_courses_status_idx ON crm_courses (school_id, status, name)',

  `CREATE TABLE IF NOT EXISTS crm_batch_settings (
    batch_id TEXT NOT NULL PRIMARY KEY,
    school_id TEXT NOT NULL,
    course_id TEXT,
    starts_on TEXT,
    ends_on TEXT,
    capacity INTEGER CHECK (capacity IS NULL OR capacity > 0),
    default_room_id TEXT,
    default_online_url TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    updated_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS crm_batch_settings_course_idx ON crm_batch_settings (school_id, course_id)',

  `CREATE TABLE IF NOT EXISTS crm_rooms (
    id TEXT NOT NULL PRIMARY KEY,
    school_id TEXT NOT NULL,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    seats INTEGER CHECK (seats IS NULL OR seats > 0),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    version INTEGER NOT NULL DEFAULT 1,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS crm_rooms_name_idx ON crm_rooms (school_id, name_key)',

  'CREATE INDEX IF NOT EXISTS batches_school_status_idx ON batches (school_id, status)',
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
