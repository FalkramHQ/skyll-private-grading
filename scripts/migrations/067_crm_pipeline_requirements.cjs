#!/usr/bin/env node

// CRM M1 slice 5 (FLKRM-326): data a school can require before a lead is
// enrolled (CRM-010, D5). Stored per pipeline as JSON of on/off toggles
// (guardianPhone, learnerGrade, source, applicantStage); all off by default.
// Additive + idempotent (Turso/sqld-safe): the column is added only when missing.
const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');

try {
  require('dotenv').config({ path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'), quiet: true, override: true });
} catch {
  // OCI supplies the protected environment through systemd.
}

const migrationId = '067_crm_pipeline_requirements';
const apply = process.argv.includes('--apply');
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;

const columns = [['requirements_json', "TEXT NOT NULL DEFAULT '{}'"]];

// Statements for a database that has 060 but not this migration (tests use these).
const statements = columns.map(([name, type]) => `ALTER TABLE crm_pipelines ADD COLUMN ${name} ${type}`);

async function pendingStatements(db) {
  const info = await db.execute('PRAGMA table_info(crm_pipelines)');
  if (!info.rows.length) throw new Error('crm_pipelines is required before applying this migration (run 060 first).');
  const existing = new Set(info.rows.map((row) => row.name));
  return columns.filter(([name]) => !existing.has(name)).map(([name, type]) => `ALTER TABLE crm_pipelines ADD COLUMN ${name} ${type}`);
}

async function main() {
  if (!dbUrl || !authToken) throw new Error('Missing database configuration.');
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
