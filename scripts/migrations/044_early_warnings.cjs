#!/usr/bin/env node

/* 044: Persist teacher early-warning flags raised after report publish.
 *
 *   node scripts/migrations/044_early_warnings.cjs --dry-run
 *   node scripts/migrations/044_early_warnings.cjs --apply
 */
const { getDb, alreadyApplied, markApplied, now } = require('./_lib.cjs');

const migrationId = '044_early_warnings';
const apply = process.argv.includes('--apply');

const ddl = [
  `CREATE TABLE IF NOT EXISTS early_warnings (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    exam_id TEXT,
    submission_id TEXT,
    username TEXT,
    student_name TEXT,
    severity TEXT NOT NULL DEFAULT 'watch',
    reasons_json TEXT NOT NULL DEFAULT '[]',
    score_pct REAL,
    prior_score_pct REAL,
    zero_count INTEGER,
    question_count INTEGER,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS early_warnings_school_status_idx ON early_warnings (school_id, status, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS early_warnings_exam_idx ON early_warnings (exam_id, status)',
  'CREATE INDEX IF NOT EXISTS early_warnings_student_idx ON early_warnings (student_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS early_warnings_submission_idx ON early_warnings (submission_id)',
];

async function main() {
  console.log(`${migrationId}: ${apply ? 'APPLY' : 'DRY RUN'}`);
  const db = getDb();
  if (await alreadyApplied(db, migrationId)) return console.log('Already applied; no changes made.');

  for (const sql of ddl) {
    console.log(apply ? `APPLY DDL: ${sql.slice(0, 80)}...` : `PLAN DDL: ${sql.slice(0, 80)}...`);
    if (apply) await db.execute(sql);
  }

  if (apply) await markApplied(db, migrationId, ddl);
  console.log(`${migrationId}: ${apply ? 'applied' : 'dry-run complete'} at ${now()}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
