#!/usr/bin/env node

/* 034: Normalize duplicate subject rows.
 *   - Merge 'Maths' → 'Mathematics', 'biology' → 'Biology' etc.
 *   - Re-point exams.subject_id FKs to the canonical row.
 *   - Delete the duplicate subjects rows.
 *   - 'Internal validation' rows are left untouched (hidden from UI by canonical list filter).
 *
 *   node scripts/migrations/034_normalize_subjects.cjs --dry-run
 *   node scripts/migrations/034_normalize_subjects.cjs --apply
 */
const { getDb, alreadyApplied, markApplied } = require('./_lib.cjs');

const migrationId = '034_normalize_subjects';
const apply = process.argv.includes('--apply');

// Canonical display name → list of known duplicates (case-insensitive match)
const MERGES = [
  { canonical: 'Mathematics', duplicates: ['Maths', 'maths', 'Math'] },
  { canonical: 'Biology', duplicates: ['biology', 'bio'] },
  { canonical: 'Chemistry', duplicates: ['chem'] },
  { canonical: 'Accounts', duplicates: ['Accountancy', 'accountancy'] },
];

async function main() {
  console.log(`${migrationId}: ${apply ? 'APPLY' : 'DRY RUN'}`);
  const db = getDb();
  if (await alreadyApplied(db, migrationId)) return console.log('Already applied; no changes made.');

  const statements = [];

  for (const { canonical, duplicates } of MERGES) {
    // Find all subject rows for this school that match the canonical or a duplicate name
    const all = (await db.execute({
      sql: `SELECT id, school_id, name FROM subjects WHERE LOWER(name) IN (${[canonical, ...duplicates].map(() => '?').join(',')})`,
      args: [canonical, ...duplicates].map((n) => n.toLowerCase()),
    })).rows;

    if (!all.length) continue;

    // Group by school_id — pick the canonical row (exact case match) or the first one
    const bySchool = new Map();
    for (const row of all) {
      if (!bySchool.has(row.school_id)) bySchool.set(row.school_id, []);
      bySchool.get(row.school_id).push(row);
    }

    for (const [schoolId, rows] of bySchool) {
      const canonicalRow = rows.find((r) => r.name === canonical) || rows[0];
      const dupes = rows.filter((r) => r.id !== canonicalRow.id);
      if (!dupes.length) {
        // Only one row — just ensure its name is canonical
        if (canonicalRow.name !== canonical) {
          statements.push({
            sql: 'UPDATE subjects SET name = ? WHERE id = ?',
            args: [canonical, canonicalRow.id],
            desc: `Rename subject ${canonicalRow.id} (${canonicalRow.name} → ${canonical}) school=${schoolId}`,
          });
        }
        continue;
      }
      // Re-point exams to the canonical row
      for (const dupe of dupes) {
        statements.push({
          sql: 'UPDATE exams SET subject_id = ? WHERE subject_id = ?',
          args: [canonicalRow.id, dupe.id],
          desc: `Re-point exams from ${dupe.id} (${dupe.name}) → ${canonicalRow.id} (${canonical}) school=${schoolId}`,
        });
        statements.push({
          sql: 'DELETE FROM subjects WHERE id = ?',
          args: [dupe.id],
          desc: `Delete duplicate subject ${dupe.id} (${dupe.name}) school=${schoolId}`,
        });
      }
      // Ensure canonical row has the right name
      if (canonicalRow.name !== canonical) {
        statements.push({
          sql: 'UPDATE subjects SET name = ? WHERE id = ?',
          args: [canonical, canonicalRow.id],
          desc: `Rename subject ${canonicalRow.id} (${canonicalRow.name} → ${canonical}) school=${schoolId}`,
        });
      }
    }
  }

  if (!statements.length) {
    console.log('  No duplicates found; nothing to do.');
    if (apply) await markApplied(db, migrationId, ['no-op']);
    return;
  }

  for (const stmt of statements) {
    console.log(`  ${apply ? 'EXEC' : 'PLAN'}: ${stmt.desc}`);
    if (apply) await db.execute({ sql: stmt.sql, args: stmt.args });
  }

  if (apply) {
    await markApplied(db, migrationId, statements.map((s) => s.desc));
    console.log(`  Done. ${statements.length} statements applied.`);
  } else {
    console.log(`  Dry run complete. ${statements.length} statements would run. Use --apply to execute.`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
