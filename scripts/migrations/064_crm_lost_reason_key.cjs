#!/usr/bin/env node

// CRM M1 slice 1 (FLKRM-326): lost leads record a reason *key* from a fixed
// list (price, distance, …) so admissions reports can group them. The free-text
// note stays in `lost_reason`. Additive + idempotent (Turso-safe): the column
// is added only when missing.
const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');

try {
  require('dotenv').config({ path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'), quiet: true, override: true });
} catch {
  // OCI supplies the protected environment through systemd.
}

const migrationId = '064_crm_lost_reason_key';
const apply = process.argv.includes('--apply');
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;

const columns = [['lost_reason_key', 'TEXT']];

// Statements for a database that has 062 but not this migration (tests use these).
const statements = columns.map(([name, type]) => `ALTER TABLE crm_leads ADD COLUMN ${name} ${type}`);

async function pendingStatements(db) {
  const info = await db.execute('PRAGMA table_info(crm_leads)');
  if (!info.rows.length) throw new Error('crm_leads is required before applying this migration (run 062 first).');
  const existing = new Set(info.rows.map((row) => row.name));
  return columns.filter(([name]) => !existing.has(name)).map(([name, type]) => `ALTER TABLE crm_leads ADD COLUMN ${name} ${type}`);
}

async function main() {
  if (!dbUrl || !authToken) throw new Error('Missing Turso configuration.');
  const db = createClient({ url: dbUrl, authToken });
  await db.execute('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)');
  const existing = await db.execute({ sql: 'SELECT 1 FROM schema_migrations WHERE id = ?', args: [migrationId] });
  if (existing.rows.length) return console.log(`${migrationId}: already applied.`);
  const pending = await pendingStatements(db);
  if (!apply) return console.log(`${migrationId}: dry run; ${pending.length} change(s):\n${pending.join('\n')}`);
  const now = new Date().toISOString();
  const checksum = crypto.createHash('sha256').update(statements.join('\n')).digest('hex');
  await db.batch([
    ...pending.map((sql) => ({ sql })),
    { sql: 'INSERT INTO schema_migrations (id, applied_at, checksum) VALUES (?, ?, ?)', args: [migrationId, now, checksum] },
  ], 'write');
  console.log(`${migrationId}: applied ${pending.length} change(s) at ${now}.`);
}

module.exports = { migrationId, statements, pendingStatements };

if (require.main === module) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
