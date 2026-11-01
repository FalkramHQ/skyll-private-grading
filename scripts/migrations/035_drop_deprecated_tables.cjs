#!/usr/bin/env node

/* Phase 7b: DROP soft-deprecated tables after bake.
 *   These were renamed in 032/033 and have had no application reads/writes.
 *
 *   node scripts/migrations/035_drop_deprecated_tables.cjs --dry-run
 *   node scripts/migrations/035_drop_deprecated_tables.cjs --apply
 */
const { getDb, alreadyApplied, markApplied } = require('./_lib.cjs');

const migrationId = '035_drop_deprecated_tables';
const apply = process.argv.includes('--apply');

async function main() {
  console.log(`${migrationId}: ${apply ? 'APPLY' : 'DRY RUN'}`);
  const db = getDb();
  if (await alreadyApplied(db, migrationId)) return console.log('Already applied; no changes made.');

  const existing = (await db.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '_deprecated_%' ORDER BY name",
  )).rows.map((r) => r.name);

  if (!existing.length) {
    console.log('  No _deprecated_* tables found.');
    if (apply) await markApplied(db, migrationId, ['none']);
    return;
  }

  const parts = [];
  for (const name of existing) {
    const count = (await db.execute(`SELECT COUNT(*) AS c FROM "${name}"`)).rows[0].c;
    console.log(`  DROP ${name} (${count} rows)`);
    if (apply) {
      await db.execute(`DROP TABLE IF EXISTS "${name}"`);
    }
    parts.push(`${name} (${count} rows)`);
  }

  console.log(`  Total: ${existing.length} table(s)`);
  if (!apply) {
    console.log('Dry run only. Pass --apply to drop.');
    return;
  }
  await markApplied(db, migrationId, parts);
  console.log(`Applied ${migrationId}.`);
}

main().catch((error) => {
  console.error(`${migrationId} failed: ${error.message}`);
  process.exitCode = 1;
});
