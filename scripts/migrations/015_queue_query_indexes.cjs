#!/usr/bin/env node

/* Index the exact queue and idempotency lookups used by OCI and regrading. */
const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');

require('dotenv').config({ path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'), quiet: true, override: true });

const migrationId = '015_queue_query_indexes';
const apply = process.argv.includes('--apply');
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;
const statements = [
  'CREATE INDEX IF NOT EXISTS processing_jobs_worker_claim_idx ON processing_jobs (status, type, requested_at)',
  'CREATE INDEX IF NOT EXISTS processing_jobs_test_type_status_idx ON processing_jobs (test_id, type, status, requested_at)',
  'CREATE INDEX IF NOT EXISTS cohort_regrade_runs_active_scope_idx ON cohort_regrade_runs (test_id, subject, grade, status, requested_at)',
];

async function main() {
  console.log(`${migrationId}: ${apply ? 'APPLY' : 'DRY RUN'}`);
  if (!apply) return;
  if (!dbUrl || !authToken) throw new Error('Missing Turso configuration.');
  const db = createClient({ url: dbUrl, authToken });
  await db.execute('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)');
  const existing = await db.execute({ sql: 'SELECT id FROM schema_migrations WHERE id = ?', args: [migrationId] });
  if (existing.rows.length) return console.log('Already applied; no changes made.');
  await db.batch([
    ...statements.map((sql) => ({ sql })),
    { sql: 'INSERT INTO schema_migrations (id, applied_at, checksum) VALUES (?, ?, ?)', args: [migrationId, new Date().toISOString(), crypto.createHash('sha256').update(statements.join('\n')).digest('hex')] },
  ], 'write');
  console.log(`Applied ${migrationId}.`);
}

main().catch((error) => { console.error(`${migrationId} failed: ${error.message}`); process.exitCode = 1; });
