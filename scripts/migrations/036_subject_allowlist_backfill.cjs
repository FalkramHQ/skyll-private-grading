#!/usr/bin/env node

/* 036: Enforce canonical subject allowlist on legacy rows.
 *   - UPDATE tests.subject aliases (Maths → Mathematics, ENG language → English, …)
 *   - Rename/merge subjects table rows onto allowlisted display names
 *   - Re-point exams.subject_id when merging duplicates
 *   - Leaves non-allowlisted operational rows (e.g. Internal validation) untouched
 *
 *   node scripts/migrations/036_subject_allowlist_backfill.cjs --dry-run
 *   node scripts/migrations/036_subject_allowlist_backfill.cjs --apply
 */
const { getDb, alreadyApplied, markApplied } = require('./_lib.cjs');

const migrationId = '036_subject_allowlist_backfill';
const apply = process.argv.includes('--apply');

const MERGES = [
  { canonical: 'Mathematics', duplicates: ['Maths', 'maths', 'Math', 'math'] },
  { canonical: 'Biology', duplicates: ['biology', 'Bio', 'bio'] },
  { canonical: 'Chemistry', duplicates: ['chem', 'Chem'] },
  { canonical: 'Accounts', duplicates: ['Accountancy', 'accountancy'] },
  { canonical: 'English', duplicates: ['English language', 'ENG language', 'Eng', 'eng', 'english language', 'eng language'] },
  { canonical: 'Hindi', duplicates: ['hindi'] },
  { canonical: 'Physics', duplicates: ['physics'] },
  { canonical: 'Science', duplicates: ['science'] },
];

async function main() {
  console.log(`${migrationId}: ${apply ? 'APPLY' : 'DRY RUN'}`);
  const db = getDb();
  if (await alreadyApplied(db, migrationId)) return console.log('Already applied; no changes made.');

  const plans = [];

  for (const { canonical, duplicates } of MERGES) {
    const names = [canonical, ...duplicates];
    const testRows = (await db.execute({
      sql: `SELECT id, subject FROM tests WHERE LOWER(TRIM(subject)) IN (${names.map(() => '?').join(',')}) AND subject != ?`,
      args: [...names.map((n) => n.toLowerCase()), canonical],
    })).rows;
    for (const row of testRows) {
      plans.push({
        sql: 'UPDATE tests SET subject = ? WHERE id = ?',
        args: [canonical, row.id],
        desc: `tests ${row.id}: ${row.subject} → ${canonical}`,
      });
    }

    const subjectRows = (await db.execute({
      sql: `SELECT id, school_id, name FROM subjects WHERE LOWER(TRIM(name)) IN (${names.map(() => '?').join(',')})`,
      args: names.map((n) => n.toLowerCase()),
    })).rows;

    const bySchool = new Map();
    for (const row of subjectRows) {
      if (!bySchool.has(row.school_id)) bySchool.set(row.school_id, []);
      bySchool.get(row.school_id).push(row);
    }

    for (const [schoolId, rows] of bySchool) {
      let canonicalRow = rows.find((r) => r.name === canonical) || null;
      if (!canonicalRow) {
        canonicalRow = rows[0];
        if (canonicalRow.name !== canonical) {
          plans.push({
            sql: 'UPDATE subjects SET name = ? WHERE id = ?',
            args: [canonical, canonicalRow.id],
            desc: `subjects rename ${canonicalRow.id} (${canonicalRow.name} → ${canonical}) school=${schoolId}`,
          });
          canonicalRow = { ...canonicalRow, name: canonical };
        }
      }
      for (const dupe of rows.filter((r) => r.id !== canonicalRow.id)) {
        plans.push({
          sql: 'UPDATE exams SET subject_id = ? WHERE subject_id = ?',
          args: [canonicalRow.id, dupe.id],
          desc: `exams re-point ${dupe.id} (${dupe.name}) → ${canonicalRow.id} school=${schoolId}`,
        });
        plans.push({
          sql: 'DELETE FROM subjects WHERE id = ?',
          args: [dupe.id],
          desc: `subjects delete duplicate ${dupe.id} (${dupe.name}) school=${schoolId}`,
        });
      }
    }
  }

  if (!plans.length) {
    console.log('  Nothing to change.');
    if (apply) await markApplied(db, migrationId, ['no-op']);
    return;
  }

  for (const plan of plans) {
    console.log(`  ${apply ? 'EXEC' : 'PLAN'}: ${plan.desc}`);
    if (apply) await db.execute({ sql: plan.sql, args: plan.args });
  }

  if (apply) {
    await markApplied(db, migrationId, plans.map((p) => p.desc));
    console.log(`  Done. ${plans.length} statements applied.`);
  } else {
    console.log(`  Dry run complete. ${plans.length} statements would run. Use --apply to execute.`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
