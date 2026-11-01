#!/usr/bin/env node

// CRM M1b slice 5 (FLKRM-327): attendance (CRM-016, D8–D10). Additive +
// idempotent (Turso/sqld-safe).
//
// crm_session_attendance — one row per student per class session. No row means
//   "unmarked". status is checked in code (present, absent, late, excused;
//   make_up reserved for CRM-028), not by a CHECK, so new values need no
//   table rebuild. Corrections are audited (attendance.corrected); the row
//   keeps only its current state.
//
// Not named crm_attendance: an empty table of that name in the retired
// prototype's shape keeps reappearing on the live database (old code still
// creates it at runtime), so the new table takes a name nothing else uses.
const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');

try {
  require('dotenv').config({ path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'), quiet: true, override: true });
} catch {
  // OCI supplies the protected environment through systemd.
}

const migrationId = '079_crm_session_attendance';
const apply = process.argv.includes('--apply');
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;

const statements = [
  `CREATE TABLE IF NOT EXISTS crm_session_attendance (
    id TEXT NOT NULL PRIMARY KEY,
    school_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    membership_id TEXT,
    status TEXT NOT NULL,
    note TEXT,
    marked_by TEXT,
    marked_at TEXT NOT NULL,
    updated_by TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS crm_session_attendance_session_student_idx ON crm_session_attendance (session_id, student_id)',
  'CREATE INDEX IF NOT EXISTS crm_session_attendance_student_idx ON crm_session_attendance (school_id, student_id)',
  'CREATE INDEX IF NOT EXISTS crm_session_attendance_session_idx ON crm_session_attendance (school_id, session_id)',
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
