#!/usr/bin/env node

// Add parent contact columns to the intake `students` table so parent reports
// can be delivered over WhatsApp without hand-entering a phone number every
// time. Previously notify.js required `parentPhone` in the request body and
// nothing persisted it, which made at-scale delivery impossible.
//
// parent_phone           — E.164-normalised guardian WhatsApp number
// parent_name            — optional guardian name for message personalisation
// parent_whatsapp_opted_in — 1 when the guardian consented to WhatsApp messages
//                            (mandatory for India; collected at admission)
//
// Additive + idempotent (Turso-safe: no VACUUM, no DROP COLUMN).
const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');

try {
  require('dotenv').config({ path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'), quiet: true, override: true });
} catch {
  // OCI supplies the protected environment through systemd.
}

const migrationId = '054_student_parent_contact';
const apply = process.argv.includes('--apply');
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;
const columns = [
  ['parent_phone', 'TEXT'],
  ['parent_name', 'TEXT'],
  ['parent_whatsapp_opted_in', 'INTEGER NOT NULL DEFAULT 0'],
];
const statements = [
  'CREATE INDEX IF NOT EXISTS students_parent_phone_idx ON students (parent_phone)',
];

async function main() {
  if (!apply) return console.log(`${migrationId}: dry run; ${columns.length + statements.length} changes.`);
  if (!dbUrl || !authToken) throw new Error('Missing Turso configuration.');
  const db = createClient({ url: dbUrl, authToken });
  await db.execute('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)');
  const existing = await db.execute({ sql: 'SELECT 1 FROM schema_migrations WHERE id = ?', args: [migrationId] });
  if (existing.rows.length) return console.log(`${migrationId}: already applied.`);
  const info = await db.execute('PRAGMA table_info(students)');
  if (!info.rows.length) throw new Error('students is required before applying this migration.');
  const existingColumns = new Set(info.rows.map((row) => row.name));
  const additions = columns.filter(([name]) => !existingColumns.has(name)).map(([name, type]) => `ALTER TABLE students ADD COLUMN ${name} ${type}`);
  const allStatements = [...additions, ...statements];
  const now = new Date().toISOString();
  const checksum = crypto.createHash('sha256').update(allStatements.join('\n')).digest('hex');
  await db.batch([...allStatements.map((sql) => ({ sql })), { sql: 'INSERT INTO schema_migrations (id, applied_at, checksum) VALUES (?, ?, ?)', args: [migrationId, now, checksum] }], 'write');
  console.log(`${migrationId}: applied ${allStatements.length} change(s) at ${now}.`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
