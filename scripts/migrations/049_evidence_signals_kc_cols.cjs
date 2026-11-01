#!/usr/bin/env node
/* 049: KC tagging columns on evidence_signals for the scientific mastery layer.
 *   node scripts/migrations/049_evidence_signals_kc_cols.cjs --dry-run
 *   node scripts/migrations/049_evidence_signals_kc_cols.cjs --apply
 */
const { getDb, alreadyApplied, markApplied } = require('./_lib.cjs');
const migrationId = '049_evidence_signals_kc_cols';
const apply = process.argv.includes('--apply');
const statements = [
  `ALTER TABLE evidence_signals ADD COLUMN kc_ids_json TEXT NOT NULL DEFAULT '[]'`,
  'ALTER TABLE evidence_signals ADD COLUMN misconception_class TEXT',
];
async function main() {
  console.log(`${migrationId}: ${apply ? 'APPLY' : 'DRY RUN'}`);
  const db = getDb();
  if (await alreadyApplied(db, migrationId)) return console.log('Already applied; no changes made.');
  const existing = new Set((await db.execute('PRAGMA table_info(evidence_signals)')).rows.map((r) => r.name));
  for (const sql of statements) {
    const col = sql.match(/ADD COLUMN (\w+)/)[1];
    if (existing.has(col)) { console.log(`SKIP (column exists): ${sql}`); continue; }
    console.log(apply ? `APPLY: ${sql}` : `PLAN: ${sql}`);
    if (apply) await db.execute(sql);
  }
  if (apply) { await markApplied(db, migrationId, statements); console.log('Applied and recorded in schema_migrations.'); }
  else console.log('Dry run only. Re-run with --apply to execute.');
}
main().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
