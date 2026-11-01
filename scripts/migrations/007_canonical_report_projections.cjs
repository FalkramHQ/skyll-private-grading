#!/usr/bin/env node

/* Formalize the report projection columns introduced during backfill. */
const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');
require('dotenv').config({ path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'), quiet: true, override: true });

const migrationId = '007_canonical_report_projections';
const apply = process.argv.includes('--apply');
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;

async function ensureColumn(db, table, column, type) {
  const info = await db.execute(`PRAGMA table_info(${table})`);
  if (!info.rows.some((row) => row.name === column)) await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

async function main() {
  if (!apply) return console.log(`${migrationId}: dry run; canonical report projection migration ready.`);
  if (!dbUrl || !authToken) throw new Error('Missing Turso configuration.');
  const db = createClient({ url: dbUrl, authToken });
  await db.execute('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)');
  const existing = await db.execute({ sql: 'SELECT 1 FROM schema_migrations WHERE id = ?', args: [migrationId] });
  if (existing.rows.length) return console.log(`${migrationId}: already applied.`);
  await ensureColumn(db, 'report_versions', 'username', 'TEXT');
  await ensureColumn(db, 'report_versions', 'school', 'TEXT');
  const statements = [
    `CREATE TABLE IF NOT EXISTS teacher_report_versions (
      username TEXT PRIMARY KEY,
      school TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS report_versions_username_status_idx ON report_versions (username, status, version DESC)',
    'CREATE INDEX IF NOT EXISTS teacher_report_versions_school_idx ON teacher_report_versions (school, username)',
  ];
  const now = new Date().toISOString();
  const checksum = crypto.createHash('sha256').update(statements.join('\n')).digest('hex');
  await db.batch([...statements.map((sql) => ({ sql })), { sql: 'INSERT INTO schema_migrations (id, applied_at, checksum) VALUES (?, ?, ?)', args: [migrationId, now, checksum] }], 'write');
  console.log(`${migrationId}: applied at ${now}.`);
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
