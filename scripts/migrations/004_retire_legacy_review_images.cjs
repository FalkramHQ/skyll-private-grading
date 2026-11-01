#!/usr/bin/env node

// vl_review_images was the pre-R2 base64 store. All rows were migrated and
// verified in R2 before this migration was introduced.
const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');

require('dotenv').config({ path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'), quiet: true, override: true });
const apply = process.argv.includes('--apply');
const migrationId = '004_retire_legacy_review_images';
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;

async function main() {
  if (!apply) return console.log(`${migrationId}: dry run.`);
  if (!dbUrl || !authToken) throw new Error('Missing Turso configuration.');
  const db = createClient({ url: dbUrl, authToken });
  const migrationTable = await db.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'");
  if (!migrationTable.rows.length) throw new Error('schema_migrations is required before retiring legacy storage.');
  const applied = await db.execute({ sql: 'SELECT id FROM schema_migrations WHERE id = ?', args: [migrationId] });
  if (applied.rows.length) return console.log(`${migrationId}: already applied.`);
  const legacy = await db.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'vl_review_images'");
  if (legacy.rows.length) {
    const count = await db.execute('SELECT COUNT(*) AS count FROM vl_review_images');
    if (Number(count.rows[0].count) !== 0) throw new Error('Refusing to drop vl_review_images while it still contains data.');
    await db.execute('DROP TABLE vl_review_images');
  }
  const now = new Date().toISOString();
  const checksum = crypto.createHash('sha256').update('drop-empty-vl_review_images').digest('hex');
  await db.execute({ sql: 'INSERT INTO schema_migrations (id, applied_at, checksum) VALUES (?, ?, ?)', args: [migrationId, now, checksum] });
  console.log(`${migrationId}: applied at ${now}.`);
}
main().catch((error) => { console.error(`Migration failed: ${error.message}`); process.exitCode = 1; });
