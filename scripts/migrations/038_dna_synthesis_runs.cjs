#!/usr/bin/env node

/* 038: DNA synthesis run history for Learning Hive.
 *
 *   node scripts/migrations/038_dna_synthesis_runs.cjs --dry-run
 *   node scripts/migrations/038_dna_synthesis_runs.cjs --apply
 */
const { getDb, alreadyApplied, markApplied } = require('./_lib.cjs');

const migrationId = '038_dna_synthesis_runs';
const apply = process.argv.includes('--apply');

const statements = [
  `CREATE TABLE IF NOT EXISTS dna_synthesis_runs (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    status TEXT NOT NULL,
    trigger_source TEXT,
    input_signal_ids_json TEXT NOT NULL DEFAULT '[]',
    prior_dna_json TEXT,
    result_dna_json TEXT,
    diff_json TEXT,
    model TEXT,
    synthesizer_version TEXT NOT NULL,
    error TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    created_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS dna_synthesis_runs_student_idx ON dna_synthesis_runs (student_id, started_at DESC)',
  'CREATE INDEX IF NOT EXISTS dna_synthesis_runs_school_idx ON dna_synthesis_runs (school_id, started_at DESC)',
  'CREATE INDEX IF NOT EXISTS dna_synthesis_runs_status_idx ON dna_synthesis_runs (status, started_at DESC)',
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
