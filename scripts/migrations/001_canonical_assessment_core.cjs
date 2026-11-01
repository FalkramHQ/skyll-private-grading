#!/usr/bin/env node

/*
 * Additive canonical assessment schema migration.
 *
 * This creates new tables only. It never mutates legacy queue/report rows and
 * can therefore be applied safely before the projector and dual-write paths.
 *
 * Usage:
 *   node scripts/migrations/001_canonical_assessment_core.cjs --dry-run
 *   node scripts/migrations/001_canonical_assessment_core.cjs --apply
 */

const path = require('node:path');
const { createClient } = require('@libsql/client');

require('dotenv').config({
  path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'),
  quiet: true,
  override: true,
});

const apply = process.argv.includes('--apply');
const migrationId = '001_canonical_assessment_core';
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;

const statements = [
  `CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL,
    checksum TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS workflow_runs (
    id TEXT PRIMARY KEY,
    test_id TEXT NOT NULL,
    submission_id TEXT,
    scope TEXT NOT NULL,
    status TEXT NOT NULL,
    workflow_version TEXT NOT NULL,
    rubric_version TEXT,
    model_version TEXT,
    input_manifest_json TEXT NOT NULL,
    output_manifest_json TEXT,
    requested_by TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    worker_id TEXT,
    error TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS test_submissions (
    id TEXT PRIMARY KEY,
    test_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    batch_id TEXT,
    status TEXT NOT NULL,
    active_asset_revision INTEGER NOT NULL DEFAULT 1,
    current_workflow_run_id TEXT,
    score REAL,
    max_marks REAL,
    review_status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(test_id, student_id)
  )`,
  `CREATE TABLE IF NOT EXISTS submission_questions (
    id TEXT PRIMARY KEY,
    submission_id TEXT NOT NULL,
    question_id TEXT NOT NULL,
    question_number TEXT NOT NULL,
    question_text TEXT,
    answer_key_text TEXT,
    rubric_json TEXT,
    evidence_json TEXT NOT NULL,
    source_asset_ids_json TEXT NOT NULL,
    ai_marks REAL,
    approved_marks REAL,
    marks_total REAL,
    status TEXT NOT NULL,
    review_revision INTEGER NOT NULL DEFAULT 0,
    regraded_revision INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(submission_id, question_id)
  )`,
  `CREATE TABLE IF NOT EXISTS review_decisions (
    submission_question_id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    corrected_answer TEXT,
    approved_marks REAL,
    reviewer_id TEXT,
    reason TEXT,
    revision INTEGER NOT NULL DEFAULT 0,
    approved_at TEXT,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS recheck_requests (
    id TEXT PRIMARY KEY,
    submission_question_id TEXT NOT NULL,
    submission_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    requested_by TEXT,
    requested_by_role TEXT,
    status TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    taken_by TEXT,
    taken_at TEXT,
    resolved_by TEXT,
    resolved_at TEXT,
    resolution_note TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS report_versions (
    id TEXT PRIMARY KEY,
    submission_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    status TEXT NOT NULL,
    workflow_run_id TEXT,
    generated_at TEXT NOT NULL,
    published_at TEXT,
    superseded_at TEXT,
    payload_json TEXT NOT NULL,
    UNIQUE(submission_id, version)
  )`,
  `CREATE TABLE IF NOT EXISTS report_modules (
    id TEXT PRIMARY KEY,
    report_version_id TEXT NOT NULL,
    submission_question_id TEXT,
    module_type TEXT NOT NULL,
    source_revision INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS workflow_runs_test_idx ON workflow_runs (test_id, requested_at DESC)',
  'CREATE INDEX IF NOT EXISTS test_submissions_test_idx ON test_submissions (test_id, status)',
  'CREATE INDEX IF NOT EXISTS submission_questions_submission_idx ON submission_questions (submission_id, question_number)',
  'CREATE INDEX IF NOT EXISTS recheck_requests_question_idx ON recheck_requests (submission_question_id, status)',
  'CREATE INDEX IF NOT EXISTS report_versions_submission_idx ON report_versions (submission_id, version DESC)',
];

async function main() {
  console.log(`${migrationId}: ${apply ? 'APPLY' : 'DRY RUN'}`);
  console.log(`Statements: ${statements.length}`);
  if (!apply) {
    console.log('No database changes made. Pass --apply after a backup and production preflight.');
    return;
  }
  if (!dbUrl || !authToken) throw new Error('Missing Turso configuration. Set TURSO_DATABASE_URL/TURSO_AUTH_TOKEN (or the legacy VITE_DB_URL/VITE_DB_TOKEN).');
  const db = createClient({ url: dbUrl, authToken });
  // The migration ledger is itself created by this migration, so it must exist
  // before the idempotency check below can run on a fresh database.
  await db.execute(statements[0]);
  const existing = await db.execute({ sql: 'SELECT id FROM schema_migrations WHERE id = ?', args: [migrationId] });
  if (existing.rows.length) {
    console.log('Already applied; no changes made.');
    return;
  }
  const appliedAt = new Date().toISOString();
  const checksum = require('node:crypto').createHash('sha256').update(statements.join('\n')).digest('hex');
  await db.batch([
    ...statements.slice(1).map((sql) => ({ sql })),
    { sql: 'INSERT INTO schema_migrations (id, applied_at, checksum) VALUES (?, ?, ?)', args: [migrationId, appliedAt, checksum] },
  ], 'write');
  console.log(`Applied ${migrationId} at ${appliedAt}.`);
}

main().catch((error) => { console.error(`Migration failed: ${error.message}`); process.exitCode = 1; });
