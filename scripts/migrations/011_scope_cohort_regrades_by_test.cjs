#!/usr/bin/env node

/* Scope browser-driven regrades to one canonical assessment. */
const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');
require('dotenv').config({ path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'), quiet: true, override: true });

const migrationId = '011_scope_cohort_regrades_by_test';
const apply = process.argv.includes('--apply');
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;

async function main() {
  if (!apply) return console.log(`${migrationId}: dry run; scoped cohort regrade migration ready.`);
  if (!dbUrl || !authToken) throw new Error('Missing Turso configuration.');
  const db = createClient({ url: dbUrl, authToken });
  await db.execute('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)');
  const existing = await db.execute({ sql: 'SELECT 1 FROM schema_migrations WHERE id = ?', args: [migrationId] });
  if (existing.rows.length) return console.log(`${migrationId}: already applied.`);
  const columns = await db.execute('PRAGMA table_info(cohort_regrade_runs)');
  if (!columns.rows.some((row) => row.name === 'test_id')) await db.execute('ALTER TABLE cohort_regrade_runs ADD COLUMN test_id TEXT');
  const statements = ['CREATE INDEX IF NOT EXISTS cohort_regrade_runs_test_scope_idx ON cohort_regrade_runs (test_id, subject, grade, requested_at DESC)'];
  const now = new Date().toISOString();
  const checksum = crypto.createHash('sha256').update(statements.join('\n')).digest('hex');
  await db.batch([...statements.map((sql) => ({ sql })), { sql: 'INSERT INTO schema_migrations (id, applied_at, checksum) VALUES (?, ?, ?)', args: [migrationId, now, checksum] }], 'write');
  console.log(`${migrationId}: applied at ${now}.`);
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
