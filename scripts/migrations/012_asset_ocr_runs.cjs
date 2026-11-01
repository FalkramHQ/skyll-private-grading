#!/usr/bin/env node

/*
 * Canonical, versioned OCR artifacts. Each source asset can have multiple OCR
 * attempts, while exactly one successful result remains active for downstream
 * segmentation and grading.
 *
 * Usage:
 *   node scripts/migrations/012_asset_ocr_runs.cjs --dry-run
 *   node scripts/migrations/012_asset_ocr_runs.cjs --apply
 */

const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');

require('dotenv').config({
  path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'),
  quiet: true,
  override: true,
});

const migrationId = '012_asset_ocr_runs';
const apply = process.argv.includes('--apply');
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;
const statements = [
  `CREATE TABLE IF NOT EXISTS asset_ocr_runs (
    id TEXT PRIMARY KEY, asset_id TEXT NOT NULL, job_id TEXT NOT NULL,
    engine TEXT NOT NULL, model TEXT NOT NULL, revision INTEGER NOT NULL,
    asset_checksum TEXT, status TEXT NOT NULL, markdown TEXT, pages_json TEXT,
    page_count INTEGER NOT NULL DEFAULT 0, usage_json TEXT, error TEXT,
    created_at TEXT NOT NULL, completed_at TEXT, is_active INTEGER NOT NULL DEFAULT 1,
    UNIQUE(asset_id, revision)
  )`,
  'CREATE INDEX IF NOT EXISTS asset_ocr_runs_asset_idx ON asset_ocr_runs (asset_id, is_active, created_at DESC)',
];

async function main() {
  console.log(`${migrationId}: ${apply ? 'APPLY' : 'DRY RUN'}`);
  if (!apply) return;
  if (!dbUrl || !authToken) throw new Error('Missing Turso configuration.');
  const db = createClient({ url: dbUrl, authToken });
  await db.execute('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)');
  const existing = await db.execute({ sql: 'SELECT id FROM schema_migrations WHERE id = ?', args: [migrationId] });
  if (existing.rows.length) return console.log('Already applied; no changes made.');
  const checksum = crypto.createHash('sha256').update(statements.join('\n')).digest('hex');
  await db.batch([
    ...statements.map((sql) => ({ sql })),
    { sql: 'INSERT INTO schema_migrations (id, applied_at, checksum) VALUES (?, ?, ?)', args: [migrationId, new Date().toISOString(), checksum] },
  ], 'write');
  console.log(`Applied ${migrationId}.`);
}

main().catch((error) => { console.error(`${migrationId} failed: ${error.message}`); process.exitCode = 1; });
