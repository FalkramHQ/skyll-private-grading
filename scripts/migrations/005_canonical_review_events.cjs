#!/usr/bin/env node

/*
 * Canonical review-event ledger.
 *
 * Review edits are audit events attached to a submission question, not to the
 * retired queue implementation. This migration is additive and safe to run
 * before legacy queue retirement.
 */

const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');

require('dotenv').config({
  path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'),
  quiet: true,
  override: true,
});

const migrationId = '005_canonical_review_events';
const apply = process.argv.includes('--apply');
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;
const statements = [
  `CREATE TABLE IF NOT EXISTS question_review_events (
    id TEXT PRIMARY KEY,
    submission_question_id TEXT NOT NULL,
    actor_user_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    before_json TEXT,
    after_json TEXT,
    comment TEXT,
    created_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS question_review_events_question_idx ON question_review_events (submission_question_id, created_at DESC)',
];

async function main() {
  if (!apply) {
    console.log(`${migrationId}: dry run; ${statements.length} statements ready.`);
    return;
  }
  if (!dbUrl || !authToken) throw new Error('Missing Turso configuration.');
  const db = createClient({ url: dbUrl, authToken });
  await db.execute('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)');
  const existing = await db.execute({ sql: 'SELECT 1 FROM schema_migrations WHERE id = ?', args: [migrationId] });
  if (existing.rows.length) {
    console.log(`${migrationId}: already applied.`);
    return;
  }
  const now = new Date().toISOString();
  const checksum = crypto.createHash('sha256').update(statements.join('\n')).digest('hex');
  await db.batch([
    ...statements.map((sql) => ({ sql })),
    { sql: 'INSERT INTO schema_migrations (id, applied_at, checksum) VALUES (?, ?, ?)', args: [migrationId, now, checksum] },
  ], 'write');
  console.log(`${migrationId}: applied at ${now}.`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
