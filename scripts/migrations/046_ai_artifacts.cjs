#!/usr/bin/env node

/* 046: Persist teacher-generated AI artifacts (lesson plans, quizzes, interventions).
 *
 *   node scripts/migrations/046_ai_artifacts.cjs --dry-run
 *   node scripts/migrations/046_ai_artifacts.cjs --apply
 */
const { getDb, alreadyApplied, markApplied } = require('./_lib.cjs');

const migrationId = '046_ai_artifacts';
const apply = process.argv.includes('--apply');

const statements = [
  `CREATE TABLE IF NOT EXISTS ai_artifacts (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    user_id TEXT,
    artifact_type TEXT NOT NULL,
    scope_json TEXT NOT NULL DEFAULT '{}',
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS ai_artifacts_user_idx ON ai_artifacts (school_id, user_id, created_at DESC)',
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
