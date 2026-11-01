#!/usr/bin/env node

/*
 * Retire vl_review_queue after canonical read/write deployment and parity
 * verification. Run only after scripts/auditCanonicalReviewCutover.cjs passes
 * and a fresh Turso snapshot exists.
 */
const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');
require('dotenv').config({ path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'), quiet: true, override: true });

const migrationId = '008_retire_legacy_review_queue';
const apply = process.argv.includes('--apply');
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;

async function tableExists(db, table) {
  const result = await db.execute({ sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", args: [table] });
  return result.rows.length > 0;
}

async function main() {
  if (!apply) return console.log(`${migrationId}: dry run; would drop vl_review_queue only.`);
  if (!dbUrl || !authToken) throw new Error('Missing Turso configuration.');
  const db = createClient({ url: dbUrl, authToken });
  await db.execute('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)');
  const existing = await db.execute({ sql: 'SELECT 1 FROM schema_migrations WHERE id = ?', args: [migrationId] });
  if (existing.rows.length) return console.log(`${migrationId}: already applied.`);
  const legacyRows = await tableExists(db, 'vl_review_queue')
    ? Number((await db.execute("SELECT COUNT(*) AS count FROM vl_review_queue WHERE review_status != 'meta'")).rows[0]?.count || 0)
    : 0;
  const canonicalRows = Number((await db.execute('SELECT COUNT(*) AS count FROM submission_questions WHERE legacy_queue_id IS NOT NULL')).rows[0]?.count || 0);
  if (legacyRows && legacyRows !== canonicalRows) throw new Error(`Parity mismatch: ${legacyRows} legacy rows, ${canonicalRows} canonical rows.`);
  if (await tableExists(db, 'vl_review_queue')) await db.execute('DROP TABLE vl_review_queue');
  const now = new Date().toISOString();
  const checksum = crypto.createHash('sha256').update('DROP TABLE vl_review_queue').digest('hex');
  await db.execute({ sql: 'INSERT INTO schema_migrations (id, applied_at, checksum) VALUES (?, ?, ?)', args: [migrationId, now, checksum] });
  console.log(`${migrationId}: retired legacy review queue after ${canonicalRows} canonical records were verified.`);
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
