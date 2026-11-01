#!/usr/bin/env node

/* Phase 6: regrade/recheck unification + retention policy activation.
 *   A. Merge cohort_regrade_runs/items + regrade_jobs into regrade_runs/regrade_items
 *      keyed by exam_id (via test_id -> exams.source_test_id).
 *   B. Set data_retention_policies values + enforcement_status = 'dry_run'.
 *
 *   node scripts/migrations/030_regrade_unification_retention.cjs --dry-run
 *   node scripts/migrations/030_regrade_unification_retention.cjs --apply
 */
const { getDb, now, alreadyApplied, markApplied, loadSchoolResolver } = require('./_lib.cjs');

const migrationId = '030_regrade_unification_retention';
const apply = process.argv.includes('--apply');

async function main() {
  console.log(`${migrationId}: ${apply ? 'APPLY' : 'DRY RUN'}`);
  const db = getDb();
  if (await alreadyApplied(db, migrationId)) return console.log('Already applied; no changes made.');
  const at = now();
  const parts = [];
  const resolver = await loadSchoolResolver(db);

  // A. Merge cohort_regrade_runs -> regrade_runs
  const runs = (await db.execute('SELECT * FROM cohort_regrade_runs')).rows;
  let runsMigrated = 0;
  for (const run of runs) {
    const examRow = (await db.execute({ sql: 'SELECT id FROM exams WHERE source_test_id = ? LIMIT 1', args: [run.test_id] })).rows[0];
    const schoolId = resolver.resolve(run.school);
    const scope = JSON.stringify({ school: run.school, subject: run.subject, grade: run.grade, test_id: run.test_id });
    const upsert = `INSERT INTO regrade_runs (id, exam_id, school_id, scope, status, requested_by, requested_at, started_at, completed_at,
        worker_id, heartbeat_at, attempt_count, question_count, student_count, workflow_version, model_version,
        input_manifest_json, output_manifest_json, result_json, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?, ?, NULL, ?, ?, NULL, ?)
      ON CONFLICT(id) DO NOTHING`;
    if (apply) {
      await db.execute({ sql: upsert, args: [run.id, examRow?.id || null, schoolId, scope, run.status, run.requested_by,
        run.requested_at, run.started_at, run.completed_at, run.question_count, run.student_count,
        run.workflow_version, run.input_manifest_json, run.output_manifest_json, run.error] });
    }
    runsMigrated += 1;
  }
  parts.push(`cohort_regrade_runs -> regrade_runs (${runsMigrated})`);
  console.log(`  A1. cohort_regrade_runs migrated: ${runsMigrated}/${runs.length}`);

  // A2. Merge regrade_jobs -> regrade_runs (legacy single-row table)
  const jobs = (await db.execute('SELECT * FROM regrade_jobs')).rows;
  let jobsMigrated = 0;
  for (const job of jobs) {
    const schoolId = resolver.resolve(job.school);
    const scope = JSON.stringify({ school: job.school, subject: job.subject, grade: job.grade, active_key: job.active_key });
    const upsert = `INSERT INTO regrade_runs (id, exam_id, school_id, scope, status, requested_by, requested_at, started_at, completed_at,
        worker_id, heartbeat_at, attempt_count, question_count, student_count, workflow_version, model_version,
        input_manifest_json, output_manifest_json, result_json, error)
      VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 0, 0, NULL, NULL, NULL, NULL, ?, ?)
      ON CONFLICT(id) DO NOTHING`;
    if (apply) {
      await db.execute({ sql: upsert, args: [job.id, schoolId, scope, job.status, job.requested_by,
        job.requested_at, job.started_at, job.completed_at, job.worker_id, job.result_json, job.error] });
    }
    jobsMigrated += 1;
  }
  parts.push(`regrade_jobs -> regrade_runs (${jobsMigrated})`);
  console.log(`  A2. regrade_jobs migrated: ${jobsMigrated}/${jobs.length}`);

  // A3. Merge cohort_regrade_items -> regrade_items
  const items = (await db.execute('SELECT * FROM cohort_regrade_items')).rows;
  let itemsMigrated = 0;
  for (const item of items) {
    const upsert = `INSERT INTO regrade_items (id, run_id, submission_id, submission_question_id, revision, state,
        input_snapshot_json, output_json, error, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING`;
    if (apply) {
      await db.execute({ sql: upsert, args: [item.id, item.run_id, item.submission_id, item.submission_question_id,
        item.revision, item.state, item.input_snapshot_json, item.output_json, item.error, item.started_at, item.completed_at] });
    }
    itemsMigrated += 1;
  }
  parts.push(`cohort_regrade_items -> regrade_items (${itemsMigrated})`);
  console.log(`  A3. cohort_regrade_items migrated: ${itemsMigrated}/${items.length}`);

  // B. Retention policy: set values + dry_run
  const retentionUpdate = `UPDATE data_retention_policies SET
    report_version_days = 30, review_audit_days = 180,
    enforcement_status = 'dry_run', updated_by = 'phase6_migration', updated_at = ?
    WHERE scope = 'default'`;
  if (apply) await db.execute({ sql: retentionUpdate, args: [at] });
  parts.push('retention policy: report_version_days=30, review_audit_days=180, enforcement_status=dry_run');
  console.log('  B. Retention policy set to dry_run (report_version_days=30, review_audit_days=180)');

  if (!apply) return;
  await markApplied(db, migrationId, parts);
  console.log(`Applied ${migrationId}.`);
}

main().catch((error) => { console.error(`${migrationId} failed: ${error.message}`); process.exitCode = 1; });
