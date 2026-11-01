#!/usr/bin/env node

/* Canonical, auditable student rechecks with one active request per question. */
const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');

require('dotenv').config({ path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'), quiet: true, override: true });

const migrationId = '016_recheck_workflow';
const apply = process.argv.includes('--apply');
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;
const statements = [
  `CREATE TABLE IF NOT EXISTS recheck_events (
    id TEXT PRIMARY KEY,
    recheck_request_id TEXT NOT NULL,
    actor_user_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    before_json TEXT,
    after_json TEXT,
    note TEXT,
    created_at TEXT NOT NULL
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS recheck_requests_one_active_question_idx ON recheck_requests (submission_question_id) WHERE status IN ('open', 'in_review', 'awaiting_regrade')",
  'CREATE INDEX IF NOT EXISTS recheck_requests_status_requested_idx ON recheck_requests (status, requested_at DESC)',
  'CREATE INDEX IF NOT EXISTS recheck_events_request_created_idx ON recheck_events (recheck_request_id, created_at DESC)',
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
