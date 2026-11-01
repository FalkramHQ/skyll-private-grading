#!/usr/bin/env node

/* 090: History and Geography join the subject allowlist.
 *   Before they were allowlisted, intake fell back to Chemistry, so History &
 *   Civics and Geography papers carry exams.subject_id pointing at the school's
 *   Chemistry subject (Partner Academy D, Oct 2026). For every exam whose test
 *   subject is History or Geography (or an alias):
 *   - create the school's History / Geography subjects row if it has none
 *   - re-point exams.subject_id at it
 *   - normalise tests.subject aliases ("History & Civics", "geography") to the
 *     canonical name
 *   SST stays its own subject.
 *
 *   node scripts/migrations/090_history_geography_subjects.cjs --dry-run
 *   node scripts/migrations/090_history_geography_subjects.cjs --apply
 */
const { randomUUID } = require('node:crypto');
const { getDb, alreadyApplied, markApplied } = require('./_lib.cjs');

const migrationId = '090_history_geography_subjects';
const apply = process.argv.includes('--apply');

const CANONICAL = [
  { canonical: 'History', aliases: ['history', 'hist', 'civics', 'history and civics', 'history & civics', 'history civics', 'history/civics'] },
  { canonical: 'Geography', aliases: ['geography', 'geo'] },
];

async function main() {
  console.log(`${migrationId}: ${apply ? 'APPLY' : 'DRY RUN'}`);
  const db = getDb();
  if (await alreadyApplied(db, migrationId)) return console.log('Already applied; no changes made.');

  const now = new Date().toISOString();
  const plans = [];

  for (const { canonical, aliases } of CANONICAL) {
    const rows = (await db.execute({
      sql: `SELECT e.id AS exam_id, e.name AS exam_name, e.school_id, e.subject_id,
                   cur.name AS current_subject, t.id AS test_id, t.subject AS test_subject
            FROM exams e
            JOIN tests t ON t.id = e.source_test_id
            LEFT JOIN subjects cur ON cur.id = e.subject_id
            WHERE LOWER(TRIM(t.subject)) IN (${aliases.map(() => '?').join(',')})`,
      args: aliases,
    })).rows;

    // One subjects row per school, found or created once.
    const subjectBySchool = new Map();
    for (const row of rows) {
      if (row.test_subject !== canonical) {
        plans.push({
          sql: 'UPDATE tests SET subject = ? WHERE id = ?',
          args: [canonical, row.test_id],
          desc: `tests ${row.test_id}: ${row.test_subject} → ${canonical}`,
        });
      }
      if (!row.school_id) {
        console.log(`  SKIP exam ${row.exam_id} (${row.exam_name}): no school_id`);
        continue;
      }
      if (!subjectBySchool.has(row.school_id)) {
        const existing = (await db.execute({
          sql: 'SELECT id FROM subjects WHERE school_id = ? AND LOWER(name) = ? LIMIT 1',
          args: [row.school_id, canonical.toLowerCase()],
        })).rows[0];
        if (existing) {
          subjectBySchool.set(row.school_id, existing.id);
        } else {
          const subjectId = `sub_${randomUUID()}`;
          subjectBySchool.set(row.school_id, subjectId);
          plans.push({
            sql: "INSERT INTO subjects (id, school_id, name, code, status, created_at, updated_at) VALUES (?, ?, ?, NULL, 'active', ?, ?)",
            args: [subjectId, row.school_id, canonical, now, now],
            desc: `subjects create ${canonical} (${subjectId}) school=${row.school_id}`,
          });
        }
      }
      const target = subjectBySchool.get(row.school_id);
      if (row.subject_id !== target) {
        plans.push({
          sql: 'UPDATE exams SET subject_id = ?, updated_at = ? WHERE id = ?',
          args: [target, now, row.exam_id],
          desc: `exams ${row.exam_id} (${row.exam_name}): subject ${row.current_subject || row.subject_id || 'none'} → ${canonical}`,
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
