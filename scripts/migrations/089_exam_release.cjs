#!/usr/bin/env node

// exams.released_at / released_by: when a teacher released the test to students.
//
// Students and parents see an exam's reports, answer sheets and tutor context
// only once released_at is set ("Release to students" in the review dashboard);
// teachers and admins see results as soon as they are graded. So that nothing
// students can see today disappears, every exam that already has a report is
// backfilled as released at its first report's publication.
//
// Additive + idempotent (Turso-safe: no VACUUM, no DROP COLUMN). Back up first:
//
//   node scripts/migrations/backupFullDb.cjs
//   node scripts/migrations/089_exam_release.cjs --dry-run
//   node scripts/migrations/089_exam_release.cjs --apply
const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');

try {
  require('dotenv').config({ path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'), quiet: true, override: true });
} catch {
  // OCI supplies the protected environment through systemd.
}

const migrationId = '089_exam_release';
const apply = process.argv.includes('--apply');
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;
const firstReport = 'SELECT MIN(COALESCE(r.published_at, r.generated_at)) FROM report_versions r WHERE r.exam_id = exams.id';
const columns = [
  'ALTER TABLE exams ADD COLUMN released_at TEXT',
  'ALTER TABLE exams ADD COLUMN released_by TEXT',
];
const statements = [
  `UPDATE exams SET released_at = COALESCE((${firstReport}), CURRENT_TIMESTAMP), released_by = '${migrationId}'
    WHERE released_at IS NULL AND EXISTS (SELECT 1 FROM report_versions r WHERE r.exam_id = exams.id)`,
];

async function counts(db, hasColumn) {
  const pending = hasColumn ? 'released_at IS NULL' : '1 = 1';
  const row = (await db.execute(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN ${pending} AND EXISTS (SELECT 1 FROM report_versions r WHERE r.exam_id = exams.id) THEN 1 ELSE 0 END) AS release,
      SUM(CASE WHEN ${pending} AND NOT EXISTS (SELECT 1 FROM report_versions r WHERE r.exam_id = exams.id) THEN 1 ELSE 0 END) AS held
    FROM exams`)).rows[0];
  return { total: Number(row.total || 0), release: Number(row.release || 0), held: Number(row.held || 0) };
}

async function main() {
  if (!dbUrl || !authToken) throw new Error('Missing Turso configuration.');
  const db = createClient({ url: dbUrl, authToken });
  await db.execute('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)');
  const existing = await db.execute({ sql: 'SELECT 1 FROM schema_migrations WHERE id = ?', args: [migrationId] });
  if (existing.rows.length) return console.log(`${migrationId}: already applied.`);
  const info = await db.execute('PRAGMA table_info(exams)');
  if (!info.rows.length) throw new Error('exams is required before applying this migration (001_canonical_assessment_core).');
  const present = new Set(info.rows.map((row) => row.name));
  const hasColumn = present.has('released_at');
  const before = await counts(db, hasColumn);
  console.log(`${migrationId}: ${before.total} exams; ${before.release} already have reports and are marked released; ${before.held} have none and wait for a teacher to release them.`);
  const addColumns = columns.filter((sql) => !present.has(sql.match(/ADD COLUMN (\w+)/)[1]));
  if (!apply) return console.log(`${migrationId}: dry run; adds ${addColumns.length} column(s), backfills ${before.release} exam(s).`);
  const allStatements = [...addColumns, ...statements];
  const now = new Date().toISOString();
  const checksum = crypto.createHash('sha256').update(allStatements.join('\n')).digest('hex');
  await db.batch([...allStatements.map((sql) => ({ sql })), { sql: 'INSERT INTO schema_migrations (id, applied_at, checksum) VALUES (?, ?, ?)', args: [migrationId, now, checksum] }], 'write');
  const after = await counts(db, true);
  console.log(`${migrationId}: applied ${allStatements.length} change(s) at ${now}; ${after.release} still to backfill (expect 0), ${after.held} wait for release.`);
}

module.exports = { migrationId, columns, statements };

if (require.main === module) {
  main().catch((error) => { console.error(`${migrationId} failed: ${error.message}`); process.exitCode = 1; });
}
