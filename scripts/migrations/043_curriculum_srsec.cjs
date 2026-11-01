#!/usr/bin/env node

/* 043: Seed CBSE Class 11–12 Physics / Chemistry / Mathematics / Biology.
 * Catalogue from CBSE Academic Curriculum 2025–26 SrSec PDFs.
 *
 *   node scripts/migrations/043_curriculum_srsec.cjs --dry-run
 *   node scripts/migrations/043_curriculum_srsec.cjs --apply
 */
const { getDb, alreadyApplied, markApplied, now } = require('./_lib.cjs');
const { SRSEC_CURRICULUM_SEED } = require('./data/curriculumSrSec.cjs');

const migrationId = '043_curriculum_srsec';
const apply = process.argv.includes('--apply');

async function main() {
  console.log(`${migrationId}: ${apply ? 'APPLY' : 'DRY RUN'}`);
  const db = getDb();
  if (await alreadyApplied(db, migrationId)) return console.log('Already applied; no changes made.');

  const ts = now();
  let insertCount = 0;
  const statements = [];
  for (const row of SRSEC_CURRICULUM_SEED) {
    insertCount += 1;
    statements.push({
      sql: `INSERT INTO curriculum_standards (
              id, board, grade, subject, topic, sub_topics_json, difficulty_weight, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              topic = excluded.topic,
              sub_topics_json = excluded.sub_topics_json,
              difficulty_weight = excluded.difficulty_weight`,
      args: [
        row.id,
        row.board,
        row.grade,
        row.subject,
        row.topic,
        JSON.stringify(row.subTopics || []),
        row.difficultyWeight ?? null,
        ts,
      ],
    });
  }

  console.log(apply
    ? `APPLY: upsert ${insertCount} curriculum standard(s)`
    : `PLAN: upsert ${insertCount} curriculum standard(s)`);

  const bySubject = {};
  for (const row of SRSEC_CURRICULUM_SEED) {
    const key = `${row.grade} ${row.subject}`;
    bySubject[key] = (bySubject[key] || 0) + 1;
  }
  console.log('Breakdown:', bySubject);
  console.log('Sample ids:', SRSEC_CURRICULUM_SEED.slice(0, 4).map((row) => row.id).join(', '));

  if (apply) {
    const chunk = 40;
    for (let i = 0; i < statements.length; i += chunk) {
      await db.batch(statements.slice(i, i + chunk), 'write');
    }
    await markApplied(db, migrationId, [`seed:${insertCount}`]);
    console.log('Applied and recorded in schema_migrations.');
  } else {
    console.log('Dry run only. Re-run with --apply to execute.');
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
