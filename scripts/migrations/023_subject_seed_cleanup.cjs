#!/usr/bin/env node

/* Subject seed cleanup: drop set-suffixed variants ('Mathematics set A') and alias
 * duplicates ('Maths' when 'Mathematics' exists) seeded by 022 before set extraction
 * was added. Only deletes rows with zero references (exams not built yet).
 *
 *   node scripts/migrations/023_subject_seed_cleanup.cjs --dry-run
 *   node scripts/migrations/023_subject_seed_cleanup.cjs --apply
 */
const { getDb, parseSubjectAndSet, alreadyApplied, markApplied } = require('./_lib.cjs');

const migrationId = '023_subject_seed_cleanup';
const apply = process.argv.includes('--apply');

async function main() {
  const db = getDb();
  console.log(`${migrationId}: ${apply ? 'APPLY' : 'DRY RUN'}`);
  if (apply && (await alreadyApplied(db, migrationId))) return console.log('Already applied; no changes made.');

  const subjects = (await db.execute('SELECT id, school_id, name FROM subjects')).rows;
  const bySchool = new Map();
  for (const row of subjects) {
    if (!bySchool.has(row.school_id)) bySchool.set(row.school_id, []);
    bySchool.get(row.school_id).push(row);
  }

  const toDelete = [];
  for (const rows of bySchool.values()) {
    const canonicalKeys = new Map(); // normalized key -> subject row (non-set, alias-resolved)
    for (const row of rows) {
      const parsed = parseSubjectAndSet(row.name);
      if (!parsed) continue;
      if (!parsed.setCode && parsed.key === row.name.toLowerCase() && !canonicalKeys.has(parsed.key)) canonicalKeys.set(parsed.key, row);
    }
    for (const row of rows) {
      const parsed = parseSubjectAndSet(row.name);
      if (!parsed) continue;
      const isSetVariant = parsed.setCode !== null;
      const isAliasDuplicate = parsed.key !== row.name.toLowerCase() && canonicalKeys.has(parsed.key);
      if (isSetVariant || isAliasDuplicate) {
        const refs = await db.execute({ sql: 'SELECT COUNT(*) n FROM exams WHERE subject_id = ?', args: [row.id] });
        if (refs.rows[0].n === 0) toDelete.push(row);
      }
    }
  }

  console.log('Subjects to remove:', toDelete.map((r) => r.name));
  if (!apply) return;
  await db.batch(toDelete.map((r) => ({ sql: 'DELETE FROM subjects WHERE id = ?', args: [r.id] })), 'write');
  await markApplied(db, migrationId, toDelete.map((r) => r.id));
  console.log(`Applied ${migrationId}: removed ${toDelete.length}.`);
}

main().catch((error) => { console.error(`${migrationId} failed: ${error.message}`); process.exitCode = 1; });
