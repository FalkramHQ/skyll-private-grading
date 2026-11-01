#!/usr/bin/env node

// Adds durable worker ownership, recovery and health state. This migration is
// additive and safe to run before an OCI worker release that requires it.
const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');

try {
  require('dotenv').config({ path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'), quiet: true, override: true });
} catch {
  // OCI supplies the protected environment through systemd.
}

const migrationId = '019_processing_job_hardening';
const apply = process.argv.includes('--apply');
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;
const columns = [
  ['heartbeat_at', 'TEXT'],
  ['lease_expires_at', 'TEXT'],
  ['attempt_count', 'INTEGER NOT NULL DEFAULT 0'],
  ['next_attempt_at', 'TEXT'],
  ['last_error_code', 'TEXT'],
  ['progress_json', 'TEXT'],
];
const statements = [
  `CREATE TABLE IF NOT EXISTS worker_heartbeats (
    worker_id TEXT PRIMARY KEY,
    service TEXT NOT NULL,
    version TEXT,
    status TEXT NOT NULL,
    active_job_id TEXT,
    details_json TEXT,
    last_seen_at TEXT NOT NULL,
    started_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS processing_jobs_lease_claim_idx ON processing_jobs (status, next_attempt_at, requested_at)',
  'CREATE INDEX IF NOT EXISTS processing_jobs_worker_lease_idx ON processing_jobs (status, worker_id, lease_expires_at)',
  'CREATE INDEX IF NOT EXISTS worker_heartbeats_seen_idx ON worker_heartbeats (status, last_seen_at DESC)',
];

async function main() {
  if (!apply) return console.log(`${migrationId}: dry run; ${columns.length + statements.length} changes.`);
  if (!dbUrl || !authToken) throw new Error('Missing Turso configuration.');
  const db = createClient({ url: dbUrl, authToken });
  await db.execute('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)');
  const existing = await db.execute({ sql: 'SELECT 1 FROM schema_migrations WHERE id = ?', args: [migrationId] });
  if (existing.rows.length) return console.log(`${migrationId}: already applied.`);
  const info = await db.execute('PRAGMA table_info(processing_jobs)');
  if (!info.rows.length) throw new Error('processing_jobs is required before applying this migration.');
  const existingColumns = new Set(info.rows.map((row) => row.name));
  const additions = columns.filter(([name]) => !existingColumns.has(name)).map(([name, type]) => `ALTER TABLE processing_jobs ADD COLUMN ${name} ${type}`);
  const allStatements = [...additions, ...statements];
  const now = new Date().toISOString();
  const checksum = crypto.createHash('sha256').update(allStatements.join('\n')).digest('hex');
  await db.batch([...allStatements.map((sql) => ({ sql })), { sql: 'INSERT INTO schema_migrations (id, applied_at, checksum) VALUES (?, ?, ?)', args: [migrationId, now, checksum] }], 'write');
  console.log(`${migrationId}: applied ${allStatements.length} change(s) at ${now}.`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
