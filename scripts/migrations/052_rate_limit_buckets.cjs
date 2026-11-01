#!/usr/bin/env node

/* 052: Rate-limit buckets — persistent fixed-window limiter for AI endpoints.
 *
 *   node scripts/migrations/052_rate_limit_buckets.cjs --dry-run
 *   node scripts/migrations/052_rate_limit_buckets.cjs --apply
 */
const { getDb, alreadyApplied, markApplied } = require('./_lib.cjs');

const migrationId = '052_rate_limit_buckets';
const apply = process.argv.includes('--apply');

const statements = [
  `CREATE TABLE IF NOT EXISTS rate_limit_buckets (
    bucket_key TEXT NOT NULL,
    window_start INTEGER NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (bucket_key, window_start)
  )`,
  'CREATE INDEX IF NOT EXISTS rate_limit_buckets_key_window_idx ON rate_limit_buckets (bucket_key, window_start)',
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
