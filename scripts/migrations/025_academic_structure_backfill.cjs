#!/usr/bin/env node

/* Phase 2: academic structure backfill —
 *   1. batch_memberships  <- batch_students (history preserved: joined_at/left_at/status)
 *   2. batches.academic_year_id <- academic_years (per school + label, default current)
 *   3. batches.subject_id <- inferred via test_batches -> tests.subject (else NULL, review list)
 *   4. student_enrollments <- current school year + active batch grade (1 standard/student/year)
 *
 * Idempotent: safe to re-run.
 *
 *   node scripts/migrations/025_academic_structure_backfill.cjs --dry-run
 *   node scripts/migrations/025_academic_structure_backfill.cjs --apply
 */
const { getDb, id, now, parseSubjectAndSet, alreadyApplied, markApplied } = require('./_lib.cjs');

const migrationId = '025_academic_structure_backfill';
const apply = process.argv.includes('--apply');

async function main() {
  const db = getDb();
  console.log(`${migrationId}: ${apply ? 'APPLY' : 'DRY RUN'}`);
  if (apply && (await alreadyApplied(db, migrationId))) return console.log('Already applied; no changes made.');
  const ts = now();
  const statements = [];
  const reviewList = [];

  // --- 1. batch_memberships <- batch_students
  const legacyMemberships = (await db.execute('SELECT batch_id, student_id, status, joined_at, left_at FROM batch_students')).rows;
  const existingMemberships = new Set(
    (await db.execute('SELECT batch_id || \'|\' || student_id AS k FROM batch_memberships')).rows.map((r) => r.k),
  );
  let membershipsAdded = 0;
  for (const row of legacyMemberships) {
    const key = `${row.batch_id}|${row.student_id}`;
    if (existingMemberships.has(key)) continue;
    membershipsAdded += 1;
    statements.push({
      sql: 'INSERT INTO batch_memberships (id, batch_id, student_id, status, joined_at, left_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      args: [id('mem'), row.batch_id, row.student_id, row.status, row.joined_at || ts, row.left_at || null, ts, ts],
    });
  }

  // --- 2. batches.academic_year_id
  const yearRows = (await db.execute('SELECT id, school_id, label, is_current FROM academic_years')).rows;
  const yearBySchoolLabel = new Map(yearRows.map((r) => [`${r.school_id}|${r.label}`, r.id]));
  const currentYearBySchool = new Map(yearRows.filter((r) => r.is_current === 1).map((r) => [r.school_id, r.id]));
  const batches = (await db.execute('SELECT id, school_id, name, grade, academic_year FROM batches WHERE academic_year_id IS NULL')).rows;
  let batchesYearLinked = 0;
  for (const batch of batches) {
    const yearId = (batch.academic_year && yearBySchoolLabel.get(`${batch.school_id}|${batch.academic_year}`)) || currentYearBySchool.get(batch.school_id);
    if (!yearId) { reviewList.push(`batch ${batch.name}: no academic year for school ${batch.school_id}`); continue; }
    batchesYearLinked += 1;
    statements.push({ sql: 'UPDATE batches SET academic_year_id = ?, updated_at = ? WHERE id = ?', args: [yearId, ts, batch.id] });
  }

  // --- 3. batches.subject_id (infer from tests that used the batch, then batch-name vocabulary).
  const subjectRows = (await db.execute('SELECT id, school_id, name FROM subjects')).rows;
  const subjectBySchoolKey = new Map(subjectRows.map((r) => [`${r.school_id}|${r.name.toLowerCase()}`, r.id]));
  const batchSubjectUsage = (await db.execute(`
    SELECT tb.batch_id, t.school_id, t.subject, COUNT(*) n
    FROM test_batches tb JOIN tests t ON t.id = tb.test_id
    WHERE t.subject IS NOT NULL AND TRIM(t.subject) != ''
    GROUP BY tb.batch_id, t.subject ORDER BY tb.batch_id, n DESC`)).rows;
  const subjectByBatch = new Map();
  for (const row of batchSubjectUsage) {
    if (subjectByBatch.has(row.batch_id)) continue; // highest vote first
    const parsed = parseSubjectAndSet(row.subject);
    if (!parsed) continue;
    const subjectId = subjectBySchoolKey.get(`${row.school_id}|${parsed.key}`);
    if (subjectId) subjectByBatch.set(row.batch_id, subjectId);
  }
  const SUBJECT_VOCABULARY = ['physics', 'chemistry', 'maths', 'mathematics', 'biology', 'accounts', 'science', 'english', 'economics'];
  const unlinkedBatches = (await db.execute('SELECT id, school_id, name FROM batches WHERE subject_id IS NULL')).rows;
  let batchesSubjectLinked = 0;
  for (const batch of unlinkedBatches) {
    let subjectId = subjectByBatch.get(batch.id);
    if (!subjectId) {
      // Try a controlled-vocabulary match on the batch name ('11th Physics' -> Physics).
      const tokens = String(batch.name || '').toLowerCase().split(/[^a-z]+/).filter(Boolean);
      const hit = tokens.find((token) => SUBJECT_VOCABULARY.includes(token));
      if (hit) {
        const canonical = parseSubjectAndSet(hit);
        const key = `${batch.school_id}|${canonical.key}`;
        subjectId = subjectBySchoolKey.get(key);
        if (!subjectId) {
          // Subject clearly exists at the school (taught in a batch) but was never in a test — create it.
          subjectId = id('sub');
          subjectBySchoolKey.set(key, subjectId);
          statements.push({ sql: 'INSERT INTO subjects (id, school_id, name, code, status, created_at, updated_at) VALUES (?, ?, ?, NULL, \'active\', ?, ?)', args: [subjectId, batch.school_id, canonical.display, ts, ts] });
        }
      }
    }
    if (!subjectId) { reviewList.push(`batch ${batch.name} (${batch.id}): subject ambiguous — needs human review`); continue; }
    batchesSubjectLinked += 1;
    statements.push({ sql: 'UPDATE batches SET subject_id = ?, updated_at = ? WHERE id = ?', args: [subjectId, ts, batch.id] });
  }

  // --- 4. student_enrollments (standard = grade of most recently joined active batch).
  const enrollmentSource = (await db.execute(`
    SELECT st.id AS student_id, st.school_id, b.grade, bs.joined_at
    FROM students st
    JOIN batch_students bs ON bs.student_id = st.id AND bs.status = 'active'
    JOIN batches b ON b.id = bs.batch_id
    WHERE st.school_id IS NOT NULL AND b.grade IS NOT NULL AND TRIM(b.grade) != ''
    ORDER BY st.id, bs.joined_at DESC`)).rows;
  const standardByStudent = new Map();
  for (const row of enrollmentSource) if (!standardByStudent.has(row.student_id)) standardByStudent.set(row.student_id, row);
  const existingEnrollments = new Set(
    (await db.execute('SELECT student_id || \'|\' || academic_year_id AS k FROM student_enrollments')).rows.map((r) => r.k),
  );
  let enrollmentsAdded = 0;
  for (const row of standardByStudent.values()) {
    const yearId = currentYearBySchool.get(row.school_id);
    if (!yearId || existingEnrollments.has(`${row.student_id}|${yearId}`)) continue;
    enrollmentsAdded += 1;
    statements.push({
      sql: 'INSERT INTO student_enrollments (id, student_id, academic_year_id, standard, status, created_at, updated_at) VALUES (?, ?, ?, ?, \'active\', ?, ?)',
      args: [id('enr'), row.student_id, yearId, String(row.grade).trim(), ts, ts],
    });
  }

  console.log(JSON.stringify({ membershipsAdded, batchesYearLinked, batchesSubjectLinked, enrollmentsAdded }, null, 2));
  if (reviewList.length) console.log('Review list:\n  ' + reviewList.join('\n  '));
  if (!apply) return;

  const CHUNK = 400;
  for (let i = 0; i < statements.length; i += CHUNK) await db.batch(statements.slice(i, i + CHUNK), 'write');
  await markApplied(db, migrationId, [`memberships:${membershipsAdded}`, `enrollments:${enrollmentsAdded}`]);
  console.log(`Applied ${migrationId}.`);
}

main().catch((error) => { console.error(`${migrationId} failed: ${error.message}`); process.exitCode = 1; });
