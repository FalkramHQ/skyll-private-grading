#!/usr/bin/env node

/* Add dependency metadata to canonical report modules. */
const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');

require('dotenv').config({ path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'), quiet: true, override: true });

const migrationId = '010_report_module_dependencies';
const apply = process.argv.includes('--apply');
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;

async function ensureColumn(db, table, column, type) {
  const info = await db.execute(`PRAGMA table_info(${table})`);
  if (!info.rows.some((row) => row.name === column)) await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

async function main() {
  if (!apply) return console.log(`${migrationId}: dry run; report module dependency migration ready.`);
  if (!dbUrl || !authToken) throw new Error('Missing Turso configuration.');
  const db = createClient({ url: dbUrl, authToken });
  await db.execute('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)');
  const existing = await db.execute({ sql: 'SELECT 1 FROM schema_migrations WHERE id = ?', args: [migrationId] });
  if (existing.rows.length) return console.log(`${migrationId}: already applied.`);

  await ensureColumn(db, 'report_modules', 'module_key', 'TEXT');
  await ensureColumn(db, 'report_modules', 'dependency_json', 'TEXT');
  await ensureColumn(db, 'report_modules', 'status', "TEXT NOT NULL DEFAULT 'published'");
  const statements = [
    'CREATE INDEX IF NOT EXISTS report_modules_report_key_idx ON report_modules (report_version_id, module_key)',
    'CREATE INDEX IF NOT EXISTS report_modules_question_idx ON report_modules (submission_question_id, source_revision DESC)',
  ];
  const now = new Date().toISOString();
  const checksum = crypto.createHash('sha256').update(statements.join('\n')).digest('hex');
  await db.batch([...statements.map((sql) => ({ sql })), { sql: 'INSERT INTO schema_migrations (id, applied_at, checksum) VALUES (?, ?, ?)', args: [migrationId, now, checksum] }], 'write');
  console.log(`${migrationId}: applied at ${now}.`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
