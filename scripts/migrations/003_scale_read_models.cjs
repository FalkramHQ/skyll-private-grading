#!/usr/bin/env node

/*
 * Adds read-path indexes, a compact teacher-dashboard projection, and a
 * policy-driven retention configuration. It is additive and idempotent.
 *
 * Usage: node scripts/migrations/003_scale_read_models.cjs --apply
 */
const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');

require('dotenv').config({ path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'), quiet: true, override: true });

const migrationId = '003_scale_read_models';
const apply = process.argv.includes('--apply');
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;

const statements = [
  `CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS student_report_summaries (
    username TEXT PRIMARY KEY,
    school TEXT NOT NULL,
    student_name TEXT NOT NULL,
    class_name TEXT,
    subjects_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS data_retention_policies (
    scope TEXT PRIMARY KEY,
    source_asset_days INTEGER,
    superseded_asset_days INTEGER,
    report_version_days INTEGER,
    review_audit_days INTEGER,
    enforcement_status TEXT NOT NULL DEFAULT 'disabled',
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK(enforcement_status IN ('disabled', 'dry_run', 'active'))
  )`,
  `CREATE INDEX IF NOT EXISTS file_assets_test_student_kind_status_idx ON file_assets (test_id, test_student_id, kind, status, created_at)`,
  `CREATE INDEX IF NOT EXISTS file_assets_test_status_kind_idx ON file_assets (test_id, status, kind)`,
  `CREATE INDEX IF NOT EXISTS processing_jobs_test_status_requested_idx ON processing_jobs (test_id, status, requested_at DESC)`,
  `CREATE INDEX IF NOT EXISTS processing_jobs_school_requested_idx ON processing_jobs (school, requested_at DESC)`,
  `CREATE INDEX IF NOT EXISTS job_steps_job_status_idx ON job_steps (job_id, status)`,
  `CREATE INDEX IF NOT EXISTS student_reports_school_username_idx ON student_reports (school, username)`,
  `CREATE INDEX IF NOT EXISTS student_report_summaries_school_name_idx ON student_report_summaries (school, class_name, student_name)`,
  `CREATE INDEX IF NOT EXISTS review_image_assets_student_page_subject_idx ON review_image_assets (student_id, page, subject)`,
  // Review queue indexing moved to submission_questions/review_decisions in
  // migration 004+; do not recreate the retired vl_review_queue on new DBs.
];

async function main() {
  if (!apply) return console.log(`${migrationId}: dry run; ${statements.length} statements.`);
  if (!dbUrl || !authToken) throw new Error('Missing Turso configuration.');
  const db = createClient({ url: dbUrl, authToken });
  await db.execute(statements[0]);
  const existing = await db.execute({ sql: 'SELECT id FROM schema_migrations WHERE id = ?', args: [migrationId] });
  if (existing.rows.length) return console.log(`${migrationId}: already applied.`);
  const now = new Date().toISOString();
  const checksum = crypto.createHash('sha256').update(statements.join('\n')).digest('hex');
  await db.batch([
    ...statements.slice(1).map((sql) => ({ sql })),
    { sql: `INSERT INTO data_retention_policies (scope, enforcement_status, updated_by, updated_at)
            VALUES ('default', 'disabled', 'system', ?)
            ON CONFLICT(scope) DO NOTHING`, args: [now] },
    { sql: 'INSERT INTO schema_migrations (id, applied_at, checksum) VALUES (?, ?, ?)', args: [migrationId, now, checksum] },
  ], 'write');
  console.log(`${migrationId}: applied at ${now}.`);
}

main().catch((error) => { console.error(`Migration failed: ${error.message}`); process.exitCode = 1; });
