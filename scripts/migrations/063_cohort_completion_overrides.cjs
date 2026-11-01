#!/usr/bin/env node

// Explicit, reversible "mark this cohort done" override (FLKRM-351). Additive
// + idempotent (Turso-safe).
//
// Cohort completion is derived from live review counts (pending,
// changedQuestions), so the override must be persisted as an input to that
// derivation — an in-place UI flag would be recomputed away on the next load.
// A dedicated table (not a column on an exam/cohort record) keeps the marker
// attributable and lets un-marking restore the derived status exactly.
//
// cohort_completion_overrides — at most one active override per (school, test)
//   cohort. Rows are retired by setting released_at rather than deleted so the
//   audit trail survives an un-mark.
const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');

try {
  require('dotenv').config({ path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'), quiet: true, override: true });
} catch {
  // OCI supplies the protected environment through systemd.
}

const migrationId = '063_cohort_completion_overrides';
const apply = process.argv.includes('--apply');
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;

const statements = [
  `CREATE TABLE IF NOT EXISTS cohort_completion_overrides (
    id TEXT PRIMARY KEY,
    school TEXT NOT NULL,
    test_id TEXT NOT NULL,
    subject TEXT,
    grade TEXT,
    narrative TEXT,
    marked_in_review INTEGER NOT NULL DEFAULT 0 CHECK (marked_in_review IN (0, 1)),
    pending_at_override INTEGER NOT NULL DEFAULT 0,
    marked_by TEXT NOT NULL,
    marked_at TEXT NOT NULL,
    released_by TEXT,
    released_at TEXT
  )`,
  // One active override per cohort; released rows keep their history.
  'CREATE UNIQUE INDEX IF NOT EXISTS cohort_completion_overrides_active_idx ON cohort_completion_overrides (school, test_id) WHERE released_at IS NULL',
  'CREATE INDEX IF NOT EXISTS cohort_completion_overrides_lookup_idx ON cohort_completion_overrides (school, test_id, released_at)',
];

async function main() {
  if (!apply) return console.log(`${migrationId}: dry run; ${statements.length} statements.`);
  if (!dbUrl || !authToken) throw new Error('Missing Turso configuration.');
  const db = createClient({ url: dbUrl, authToken });
  await db.execute('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)');
  const existing = await db.execute({ sql: 'SELECT 1 FROM schema_migrations WHERE id = ?', args: [migrationId] });
  if (existing.rows.length) return console.log(`${migrationId}: already applied.`);
  const now = new Date().toISOString();
  const checksum = crypto.createHash('sha256').update(statements.join('\n')).digest('hex');
  await db.batch([
    ...statements.map((sql) => ({ sql })),
    { sql: 'INSERT INTO schema_migrations (id, applied_at, checksum) VALUES (?, ?, ?)', args: [migrationId, now, checksum] },
  ], 'write');
  console.log(`${migrationId}: applied ${statements.length} statement(s) at ${now}.`);
}

module.exports = { migrationId, statements };

if (require.main === module) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
