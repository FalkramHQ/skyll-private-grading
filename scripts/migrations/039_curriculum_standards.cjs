#!/usr/bin/env node

/* 039: Curriculum standards taxonomy + question↔topic link table.
 * Seeds ICSE/CBSE Mathematics for grades 8–10.
 *
 *   node scripts/migrations/039_curriculum_standards.cjs --dry-run
 *   node scripts/migrations/039_curriculum_standards.cjs --apply
 */
const { getDb, alreadyApplied, markApplied, now } = require('./_lib.cjs');
const { MATHS_CURRICULUM_SEED } = require('./data/curriculumMaths.cjs');

const migrationId = '039_curriculum_standards';
const apply = process.argv.includes('--apply');

const ddl = [
  `CREATE TABLE IF NOT EXISTS curriculum_standards (
    id TEXT PRIMARY KEY,
    board TEXT NOT NULL,
    grade TEXT NOT NULL,
    subject TEXT NOT NULL,
    topic TEXT NOT NULL,
    sub_topics_json TEXT NOT NULL DEFAULT '[]',
    difficulty_weight REAL,
    created_at TEXT NOT NULL,
    UNIQUE(board, grade, subject, topic)
  )`,
  'CREATE INDEX IF NOT EXISTS curriculum_standards_board_grade_idx ON curriculum_standards (board, grade, subject)',
  'CREATE INDEX IF NOT EXISTS curriculum_standards_topic_idx ON curriculum_standards (subject, topic)',
  `CREATE TABLE IF NOT EXISTS exam_question_curriculum_links (
    id TEXT PRIMARY KEY,
    exam_set_question_id TEXT NOT NULL UNIQUE,
    curriculum_standard_id TEXT NOT NULL,
    source_topic TEXT,
    confidence REAL,
    source TEXT NOT NULL DEFAULT 'heuristic',
    status TEXT NOT NULL DEFAULT 'proposed',
    reviewed_by TEXT,
    reviewed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS exam_question_curriculum_links_standard_idx ON exam_question_curriculum_links (curriculum_standard_id, status)',
  'CREATE INDEX IF NOT EXISTS exam_question_curriculum_links_status_idx ON exam_question_curriculum_links (status, created_at DESC)',
];

async function main() {
  console.log(`${migrationId}: ${apply ? 'APPLY' : 'DRY RUN'}`);
  const db = getDb();
  if (await alreadyApplied(db, migrationId)) return console.log('Already applied; no changes made.');

  const ts = now();
  for (const sql of ddl) {
    console.log(apply ? `APPLY DDL: ${sql.slice(0, 72)}...` : `PLAN DDL: ${sql.slice(0, 72)}...`);
    if (apply) await db.execute(sql);
  }

  let insertCount = 0;
  const statements = [];
  for (const row of MATHS_CURRICULUM_SEED) {
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

  if (apply) {
    const chunk = 40;
    for (let i = 0; i < statements.length; i += chunk) {
      await db.batch(statements.slice(i, i + chunk), 'write');
    }
    await markApplied(db, migrationId, [...ddl, `seed:${insertCount}`]);
    console.log('Applied and recorded in schema_migrations.');
  } else {
    console.log('Dry run only. Re-run with --apply to execute.');
    console.log('Sample ids:', MATHS_CURRICULUM_SEED.slice(0, 3).map((row) => row.id).join(', '));
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
