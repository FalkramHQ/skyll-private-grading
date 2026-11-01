#!/usr/bin/env node

/* 040: Question bank for practice / quiz generation (embedding nullable for later).
 *
 *   node scripts/migrations/040_question_bank.cjs --dry-run
 *   node scripts/migrations/040_question_bank.cjs --apply
 */
const { getDb, alreadyApplied, markApplied } = require('./_lib.cjs');

const migrationId = '040_question_bank';
const apply = process.argv.includes('--apply');

const statements = [
  `CREATE TABLE IF NOT EXISTS question_bank (
    id TEXT PRIMARY KEY,
    board TEXT,
    grade TEXT,
    subject TEXT NOT NULL,
    topic TEXT,
    curriculum_standard_id TEXT,
    difficulty TEXT,
    question_type TEXT,
    question_text TEXT NOT NULL,
    answer_key TEXT,
    rubric_json TEXT,
    max_marks REAL,
    source TEXT NOT NULL DEFAULT 'ai_generated',
    source_exam_id TEXT,
    source_exam_set_question_id TEXT,
    quality_score REAL,
    embedding BLOB,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS question_bank_filters_idx ON question_bank (board, grade, subject, topic, difficulty)',
  'CREATE INDEX IF NOT EXISTS question_bank_standard_idx ON question_bank (curriculum_standard_id, status)',
  'CREATE INDEX IF NOT EXISTS question_bank_source_exam_idx ON question_bank (source_exam_id)',
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
