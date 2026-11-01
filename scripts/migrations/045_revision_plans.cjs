#!/usr/bin/env node

/* 045: Persist generated student revision plans.
 *
 *   node scripts/migrations/045_revision_plans.cjs --dry-run
 *   node scripts/migrations/045_revision_plans.cjs --apply
 */
const { getDb, alreadyApplied, markApplied } = require('./_lib.cjs');

const migrationId = '045_revision_plans';
const apply = process.argv.includes('--apply');

const statements = [
  `CREATE TABLE IF NOT EXISTS revision_plans (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    student_id TEXT,
    username TEXT,
    subject TEXT NOT NULL DEFAULT 'Mathematics',
    plan_json TEXT NOT NULL,
    source TEXT,
    created_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS revision_plans_student_idx ON revision_plans (school_id, username, created_at DESC)',
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
