#!/usr/bin/env node

/* 042: Practice tests + submissions for student AI practice MVP.
 *
 *   node scripts/migrations/042_practice_tests.cjs --dry-run
 *   node scripts/migrations/042_practice_tests.cjs --apply
 */
const { getDb, alreadyApplied, markApplied } = require('./_lib.cjs');

const migrationId = '042_practice_tests';
const apply = process.argv.includes('--apply');

const statements = [
  `CREATE TABLE IF NOT EXISTS practice_tests (
    id TEXT PRIMARY KEY,
    student_id TEXT,
    school_id TEXT NOT NULL,
    username TEXT,
    subject TEXT NOT NULL,
    topic_focus_json TEXT NOT NULL DEFAULT '[]',
    questions_json TEXT NOT NULL DEFAULT '[]',
    difficulty_profile_json TEXT NOT NULL DEFAULT '{}',
    total_marks REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'generated',
    generated_by TEXT NOT NULL DEFAULT 'self_request',
    model TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS practice_tests_student_idx ON practice_tests (school_id, student_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS practice_tests_status_idx ON practice_tests (status, created_at DESC)',
  `CREATE TABLE IF NOT EXISTS practice_submissions (
    id TEXT PRIMARY KEY,
    practice_test_id TEXT NOT NULL,
    student_id TEXT,
    school_id TEXT NOT NULL,
    username TEXT,
    answers_json TEXT NOT NULL DEFAULT '[]',
    score REAL,
    max_marks REAL,
    feedback_json TEXT,
    evidence_json TEXT,
    model TEXT,
    status TEXT NOT NULL DEFAULT 'submitted',
    graded_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS practice_submissions_test_idx ON practice_submissions (practice_test_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS practice_submissions_student_idx ON practice_submissions (school_id, student_id, created_at DESC)',
];

async function main() {
  console.log(`${migrationId}: ${apply ? 'APPLY' : 'DRY RUN'}`);
  const db = getDb();
  if (await alreadyApplied(db, migrationId)) return console.log('Already applied; no changes made.');

  for (const sql of statements) {
    console.log(apply ? `APPLY: ${sql.slice(0, 80)}...` : `PLAN: ${sql.slice(0, 80)}...`);
    if (apply) await db.execute(sql);
  }

  if (apply) {
    await markApplied(db, migrationId, statements);
    console.log('Applied and recorded in schema_migrations.');
  } else {
    console.log('Dry run only. Re-run with --apply to execute.');
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
