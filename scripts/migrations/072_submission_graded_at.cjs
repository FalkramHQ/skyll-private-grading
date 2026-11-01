#!/usr/bin/env node

// submissions.graded_at: when a paper first became billable (FLKRM-484).
//
// A paper is billable once its report is built (every question graded,
// max_marks known), so graded_at is the paper's earliest
// report_versions.generated_at. updated_at cannot anchor an invoice month: it
// moves on every review approval and regrade. syncCanonicalSubmission keeps
// the column filled from now on (COALESCE: set once, never overwritten); this
// migration adds it and backfills existing papers with the same rule. Papers
// without a report stay NULL and unbilled until one exists.
//
// Additive + idempotent (Turso-safe: no VACUUM, no DROP COLUMN). Back up first:
//
//   node scripts/migrations/backupFullDb.cjs
//   node scripts/migrations/072_submission_graded_at.cjs --dry-run
//   node scripts/migrations/072_submission_graded_at.cjs --apply
const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');

try {
  require('dotenv').config({ path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'), quiet: true, override: true });
} catch {
  // OCI supplies the protected environment through systemd.
}

const migrationId = '072_submission_graded_at';
const apply = process.argv.includes('--apply');
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;
const earliestReport = 'SELECT MIN(r.generated_at) FROM report_versions r WHERE r.submission_id = submissions.id';
const statements = [
  'CREATE INDEX IF NOT EXISTS submissions_graded_at_idx ON submissions (graded_at)',
  `UPDATE submissions SET graded_at = (${earliestReport}) WHERE graded_at IS NULL AND (${earliestReport}) IS NOT NULL`,
];

async function counts(db, hasColumn) {
  const pending = hasColumn ? 'graded_at IS NULL' : '1 = 1';
  const row = (await db.execute(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN ${pending} AND (${earliestReport}) IS NOT NULL THEN 1 ELSE 0 END) AS fill,
      SUM(CASE WHEN ${pending} AND (${earliestReport}) IS NULL THEN 1 ELSE 0 END) AS stay_null
    FROM submissions`)).rows[0];
  return { total: Number(row.total || 0), fill: Number(row.fill || 0), stayNull: Number(row.stay_null || 0) };
}

async function main() {
  if (!dbUrl || !authToken) throw new Error('Missing Turso configuration.');
  const db = createClient({ url: dbUrl, authToken });
  await db.execute('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)');
  const existing = await db.execute({ sql: 'SELECT 1 FROM schema_migrations WHERE id = ?', args: [migrationId] });
  if (existing.rows.length) return console.log(`${migrationId}: already applied.`);
  const info = await db.execute('PRAGMA table_info(submissions)');
  if (!info.rows.length) throw new Error('submissions is required before applying this migration (001_canonical_assessment_core).');
  const hasColumn = info.rows.some((row) => row.name === 'graded_at');
  const before = await counts(db, hasColumn);
  console.log(`${migrationId}: ${before.total} submissions; ${before.fill} get graded_at from their earliest report; ${before.stayNull} have no report and stay NULL.`);
  if (!apply) return console.log(`${migrationId}: dry run; ${hasColumn ? 'column already present' : 'adds submissions.graded_at'}, index submissions_graded_at_idx, backfill ${before.fill} row(s).`);
  const allStatements = [...(hasColumn ? [] : ['ALTER TABLE submissions ADD COLUMN graded_at TEXT']), ...statements];
  const now = new Date().toISOString();
  const checksum = crypto.createHash('sha256').update(allStatements.join('\n')).digest('hex');
  await db.batch([...allStatements.map((sql) => ({ sql })), { sql: 'INSERT INTO schema_migrations (id, applied_at, checksum) VALUES (?, ?, ?)', args: [migrationId, now, checksum] }], 'write');
  const after = await counts(db, true);
  console.log(`${migrationId}: applied ${allStatements.length} change(s) at ${now}; ${after.fill} still fillable (expect 0), ${after.stayNull} without a report stay NULL.`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
