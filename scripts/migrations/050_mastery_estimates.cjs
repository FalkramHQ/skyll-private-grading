#!/usr/bin/env node
/* 050: Per-student per-KC Beta posterior table.
 *   node scripts/migrations/050_mastery_estimates.cjs --dry-run
 *   node scripts/migrations/050_mastery_estimates.cjs --apply
 */
const { getDb, alreadyApplied, markApplied } = require('./_lib.cjs');
const migrationId = '050_mastery_estimates';
const apply = process.argv.includes('--apply');
const statements = [
  `CREATE TABLE IF NOT EXISTS mastery_estimates (
    id TEXT PRIMARY KEY, school_id TEXT NOT NULL, student_id TEXT NOT NULL, kc_id TEXT NOT NULL,
    subject TEXT NOT NULL, alpha REAL NOT NULL, beta REAL NOT NULL,
    theta_mean REAL NOT NULL, ci_low REAL, ci_high REAL, evidence_count INTEGER NOT NULL,
    last_signal_at TEXT, estimator_version TEXT NOT NULL, computed_at TEXT NOT NULL,
    UNIQUE(school_id, student_id, kc_id)
  )`,
  'CREATE INDEX IF NOT EXISTS mastery_student_idx ON mastery_estimates (school_id, student_id, subject)',
  'CREATE INDEX IF NOT EXISTS mastery_kc_idx ON mastery_estimates (kc_id)',
];
async function main() {
  console.log(`${migrationId}: ${apply ? 'APPLY' : 'DRY RUN'}`);
  const db = getDb();
  if (await alreadyApplied(db, migrationId)) return console.log('Already applied; no changes made.');
  for (const sql of statements) {
    console.log(apply ? `APPLY: ${sql.slice(0, 80)}...` : `PLAN: ${sql.slice(0, 80)}...`);
    if (apply) await db.execute(sql);
  }
  if (apply) { await markApplied(db, migrationId, statements); console.log('Applied and recorded in schema_migrations.'); }
  else console.log('Dry run only. Re-run with --apply to execute.');
}
main().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
