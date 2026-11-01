#!/usr/bin/env node
/* 048: Knowledge-component ontology beneath curriculum_standards + prerequisite edges.
 *   node scripts/migrations/048_knowledge_components.cjs --dry-run
 *   node scripts/migrations/048_knowledge_components.cjs --apply
 */
const { getDb, alreadyApplied, markApplied, now } = require('./_lib.cjs');
const { kcs, prerequisites } = require('./data/kcMathsSeed.cjs');

const migrationId = '048_knowledge_components';
const apply = process.argv.includes('--apply');

const ddl = [
  `CREATE TABLE IF NOT EXISTS knowledge_components (
    id TEXT PRIMARY KEY,
    curriculum_standard_id TEXT NOT NULL,
    board TEXT NOT NULL, grade TEXT NOT NULL, subject TEXT NOT NULL,
    kc_label TEXT NOT NULL, kc_slug TEXT NOT NULL,
    cognitive_level TEXT,
    difficulty_prior REAL,
    source TEXT NOT NULL DEFAULT 'curated',
    created_at TEXT NOT NULL,
    UNIQUE(board, grade, subject, kc_slug)
  )`,
  'CREATE INDEX IF NOT EXISTS kc_standard_idx ON knowledge_components (curriculum_standard_id)',
  'CREATE INDEX IF NOT EXISTS kc_subject_slug_idx ON knowledge_components (subject, kc_slug)',
  `CREATE TABLE IF NOT EXISTS kc_prerequisites (
    prerequisite_kc_id TEXT NOT NULL, dependent_kc_id TEXT NOT NULL,
    strength REAL NOT NULL DEFAULT 1.0,
    source TEXT NOT NULL DEFAULT 'curated',
    created_at TEXT NOT NULL,
    PRIMARY KEY(prerequisite_kc_id, dependent_kc_id)
  )`,
  'CREATE INDEX IF NOT EXISTS kc_prereq_dependent_idx ON kc_prerequisites (dependent_kc_id)',
];

async function main() {
  console.log(`${migrationId}: ${apply ? 'APPLY' : 'DRY RUN'}`);
  const db = getDb();
  if (await alreadyApplied(db, migrationId)) return console.log('Already applied; no changes made.');

  // Pre-flight: which curriculum_standards.id values exist? Fetch board/grade/subject per standard
  // so KCs inherit them (seed spans CBSE 10 AND CBSE 12 — never hardcode).
  const stdRows = (await db.execute({ sql: 'SELECT id, board, grade, subject FROM curriculum_standards' })).rows;
  const stdById = new Map(stdRows.map((r) => [r.id, r]));
  const validKcs = kcs.filter((kc) => stdById.has(kc.standard));
  const skipped = kcs.length - validKcs.length;
  if (skipped) console.warn(`WARN: ${skipped} KC(s) reference a curriculum_standard_id not in curriculum_standards and will be skipped.`);

  const ts = now();
  const kcStmts = validKcs.map((kc) => {
    const std = stdById.get(kc.standard);
    return {
      sql: `INSERT INTO knowledge_components (id, curriculum_standard_id, board, grade, subject, kc_label, kc_slug, cognitive_level, source, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'curated', ?)
            ON CONFLICT(id) DO UPDATE SET kc_label = excluded.kc_label, cognitive_level = excluded.cognitive_level`,
      args: [kc.id, kc.standard, std.board, std.grade, std.subject, kc.label, kc.slug, kc.cognitive, ts],
    };
  });
  const kcIds = new Set(validKcs.map((kc) => kc.id));
  // Seed edges are [dependentKcId, prerequisiteKcId] — element 0 DEPENDS ON element 1.
  const prereqStmts = prerequisites
    .filter(([dep, pre]) => kcIds.has(pre) && kcIds.has(dep))
    .map(([dep, pre]) => ({
      sql: `INSERT INTO kc_prerequisites (prerequisite_kc_id, dependent_kc_id, strength, source, created_at)
            VALUES (?, ?, 1.0, 'curated', ?)
            ON CONFLICT(prerequisite_kc_id, dependent_kc_id) DO NOTHING`,
      args: [pre, dep, ts],
    }));

  for (const sql of ddl) {
    console.log(apply ? `APPLY DDL: ${sql.slice(0, 72)}...` : `PLAN DDL: ${sql.slice(0, 72)}...`);
    if (apply) await db.execute(sql);
  }
  console.log(apply ? `APPLY: upsert ${kcStmts.length} KCs, ${prereqStmts.length} prereqs` : `PLAN: upsert ${kcStmts.length} KCs, ${prereqStmts.length} prereqs`);
  if (apply) {
    for (let i = 0; i < kcStmts.length; i += 40) await db.batch(kcStmts.slice(i, i + 40), 'write');
    for (let i = 0; i < prereqStmts.length; i += 40) await db.batch(prereqStmts.slice(i, i + 40), 'write');
    await markApplied(db, migrationId, [...ddl, `seed:${kcStmts.length}kcs+${prereqStmts.length}prereqs`]);
    console.log('Applied and recorded in schema_migrations.');
  } else {
    console.log('Dry run only. Re-run with --apply to execute.');
  }
}
main().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
