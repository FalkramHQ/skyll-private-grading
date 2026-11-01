#!/usr/bin/env node

/* Phase 5: reports & dashboards backfill.
 *   A. report_versions.exam_id / student_id from the submissions join (dashboards
 *      query without 3-join chains).
 *   B. learner DNA rekey: learner_dna (username PK) -> learner_dna_v2 (student_id PK)
 *      via student_user_links -> students.user_id -> report_versions, counts recomputed.
 *   C. cohort_report_cache seed: one computed aggregate payload per exam, replacing
 *      teacher payload blobs with a canonical cache.
 *
 *   node scripts/migrations/029_reports_dna_cache_backfill.cjs --dry-run
 *   node scripts/migrations/029_reports_dna_cache_backfill.cjs --apply
 */
const { getDb, now, alreadyApplied, markApplied } = require('./_lib.cjs');

const migrationId = '029_reports_dna_cache_backfill';
const apply = process.argv.includes('--apply');

function performanceBand(percentage) {
  if (percentage >= 75) return 'quadrant_a';
  if (percentage >= 45) return 'quadrant_b';
  if (percentage >= 35) return 'quadrant_c';
  return 'quadrant_d';
}

async function resolveStudentId(db, username, cache) {
  if (cache.has(username)) return cache.get(username);
  let studentId = (await db.execute({
    sql: 'SELECT sul.student_id FROM user_credentials uc JOIN student_user_links sul ON sul.user_id = uc.user_id WHERE uc.login_id = ? LIMIT 1',
    args: [username],
  })).rows[0]?.student_id || null;
  if (!studentId) {
    studentId = (await db.execute({
      sql: 'SELECT st.id FROM user_credentials uc JOIN students st ON st.user_id = uc.user_id WHERE uc.login_id = ? LIMIT 1',
      args: [username],
    })).rows[0]?.id || null;
  }
  if (!studentId) {
    studentId = (await db.execute({
      sql: 'SELECT student_id FROM report_versions WHERE username = ? AND student_id IS NOT NULL ORDER BY published_at DESC LIMIT 1',
      args: [username],
    })).rows[0]?.student_id || null;
  }
  cache.set(username, studentId || null);
  return studentId || null;
}

async function main() {
  console.log(`${migrationId}: ${apply ? 'APPLY' : 'DRY RUN'}`);
  const db = getDb();
  if (await alreadyApplied(db, migrationId)) return console.log('Already applied; no changes made.');
  const at = now();
  const parts = [];

  // A. report_versions exam/student backfill
  const rvBackfill = `UPDATE report_versions SET
      exam_id = (SELECT s.exam_id FROM submissions s WHERE s.id = report_versions.submission_id),
      student_id = (SELECT s.student_id FROM submissions s WHERE s.id = report_versions.submission_id)
    WHERE exam_id IS NULL`;
  console.log(`  A. report_versions backfill: ${rvBackfill}`);
  parts.push(rvBackfill);
  if (apply) await db.execute(rvBackfill);
  const rvDone = apply ? (await db.execute('SELECT COUNT(*) AS c FROM report_versions WHERE exam_id IS NOT NULL')).rows[0].c : '(dry run)';
  const rvOrphans = (await db.execute(`SELECT rv.id FROM report_versions rv LEFT JOIN submissions s ON s.id = rv.submission_id WHERE rv.exam_id IS NULL AND s.id IS NULL`)).rows;
  console.log(`     exam_id set: ${rvDone}; unresolved (no canonical submission): ${rvOrphans.length}${rvOrphans.length ? ' — ' + rvOrphans.map((r) => r.id).join(', ') : ''}`);

  // B. learner DNA rekey username -> student_id
  const dnaRows = (await db.execute('SELECT * FROM learner_dna')).rows;
  const idCache = new Map();
  let rekeyed = 0;
  const unresolved = [];
  for (const row of dnaRows) {
    const studentId = await resolveStudentId(db, row.username, idCache);
    if (!studentId) { unresolved.push(row.username); continue; }
    const schoolId = (await db.execute({ sql: 'SELECT school_id FROM students WHERE id = ?', args: [studentId] })).rows[0]?.school_id || null;
    if (!schoolId) { unresolved.push(`${row.username} (no student row)`); continue; }
    const examCount = Number((await db.execute({
      sql: "SELECT COUNT(DISTINCT s.exam_id) AS c FROM submissions s JOIN report_versions rv ON rv.submission_id = s.id AND rv.status = 'published' WHERE s.student_id = ?",
      args: [studentId],
    })).rows[0]?.c || 0) || Number(row.exam_count || 0);
    const questionCount = Number((await db.execute({
      sql: 'SELECT COUNT(*) AS c FROM submission_questions_v2 q JOIN submissions s ON s.id = q.submission_id WHERE s.student_id = ?',
      args: [studentId],
    })).rows[0]?.c || 0) || Number(row.question_count || 0);
    const upsert = `INSERT INTO learner_dna_v2 (student_id, school_id, dna_json, exam_count, question_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(student_id) DO UPDATE SET
        school_id = excluded.school_id, dna_json = excluded.dna_json,
        exam_count = excluded.exam_count, question_count = excluded.question_count, updated_at = excluded.updated_at`;
    if (apply) {
      await db.execute({
        sql: upsert,
        args: [studentId, schoolId, row.dna_json, examCount, questionCount, row.created_at || at, at],
      });
    }
    rekeyed += 1;
  }
  parts.push('learner_dna -> learner_dna_v2 rekey');
  console.log(`  B. DNA rekey: ${rekeyed}/${dnaRows.length} rekeyed; unresolved: ${unresolved.length}${unresolved.length ? ' — ' + unresolved.join(', ') : ''}`);

  // C. cohort_report_cache seed (one computed aggregate per exam)
  const exams = (await db.execute(`SELECT e.id, e.source_test_id, e.name, e.exam_date, e.status,
      sub.name AS subject, t.grade
      FROM exams e LEFT JOIN subjects sub ON sub.id = e.subject_id
      LEFT JOIN tests t ON t.id = e.source_test_id`)).rows;
  let cached = 0;
  for (const exam of exams) {
    const submissions = (await db.execute({
      sql: `SELECT s.student_id, s.score, s.max_marks,
                   COALESCE(st.display_name, ts.student_name, s.student_id) AS student_name
            FROM submissions s
            LEFT JOIN students st ON st.id = s.student_id
            LEFT JOIN test_students ts ON ts.test_id = ? AND ts.student_id = s.student_id
            WHERE s.exam_id = ? AND s.status != 'archived'`,
      args: [exam.source_test_id || '', exam.id],
    })).rows;
    const scored = submissions.filter((row) => Number(row.max_marks) > 0);
    const segments = { quadrant_a: [], quadrant_b: [], quadrant_c: [], quadrant_d: [] };
    for (const row of scored) {
      segments[performanceBand(Math.round((Number(row.score || 0) / Number(row.max_marks)) * 100))].push(row.student_name || row.student_id);
    }
    const count = scored.length;
    const payload = {
      assessment: {
        test_id: exam.source_test_id || exam.id, exam_id: exam.id,
        title: exam.name || 'Untitled assessment', subject: exam.subject || '', grade: exam.grade || '', exam_date: exam.exam_date || null,
      },
      overview: {
        evaluated_students: count,
        average_score: count ? Math.round((scored.reduce((sum, row) => sum + Number(row.score || 0), 0) / count) * 100) / 100 : 0,
        average_total: count ? Math.round((scored.reduce((sum, row) => sum + Number(row.max_marks || 0), 0) / count) * 100) / 100 : 0,
        average_percentage: count ? Math.round(scored.reduce((sum, row) => sum + (Number(row.score || 0) / Number(row.max_marks)) * 100, 0) / count) : 0,
      },
      segmentation: segments,
    };
    const cacheUpsert = `INSERT INTO cohort_report_cache (exam_id, school_id, payload_json, computed_at, invalidated_at)
      VALUES (?, (SELECT school_id FROM exams WHERE id = ?), ?, ?, NULL)
      ON CONFLICT(exam_id) DO UPDATE SET
        payload_json = excluded.payload_json, computed_at = excluded.computed_at, invalidated_at = NULL`;
    if (apply) await db.execute({ sql: cacheUpsert, args: [exam.id, exam.id, JSON.stringify(payload), at] });
    cached += 1;
  }
  parts.push('cohort_report_cache seed');
  console.log(`  C. cohort cache: ${cached} exam aggregate(s) computed`);

  if (!apply) return;
  await markApplied(db, migrationId, parts);
  console.log(`Applied ${migrationId}.`);
}

main().catch((error) => { console.error(`${migrationId} failed: ${error.message}`); process.exitCode = 1; });
