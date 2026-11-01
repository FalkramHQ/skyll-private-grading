#!/usr/bin/env node

/* 051: Product analytics — authenticated user_events for DAU/MAU/funnels.
 *
 *   node scripts/migrations/051_user_events.cjs --dry-run
 *   node scripts/migrations/051_user_events.cjs --apply
 */
const { getDb, alreadyApplied, markApplied } = require('./_lib.cjs');

const migrationId = '051_user_events';
const apply = process.argv.includes('--apply');

const statements = [
  `CREATE TABLE IF NOT EXISTS user_events (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    username TEXT,
    role TEXT,
    school_id TEXT,
    school TEXT,
    event_type TEXT NOT NULL,
    event_data TEXT NOT NULL DEFAULT '{}',
    platform TEXT NOT NULL DEFAULT 'web',
    created_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS user_events_created_idx ON user_events (created_at DESC)',
  'CREATE INDEX IF NOT EXISTS user_events_type_created_idx ON user_events (event_type, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS user_events_user_created_idx ON user_events (user_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS user_events_school_created_idx ON user_events (school_id, created_at DESC)',
];

async function main() {
  console.log(`${migrationId}: ${apply ? 'APPLY' : 'DRY RUN'}`);
  const db = getDb();
  if (await alreadyApplied(db, migrationId)) return console.log('Already applied; no changes made.');

  for (const sql of statements) {
    console.log(apply ? `APPLY: ${sql.slice(0, 100)}` : `PLAN: ${sql.slice(0, 100)}`);
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
