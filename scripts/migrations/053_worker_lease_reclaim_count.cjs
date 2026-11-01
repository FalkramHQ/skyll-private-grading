#!/usr/bin/env node

// FLKRM-157: Track lease reclaims separately from retry attempts.
//
// A job's lease is heartbeated only at claim time; long pipeline stages that
// outlive the lease window get reclaimed by reclaimExpiredJobs and requeued.
// Each reclaim used to increment attempt_count, so a healthy-but-slow job burnt
// its real retry budget and eventually landed in failed_retryable as "lease
// expired" despite nothing failing. This migration adds lease_reclaim_count so
// reclaims are counted independently and never consume the budget reserved for
// genuine failures.
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

const migrationId = '053_worker_lease_reclaim_count';
const apply = process.argv.includes('--apply');
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;
const columns = [
  ['lease_reclaim_count', 'INTEGER NOT NULL DEFAULT 0'],
];
const statements = [];

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
