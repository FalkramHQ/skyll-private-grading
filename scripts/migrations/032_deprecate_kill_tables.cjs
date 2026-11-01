#!/usr/bin/env node

/* Phase 7: Cleanup — rename KILL tables to _deprecated_* (read-only for 2 weeks).
 *   Only renames tables with zero active runtime references.
 *   Deferred (still referenced): login_rate_limits, vl_cohort_status,
 *   exam_note_collections, exam_note_sources.
 *
 *   node scripts/migrations/032_deprecate_kill_tables.cjs --dry-run
 *   node scripts/migrations/032_deprecate_kill_tables.cjs --apply
 */
const { getDb, now, alreadyApplied, markApplied } = require('./_lib.cjs');

const migrationId = '032_deprecate_kill_tables';
const apply = process.argv.includes('--apply');

const KILL_TABLES = [
  'app_users',
  'app_login_aliases',
  'app_sessions',
  'student_reports',
  'student_report_summaries',
  'teacher_reports',
  'teacher_report_versions',
  'job_steps',
  'regrade_jobs',
  'cohort_regrade_runs',
  'cohort_regrade_items',
  'recall_cards',
  'recall_users',
  'recall_progress',
  'legacy_assessment_archives',
  'question_review_state',
];

async function main() {
  console.log(`${migrationId}: ${apply ? 'APPLY' : 'DRY RUN'}`);
  const db = getDb();
  if (await alreadyApplied(db, migrationId)) return console.log('Already applied; no changes made.');
  const parts = [];

  // Check which tables exist
  const existing = new Set((await db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")).rows.map((r) => r.name));
  let renamed = 0;
  for (const table of KILL_TABLES) {
    const deprecatedName = `_deprecated_${table}`;
    if (!existing.has(table)) {
      console.log(`  SKIP ${table} (does not exist)`);
      continue;
    }
    if (existing.has(deprecatedName)) {
      console.log(`  SKIP ${table} (_deprecated_ already exists)`);
      continue;
    }
    const count = (await db.execute(`SELECT COUNT(*) AS c FROM ${table}`)).rows[0].c;
    console.log(`  RENAME ${table} (${count} rows) → ${deprecatedName}`);
    if (apply) {
      await db.execute(`ALTER TABLE ${table} RENAME TO ${deprecatedName}`);
    }
    parts.push(`${table} → ${deprecatedName} (${count} rows)`);
    renamed += 1;
  }
  console.log(`  Total: ${renamed} table(s) renamed`);

  // VACUUM to reclaim space (not supported on Turso remote — skip gracefully)
  if (apply) {
    try {
      console.log('  VACUUM...');
      await db.execute('VACUUM');
      parts.push('VACUUM');
    } catch {
      console.log('  VACUUM skipped (not supported on Turso remote)');
    }
  }

  if (!apply) return;
  await markApplied(db, migrationId, parts);
  console.log(`Applied ${migrationId}.`);
}

main().catch((error) => { console.error(`${migrationId} failed: ${error.message}`); process.exitCode = 1; });
