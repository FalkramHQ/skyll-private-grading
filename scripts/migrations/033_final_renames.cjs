#!/usr/bin/env node

/* Phase 7 (continued): rename remaining deferred tables.
 *   - login_rate_limits → credential_rate_limits (canonical rename, still active)
 *   - vl_cohort_status → _deprecated_vl_cohort_status (superseded by exams.status)
 *
 *   node scripts/migrations/033_final_renames.cjs --dry-run
 *   node scripts/migrations/033_final_renames.cjs --apply
 */
const { getDb, alreadyApplied, markApplied } = require('./_lib.cjs');

const migrationId = '033_final_renames';
const apply = process.argv.includes('--apply');

const RENAMES = [
  { from: 'login_rate_limits', to: 'credential_rate_limits', deprecated: false },
  { from: 'vl_cohort_status', to: '_deprecated_vl_cohort_status', deprecated: true },
];

async function main() {
  console.log(`${migrationId}: ${apply ? 'APPLY' : 'DRY RUN'}`);
  const db = getDb();
  if (await alreadyApplied(db, migrationId)) return console.log('Already applied; no changes made.');
  const parts = [];

  const existing = new Set((await db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")).rows.map((r) => r.name));

  for (const { from, to, deprecated } of RENAMES) {
    if (!existing.has(from)) {
      console.log(`  SKIP ${from} (does not exist)`);
      continue;
    }
    if (existing.has(to)) {
      console.log(`  SKIP ${from} (${to} already exists)`);
      continue;
    }
    const count = (await db.execute(`SELECT COUNT(*) AS c FROM ${from}`)).rows[0].c;
    console.log(`  RENAME ${from} (${count} rows) → ${to}${deprecated ? ' [DEPRECATED]' : ''}`);
    if (apply) {
      await db.execute(`ALTER TABLE ${from} RENAME TO ${to}`);
    }
    parts.push(`${from} → ${to} (${count} rows)`);
  }

  if (!apply) return;
  await markApplied(db, migrationId, parts);
  console.log(`Applied ${migrationId}.`);
}

main().catch((error) => { console.error(`${migrationId} failed: ${error.message}`); process.exitCode = 1; });
