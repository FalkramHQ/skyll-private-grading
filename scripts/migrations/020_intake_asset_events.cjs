#!/usr/bin/env node

/*
 * Adds an append-only record for destructive intake asset operations.
 * Usage: node scripts/migrations/020_intake_asset_events.cjs --apply
 */
const crypto = require('crypto');
const path = require('path');
const { createClient } = require('@libsql/client');

require('dotenv').config({ path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'), quiet: true, override: true });

const migrationId = '020_intake_asset_events';
const apply = process.argv.includes('--apply');
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;
const statements = [
  'CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)',
  `CREATE TABLE IF NOT EXISTS intake_asset_events (
    id TEXT PRIMARY KEY, test_id TEXT NOT NULL, test_student_id TEXT,
    event_type TEXT NOT NULL, status TEXT NOT NULL, actor_username TEXT NOT NULL,
    reason TEXT, asset_ids_json TEXT NOT NULL, page_count INTEGER NOT NULL DEFAULT 0,
    error TEXT, created_at TEXT NOT NULL, completed_at TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS intake_asset_events_test_student_idx ON intake_asset_events (test_id, test_student_id, event_type, created_at DESC)',
];

async function main() {
  if (!apply) return console.log(`${migrationId}: dry run; ${statements.length} statements.`);
  if (!dbUrl || !authToken) throw new Error('Missing Turso configuration.');
  const db = createClient({ url: dbUrl, authToken });
  await db.execute(statements[0]);
  const existing = await db.execute({ sql: 'SELECT id FROM schema_migrations WHERE id = ?', args: [migrationId] });
  if (existing.rows.length) return console.log(`${migrationId}: already applied.`);
  const now = new Date().toISOString();
  const checksum = crypto.createHash('sha256').update(statements.join('\n')).digest('hex');
  await db.batch([
    ...statements.slice(1).map((sql) => ({ sql })),
    { sql: 'INSERT INTO schema_migrations (id, applied_at, checksum) VALUES (?, ?, ?)', args: [migrationId, now, checksum] },
  ], 'write');
  console.log(`${migrationId}: applied at ${now}.`);
}

main().catch((error) => { console.error(`Migration failed: ${error.message}`); process.exitCode = 1; });
