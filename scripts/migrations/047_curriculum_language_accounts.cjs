#!/usr/bin/env node

/* 047: Seed ICSE English/Hindi 10 + Accounts foundations for PartnerD/PartnerC mapping.
 *
 *   node scripts/migrations/047_curriculum_language_accounts.cjs --dry-run
 *   node scripts/migrations/047_curriculum_language_accounts.cjs --apply
 */
const { getDb, alreadyApplied, markApplied, now } = require('./_lib.cjs');
const { LANGUAGE_ACCOUNTS_CURRICULUM_SEED } = require('./data/curriculumLanguageAccounts.cjs');

const migrationId = '047_curriculum_language_accounts';
const apply = process.argv.includes('--apply');

async function main() {
  console.log(`${migrationId}: ${apply ? 'APPLY' : 'DRY RUN'}`);
  const db = getDb();
  if (await alreadyApplied(db, migrationId)) return console.log('Already applied; no changes made.');

  const ts = now();
  const statements = LANGUAGE_ACCOUNTS_CURRICULUM_SEED.map((row) => ({
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
  }));

  console.log(`${apply ? 'APPLY' : 'PLAN'}: ${statements.length} curriculum_standards upsert(s)`);
  if (apply) {
    for (let i = 0; i < statements.length; i += 40) {
      await db.batch(statements.slice(i, i + 40), 'write');
    }
    await markApplied(db, migrationId, [`seed:${statements.length}`]);
  }
  console.log(`${migrationId}: ${apply ? 'applied' : 'dry-run complete'} at ${ts}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
