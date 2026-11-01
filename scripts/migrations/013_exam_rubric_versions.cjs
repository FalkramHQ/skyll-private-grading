#!/usr/bin/env node

const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');

require('dotenv').config({ path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'), quiet: true, override: true });

const migrationId = '013_exam_rubric_versions';
const apply = process.argv.includes('--apply');
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;
const statements = [
  `CREATE TABLE IF NOT EXISTS exam_rubric_versions (
    id TEXT PRIMARY KEY, test_id TEXT NOT NULL, job_id TEXT NOT NULL,
    version INTEGER NOT NULL, status TEXT NOT NULL, model TEXT NOT NULL,
    source_ocr_run_ids_json TEXT NOT NULL, question_map_json TEXT,
    quality_json TEXT, error TEXT, created_at TEXT NOT NULL,
    completed_at TEXT, is_active INTEGER NOT NULL DEFAULT 1,
    UNIQUE(test_id, version)
  )`,
  'CREATE INDEX IF NOT EXISTS exam_rubric_versions_test_idx ON exam_rubric_versions (test_id, is_active, created_at DESC)',
];

async function main() {
  console.log(`${migrationId}: ${apply ? 'APPLY' : 'DRY RUN'}`);
  if (!apply) return;
  if (!dbUrl || !authToken) throw new Error('Missing Turso configuration.');
  const db = createClient({ url: dbUrl, authToken });
  await db.execute('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)');
  const exists = await db.execute({ sql: 'SELECT id FROM schema_migrations WHERE id = ?', args: [migrationId] });
  if (exists.rows.length) return console.log('Already applied; no changes made.');
  await db.batch([
    ...statements.map((sql) => ({ sql })),
    { sql: 'INSERT INTO schema_migrations (id, applied_at, checksum) VALUES (?, ?, ?)', args: [migrationId, new Date().toISOString(), crypto.createHash('sha256').update(statements.join('\n')).digest('hex')] },
  ], 'write');
  console.log(`Applied ${migrationId}.`);
}

main().catch((error) => { console.error(`${migrationId} failed: ${error.message}`); process.exitCode = 1; });
