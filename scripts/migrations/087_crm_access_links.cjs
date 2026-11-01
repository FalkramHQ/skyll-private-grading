#!/usr/bin/env node

// CRM M2 phase 2, slice 3 (FLKRM-328): secure parent links and reminder
// pauses (CRM-019, D7/D10). Additive + idempotent (sqld-safe).
//
// crm_access_links     — links sent in WhatsApp messages: the parent fees
//                        page (every child a guardian pays for) and, from S4,
//                        the report page. Only a SHA-256 of the token is
//                        stored; the token itself exists only in the message.
//                        Valid 60 days (fees) and revocable.
// crm_reminder_pauses  — staff paused a student's fee reminders until a date
//                        ("the parent promised to pay on the 25th").
const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');

try {
  require('dotenv').config({ path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'), quiet: true, override: true });
} catch {
  // OCI supplies the protected environment through systemd.
}

const migrationId = '087_crm_access_links';
const apply = process.argv.includes('--apply');
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;

const statements = [
  `CREATE TABLE IF NOT EXISTS crm_access_links (
    id TEXT NOT NULL PRIMARY KEY,
    school_id TEXT NOT NULL,
    purpose TEXT NOT NULL CHECK (purpose IN ('fees', 'report')),
    token_hash TEXT NOT NULL,
    contact_id TEXT,
    submission_id TEXT,
    student_id TEXT,
    message_id TEXT,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    revoked_by TEXT,
    last_opened_at TEXT,
    open_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS crm_access_links_token_idx ON crm_access_links (token_hash)',
  'CREATE INDEX IF NOT EXISTS crm_access_links_contact_idx ON crm_access_links (school_id, contact_id, purpose, expires_at)',
  'CREATE INDEX IF NOT EXISTS crm_access_links_message_idx ON crm_access_links (school_id, message_id)',

  `CREATE TABLE IF NOT EXISTS crm_reminder_pauses (
    id TEXT NOT NULL PRIMARY KEY,
    school_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    until_date TEXT NOT NULL,
    created_by TEXT,
    ended_at TEXT,
    ended_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS crm_reminder_pauses_student_idx ON crm_reminder_pauses (school_id, student_id, until_date)',
  // At most one open pause per student.
  'CREATE UNIQUE INDEX IF NOT EXISTS crm_reminder_pauses_open_idx ON crm_reminder_pauses (school_id, student_id) WHERE ended_at IS NULL',
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
