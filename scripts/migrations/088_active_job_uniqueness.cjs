#!/usr/bin/env node

// At most one active (queued/running) job per test for the test-level intake
// stages, and one active cohort regrade per test. The API checks for an active
// row before inserting, but two clicks can both pass that check; these partial
// unique indexes make the second insert fail so the API reuses the first.
//
// processing_jobs: only the singleton stages queued by server/intake/jobs.js.
//   Per-question and per-student types (grade_submission, visual_rescue,
//   targeted materialize_evidence retries, ...) legitimately fan out.
// regrade_runs:    the test lives in the scope JSON (scope.test_id); legacy
//   runs without one index as NULL, which never conflicts.
//
// Additive + idempotent. --dry-run (default) reports existing active
// duplicates, which would make CREATE UNIQUE INDEX fail; --apply refuses to
// run while any exist.
//
//   node scripts/migrations/088_active_job_uniqueness.cjs --dry-run
//   node scripts/migrations/088_active_job_uniqueness.cjs --apply
const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');

try {
  require('dotenv').config({ path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'), quiet: true, override: true });
} catch {
  // OCI supplies the protected environment through systemd.
}

const migrationId = '088_active_job_uniqueness';
const apply = process.argv.includes('--apply');
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;

const SINGLETON_JOB_TYPES = "('mistral_ocr', 'build_rubric', 'process_test')";

const statements = [
  `CREATE UNIQUE INDEX IF NOT EXISTS processing_jobs_one_active_stage_idx
    ON processing_jobs (test_id, type)
    WHERE status IN ('queued', 'running') AND type IN ${SINGLETON_JOB_TYPES}`,
  `CREATE UNIQUE INDEX IF NOT EXISTS regrade_runs_one_active_test_idx
    ON regrade_runs (json_extract(scope, '$.test_id'))
    WHERE status IN ('queued', 'running')`,
];

// Each returns the rows that would block the index above.
const preflightChecks = [
  {
    label: 'processing_jobs with more than one active job per test and singleton type',
    sql: `SELECT test_id, type, COUNT(*) AS active, GROUP_CONCAT(id) AS ids
          FROM processing_jobs
          WHERE status IN ('queued', 'running') AND type IN ${SINGLETON_JOB_TYPES}
          GROUP BY test_id, type HAVING COUNT(*) > 1`,
  },
  {
    label: 'active regrade_runs whose scope is not valid JSON',
    sql: `SELECT id, scope FROM regrade_runs
          WHERE status IN ('queued', 'running') AND json_valid(scope) = 0`,
  },
  {
    label: 'regrade_runs with more than one active run per test',
    sql: `SELECT json_extract(scope, '$.test_id') AS test_id, COUNT(*) AS active, GROUP_CONCAT(id) AS ids
          FROM regrade_runs
          WHERE status IN ('queued', 'running') AND json_valid(scope) = 1
            AND json_extract(scope, '$.test_id') IS NOT NULL
          GROUP BY json_extract(scope, '$.test_id') HAVING COUNT(*) > 1`,
  },
];

async function findBlockers(db) {
  const blockers = [];
  for (const check of preflightChecks) {
    const result = await db.execute(check.sql);
    if (result.rows.length) blockers.push({ label: check.label, rows: result.rows });
  }
  return blockers;
}

async function main() {
  console.log(`${migrationId}: ${apply ? 'APPLY' : 'DRY RUN'}`);
  if (!dbUrl || !authToken) {
    if (!apply) return console.log(`${statements.length} statements; no database configured for the duplicate preflight.`);
    throw new Error('Missing Turso configuration.');
  }
  const db = createClient({ url: dbUrl, authToken });
  await db.execute('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)');
  const existing = await db.execute({ sql: 'SELECT 1 FROM schema_migrations WHERE id = ?', args: [migrationId] });
  if (existing.rows.length) return console.log(`${migrationId}: already applied.`);
  const blockers = await findBlockers(db);
  for (const blocker of blockers) {
    console.log(`  BLOCKER: ${blocker.label}`);
    for (const row of blocker.rows) console.log(`    ${JSON.stringify(row)}`);
  }
  if (!apply) return console.log(blockers.length ? 'Resolve the blockers above before --apply.' : `No blockers; ${statements.length} statements ready.`);
  if (blockers.length) throw new Error('Active duplicates would violate the new unique indexes; resolve them first.');
  const now = new Date().toISOString();
  const checksum = crypto.createHash('sha256').update(statements.join('\n')).digest('hex');
  await db.batch([
    ...statements.map((sql) => ({ sql })),
    { sql: 'INSERT INTO schema_migrations (id, applied_at, checksum) VALUES (?, ?, ?)', args: [migrationId, now, checksum] },
  ], 'write');
  console.log(`${migrationId}: applied ${statements.length} statement(s) at ${now}.`);
}

module.exports = { migrationId, statements, preflightChecks, findBlockers };

if (require.main === module) {
  main().catch((error) => { console.error(`${migrationId} failed: ${error.message}`); process.exitCode = 1; });
}
