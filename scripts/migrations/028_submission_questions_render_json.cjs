#!/usr/bin/env node

/* Phase 4b: submission_questions_v2.render_json — the full legacy review
 * payload carried verbatim as render output so the review dashboard reads
 * canonical rows without re-deriving per-student render state. Filter/join
 * fields stay in real columns; the JSON blob is render-only.
 *
 *   node scripts/migrations/028_submission_questions_render_json.cjs --dry-run
 *   node scripts/migrations/028_submission_questions_render_json.cjs --apply
 */
const { getDb, alreadyApplied, markApplied } = require('./_lib.cjs');

const migrationId = '028_submission_questions_render_json';
const apply = process.argv.includes('--apply');

async function main() {
  console.log(`${migrationId}: ${apply ? 'APPLY' : 'DRY RUN'}`);
  const db = getDb();
  if (await alreadyApplied(db, migrationId)) return console.log('Already applied; no changes made.');

  const info = await db.execute('PRAGMA table_info(submission_questions_v2)');
  const hasColumn = info.rows.some((row) => row.name === 'render_json');
  const totals = (await db.execute(`SELECT
      (SELECT COUNT(*) FROM submission_questions_v2) AS v2,
      (SELECT COUNT(*) FROM submission_questions_v2 q
        WHERE NOT EXISTS (SELECT 1 FROM submission_questions legacy WHERE legacy.id = q.id)) AS without_legacy`)).rows[0];
  console.log(`  v2 rows: ${totals.v2}, without legacy source: ${totals.without_legacy}, column present: ${hasColumn}`);
  if (!apply) return;

  const parts = [];
  if (!hasColumn) {
    const sql = 'ALTER TABLE submission_questions_v2 ADD COLUMN render_json TEXT';
    await db.execute(sql);
    parts.push(sql);
  }
  const backfill = `UPDATE submission_questions_v2
    SET render_json = (SELECT payload_json FROM submission_questions WHERE id = submission_questions_v2.id)
    WHERE render_json IS NULL`;
  await db.execute(backfill);
  parts.push(backfill);

  const remaining = Number((await db.execute('SELECT COUNT(*) AS c FROM submission_questions_v2 WHERE render_json IS NULL')).rows[0].c || 0);
  console.log(`  backfill complete; rows still missing render_json: ${remaining}`);
  if (remaining) throw new Error(`render_json backfill incomplete: ${remaining} row(s) without a legacy payload`);

  await markApplied(db, migrationId, parts);
  console.log(`Applied ${migrationId}.`);
}

main().catch((error) => { console.error(`${migrationId} failed: ${error.message}`); process.exitCode = 1; });
