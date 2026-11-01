#!/usr/bin/env node

/*
 * Versioned, reviewer-triggered cohort regrades.
 *
 * A run snapshots only questions whose review revision is newer than their
 * last regraded revision. The browser drives the run one question at a time;
 * all snapshots and outputs stay durable in Turso so it can be resumed.
 */
const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');

require('dotenv').config({ path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'), quiet: true, override: true });

const migrationId = '009_cohort_regrade_runs';
const apply = process.argv.includes('--apply');
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;
const statements = [
  `CREATE TABLE IF NOT EXISTS cohort_regrade_runs (
    id TEXT PRIMARY KEY,
    school TEXT NOT NULL,
    subject TEXT NOT NULL,
    grade TEXT NOT NULL,
    status TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    question_count INTEGER NOT NULL,
    student_count INTEGER NOT NULL,
    workflow_version TEXT NOT NULL,
    model_version TEXT,
    input_manifest_json TEXT NOT NULL,
    output_manifest_json TEXT,
    error TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS cohort_regrade_items (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    submission_id TEXT NOT NULL,
    submission_question_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    state TEXT NOT NULL,
    input_snapshot_json TEXT NOT NULL,
    output_json TEXT,
    error TEXT,
    started_at TEXT,
    completed_at TEXT,
    UNIQUE(run_id, submission_question_id)
  )`,
  `CREATE TABLE IF NOT EXISTS submission_question_revisions (
    id TEXT PRIMARY KEY,
    submission_question_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    source TEXT NOT NULL,
    actor_user_id TEXT,
    cohort_regrade_run_id TEXT,
    snapshot_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(submission_question_id, revision)
  )`,
  'CREATE INDEX IF NOT EXISTS cohort_regrade_runs_scope_idx ON cohort_regrade_runs (school, subject, grade, requested_at DESC)',
  'CREATE INDEX IF NOT EXISTS cohort_regrade_items_run_state_idx ON cohort_regrade_items (run_id, state)',
  'CREATE INDEX IF NOT EXISTS submission_question_revisions_question_idx ON submission_question_revisions (submission_question_id, revision DESC)',
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
  await db.batch([...statements.map((sql) => ({ sql })), {
    sql: 'INSERT INTO schema_migrations (id, applied_at, checksum) VALUES (?, ?, ?)', args: [migrationId, now, checksum],
  }], 'write');
  console.log(`${migrationId}: applied at ${now}.`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
