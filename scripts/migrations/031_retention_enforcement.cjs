#!/usr/bin/env node

/* Phase 6: retention enforcement — activate policy + archive old data.
 *   - Completed/failed processing_jobs older than 30 days → export to cold storage, delete.
 *   - job_steps for those jobs → export alongside, delete.
 *   - Superseded report_versions older than 30 days → export, delete.
 *   - question_review_events older than 180 days → export, delete.
 *   - Set enforcement_status = 'active'.
 *
 *   node scripts/migrations/031_retention_enforcement.cjs --dry-run
 *   node scripts/migrations/031_retention_enforcement.cjs --apply
 */
const fs = require('node:fs');
const path = require('node:path');
const { getDb, now, alreadyApplied, markApplied } = require('./_lib.cjs');

const migrationId = '031_retention_enforcement';
const apply = process.argv.includes('--apply');
const coldDir = path.resolve(__dirname, '../../execution/cold_storage');

async function main() {
  console.log(`${migrationId}: ${apply ? 'APPLY' : 'DRY RUN'}`);
  const db = getDb();
  if (await alreadyApplied(db, migrationId)) return console.log('Already applied; no changes made.');
  const at = now();
  const parts = [];
  const cutoff30 = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const cutoff180 = new Date(Date.now() - 180 * 24 * 3600 * 1000).toISOString();

  if (apply) fs.mkdirSync(coldDir, { recursive: true });
  const ts = at.replace(/[:.]/g, '-');

  // A. Archive old processing_jobs + their job_steps
  const oldJobs = (await db.execute({ sql: "SELECT * FROM processing_jobs WHERE status IN ('succeeded', 'failed', 'failed_retryable', 'failed_blocked', 'cancelled') AND COALESCE(completed_at, requested_at) < ?", args: [cutoff30] })).rows;
  const oldJobIds = oldJobs.map((j) => j.id);
  let oldSteps = [];
  if (oldJobIds.length) {
    const batchSize = 500;
    for (let i = 0; i < oldJobIds.length; i += batchSize) {
      const batch = oldJobIds.slice(i, i + batchSize);
      const result = await db.execute({ sql: `SELECT * FROM job_steps WHERE job_id IN (${batch.map(() => '?').join(', ')})`, args: batch });
      oldSteps = oldSteps.concat(result.rows);
    }
  }
  console.log(`  A. Old jobs (>30d): ${oldJobs.length}; their job_steps: ${oldSteps.length}`);
  if (apply && oldJobs.length) {
    fs.writeFileSync(path.join(coldDir, `processing_jobs_archive_${ts}.json`), JSON.stringify(oldJobs));
    if (oldSteps.length) fs.writeFileSync(path.join(coldDir, `job_steps_archive_${ts}.json`), JSON.stringify(oldSteps));
    // Delete in batches to avoid SQL variable limits
    const batchSize = 500;
    for (let i = 0; i < oldJobIds.length; i += batchSize) {
      const batch = oldJobIds.slice(i, i + batchSize);
      const ph = batch.map(() => '?').join(', ');
      await db.execute({ sql: `DELETE FROM job_steps WHERE job_id IN (${ph})`, args: batch });
      await db.execute({ sql: `DELETE FROM processing_jobs WHERE id IN (${ph})`, args: batch });
    }
  }
  parts.push(`archived ${oldJobs.length} jobs + ${oldSteps.length} steps`);

  // B. Archive superseded report_versions older than 30 days
  const oldReports = (await db.execute({ sql: "SELECT * FROM report_versions WHERE status = 'superseded' AND COALESCE(superseded_at, generated_at) < ?", args: [cutoff30] })).rows;
  console.log(`  B. Superseded report_versions (>30d): ${oldReports.length}`);
  if (apply && oldReports.length) {
    fs.writeFileSync(path.join(coldDir, `report_versions_archive_${ts}.json`), JSON.stringify(oldReports));
    const batchSize = 500;
    for (let i = 0; i < oldReports.length; i += batchSize) {
      const batch = oldReports.slice(i, i + batchSize).map((r) => r.id);
      await db.execute({ sql: `DELETE FROM report_versions WHERE id IN (${batch.map(() => '?').join(', ')})`, args: batch });
    }
  }
  parts.push(`archived ${oldReports.length} superseded report_versions`);

  // C. Archive question_review_events older than 180 days
  const oldEvents = (await db.execute({ sql: 'SELECT * FROM question_review_events WHERE created_at < ?', args: [cutoff180] })).rows;
  console.log(`  C. question_review_events (>180d): ${oldEvents.length}`);
  if (apply && oldEvents.length) {
    fs.writeFileSync(path.join(coldDir, `question_review_events_archive_${ts}.json`), JSON.stringify(oldEvents));
    const batchSize = 500;
    for (let i = 0; i < oldEvents.length; i += batchSize) {
      const batch = oldEvents.slice(i, i + batchSize).map((r) => r.id);
      await db.execute({ sql: `DELETE FROM question_review_events WHERE id IN (${batch.map(() => '?').join(', ')})`, args: batch });
    }
  }
  parts.push(`archived ${oldEvents.length} review events`);

  // D. Activate enforcement
  if (apply) {
    await db.execute({ sql: "UPDATE data_retention_policies SET enforcement_status = 'active', updated_by = 'phase6_enforcement', updated_at = ? WHERE scope = 'default'", args: [at] });
  }
  parts.push('enforcement_status = active');
  console.log('  D. enforcement_status → active');

  if (!apply) return;
  await markApplied(db, migrationId, parts);
  console.log(`Applied ${migrationId}.`);
}

main().catch((error) => { console.error(`${migrationId} failed: ${error.message}`); process.exitCode = 1; });
