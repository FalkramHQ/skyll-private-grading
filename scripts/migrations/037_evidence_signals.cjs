#!/usr/bin/env node

/* 037: Evidence signals table for Learning Hive deep-signal extraction.
 *
 *   node scripts/migrations/037_evidence_signals.cjs --dry-run
 *   node scripts/migrations/037_evidence_signals.cjs --apply
 */
const { getDb, alreadyApplied, markApplied } = require('./_lib.cjs');

const migrationId = '037_evidence_signals';
const apply = process.argv.includes('--apply');

const statements = [
  `CREATE TABLE IF NOT EXISTS evidence_signals (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    submission_id TEXT NOT NULL,
    submission_question_id TEXT NOT NULL,
    exam_id TEXT,
    question_number TEXT NOT NULL,
    topic TEXT,
    marks_obtained REAL,
    marks_total REAL,
    concept_tags_json TEXT NOT NULL DEFAULT '[]',
    misconception TEXT,
    strength TEXT,
    method_note TEXT,
    next_practice TEXT,
    confidence REAL,
    evidence_refs_json TEXT NOT NULL DEFAULT '[]',
    raw_json TEXT NOT NULL DEFAULT '{}',
    model TEXT,
    extractor_version TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    extracted_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(submission_question_id)
  )`,
  'CREATE INDEX IF NOT EXISTS evidence_signals_school_student_idx ON evidence_signals (school_id, student_id, extracted_at DESC)',
  'CREATE INDEX IF NOT EXISTS evidence_signals_submission_idx ON evidence_signals (submission_id, status)',
  'CREATE INDEX IF NOT EXISTS evidence_signals_exam_idx ON evidence_signals (exam_id, status)',
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
