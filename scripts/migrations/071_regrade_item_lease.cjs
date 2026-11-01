#!/usr/bin/env node

// Lease for cohort regrade items.
//
// processCohortRegradeStep claims a regrade_items row into state 'processing'
// and, if the process dies mid-item, the row stays 'processing' forever: the
// run never finishes and createCohortRegrade answers 409 for that test. The
// worker/API now expire leases older than COHORT_REGRADE_ITEM_LEASE_MS
// (default 10 min) using started_at as the anchor and this new attempt_count
// column to bound retries (3 claims, then 'failed' with error 'lease expired').
//
// Additive + idempotent (Turso-safe: no VACUUM, no DROP COLUMN).
//
//   node scripts/migrations/071_regrade_item_lease.cjs --dry-run
//   node scripts/migrations/071_regrade_item_lease.cjs --apply
const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');

try {
  require('dotenv').config({ path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'), quiet: true, override: true });
} catch {
  // OCI supplies the protected environment through systemd.
}

const migrationId = '071_regrade_item_lease';
const apply = process.argv.includes('--apply');
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;
const columns = [
  ['attempt_count', 'INTEGER NOT NULL DEFAULT 0'],
];
const statements = [
  'CREATE INDEX IF NOT EXISTS regrade_items_run_state_started_idx ON regrade_items (run_id, state, started_at)',
];

async function main() {
  if (!apply) return console.log(`${migrationId}: dry run; ${columns.length + statements.length} changes.`);
  if (!dbUrl || !authToken) throw new Error('Missing Turso configuration.');
  const db = createClient({ url: dbUrl, authToken });
  await db.execute('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)');
  const existing = await db.execute({ sql: 'SELECT 1 FROM schema_migrations WHERE id = ?', args: [migrationId] });
  if (existing.rows.length) return console.log(`${migrationId}: already applied.`);
  const info = await db.execute('PRAGMA table_info(regrade_items)');
  if (!info.rows.length) throw new Error('regrade_items is required before applying this migration (030_regrade_unification_retention).');
  const existingColumns = new Set(info.rows.map((row) => row.name));
  const additions = columns.filter(([name]) => !existingColumns.has(name)).map(([name, type]) => `ALTER TABLE regrade_items ADD COLUMN ${name} ${type}`);
  const allStatements = [...additions, ...statements];
  const now = new Date().toISOString();
  const checksum = crypto.createHash('sha256').update(allStatements.join('\n')).digest('hex');
  await db.batch([...allStatements.map((sql) => ({ sql })), { sql: 'INSERT INTO schema_migrations (id, applied_at, checksum) VALUES (?, ?, ?)', args: [migrationId, now, checksum] }], 'write');
  console.log(`${migrationId}: applied ${allStatements.length} change(s) at ${now}.`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
