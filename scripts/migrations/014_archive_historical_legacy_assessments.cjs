#!/usr/bin/env node

/*
 * Removes pre-canonical assessment projections from the live review queue
 * without deleting a single report, answer, grade, or review decision.
 *
 * These submissions predate the tests table and use one `legacy_test_*` value
 * per student. They cannot represent one canonical assessment safely because
 * a single submission may contain multiple subjects. They remain available to
 * audited/admin tooling through `includeArchived=true`, but are never mixed
 * into active school review work.
 *
 * Usage:
 *   node scripts/migrations/014_archive_historical_legacy_assessments.cjs --school PartnerG
 *   node scripts/migrations/014_archive_historical_legacy_assessments.cjs --school PartnerG --apply
 */
const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');

try {
  require('dotenv').config({
    path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'),
    quiet: true,
    override: true,
  });
} catch {
  // OCI sources its environment before running operational migrations.
}

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const schoolIndex = args.indexOf('--school');
const school = schoolIndex >= 0 ? String(args[schoolIndex + 1] || '').trim() : '';
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN || process.env.NEXT_PUBLIC_DB_TOKEN;

if (!school) throw new Error('Pass --school <name>; archival is deliberately scoped to one school.');
if (!dbUrl || !authToken) throw new Error('Missing Turso configuration.');

const db = createClient({ url: dbUrl, authToken });
const migrationId = `014_archive_historical_legacy_assessments:${school.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

async function main() {
  const candidates = await db.execute({
    sql: `SELECT s.id, s.test_id, s.student_id, s.status, COUNT(q.id) AS questions
          FROM test_submissions s
          JOIN submission_questions q ON q.submission_id = s.id
          LEFT JOIN tests t ON t.id = s.test_id
          WHERE q.school = ? AND s.test_id LIKE 'legacy_test_%' AND t.id IS NULL
          GROUP BY s.id, s.test_id, s.student_id, s.status
          ORDER BY s.student_id`,
    args: [school],
  });
  const active = candidates.rows.filter((row) => row.status !== 'archived');
  const summary = {
    migrationId,
    school,
    candidates: candidates.rows.length,
    activeCandidates: active.length,
    questionRows: candidates.rows.reduce((sum, row) => sum + Number(row.questions || 0), 0),
    mode: apply ? 'apply' : 'dry-run',
  };
  if (!apply) return console.log(JSON.stringify(summary, null, 2));

  await db.execute('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)');
  await db.execute(`CREATE TABLE IF NOT EXISTS legacy_assessment_archives (
    migration_id TEXT NOT NULL, submission_id TEXT NOT NULL, test_id TEXT NOT NULL,
    student_id TEXT NOT NULL, previous_status TEXT NOT NULL, archived_at TEXT NOT NULL,
    PRIMARY KEY (migration_id, submission_id)
  )`);
  const previous = await db.execute({ sql: 'SELECT 1 FROM schema_migrations WHERE id = ?', args: [migrationId] });
  if (previous.rows.length) return console.log(JSON.stringify({ ...summary, alreadyApplied: true }, null, 2));

  const now = new Date().toISOString();
  for (const row of active) {
    await db.execute({
      sql: `INSERT INTO legacy_assessment_archives
            (migration_id, submission_id, test_id, student_id, previous_status, archived_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(migration_id, submission_id) DO NOTHING`,
      args: [migrationId, row.id, row.test_id, row.student_id, row.status, now],
    });
  }
  await db.execute({
    sql: `UPDATE test_submissions SET status = 'archived', updated_at = ?
          WHERE id IN (
            SELECT s.id FROM test_submissions s
            JOIN submission_questions q ON q.submission_id = s.id
            LEFT JOIN tests t ON t.id = s.test_id
            WHERE q.school = ? AND s.test_id LIKE 'legacy_test_%' AND t.id IS NULL
          )`,
    args: [now, school],
  });
  const checksum = crypto.createHash('sha256').update(`archive:${school}:legacy_test`).digest('hex');
  await db.execute({ sql: 'INSERT INTO schema_migrations (id, applied_at, checksum) VALUES (?, ?, ?)', args: [migrationId, now, checksum] });

  const remaining = await db.execute({
    sql: `SELECT COUNT(*) AS count FROM test_submissions s
          JOIN submission_questions q ON q.submission_id = s.id
          LEFT JOIN tests t ON t.id = s.test_id
          WHERE q.school = ? AND s.test_id LIKE 'legacy_test_%' AND t.id IS NULL AND s.status != 'archived'`,
    args: [school],
  });
  const remainingCount = Number(remaining.rows[0]?.count || 0);
  if (remainingCount) throw new Error(`${remainingCount} legacy submissions remained active after archival.`);
  console.log(JSON.stringify({ ...summary, archived: active.length, remainingActive: remainingCount }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
