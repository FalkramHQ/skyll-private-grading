#!/usr/bin/env node

/* Phase 3: exams & sets backfill —
 *   1. exams <- tests (date from title parse else created_at [flag]; type from rubric question mix [flag];
 *      status mapped onto the canonical lifecycle)
 *   2. exam_batches <- test_batches
 *   3. exam_sets: one default set 'A' per exam + latest question_paper/answer_key asset links
 *   4. exam_set_questions <- active exam_rubric_versions.question_map_json;
 *      fallback: first submission_questions row per question_number
 *   5. synthetic legacy exams for orphan submissions (tst_, legacy_test_, partneri_ prefixes), bucketed
 *      per (school, subject, grade, month) so old reports stay reachable without a ghost tests table
 *
 * Idempotent: safe to re-run (deterministic ids + upserts).
 *
 *   node scripts/migrations/026_exams_sets_backfill.cjs --dry-run
 *   node scripts/migrations/026_exams_sets_backfill.cjs --apply
 */
const fs = require('node:fs');
const path = require('node:path');
const { getDb, id, now, stableId, loadSchoolResolver, parseSubjectAndSet, alreadyApplied, markApplied } = require('./_lib.cjs');

const migrationId = '026_exams_sets_backfill';
const apply = process.argv.includes('--apply');

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const pad = (n) => String(n).padStart(2, '0');

/* '20/07/2026' | '25 June ...' | 'July 2026' -> { date: 'YYYY-MM-DD', month: 'YYYY-MM' } */
function parseDateText(raw, fallbackDate) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const numeric = text.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
  if (numeric && Number(numeric[2]) >= 1 && Number(numeric[2]) <= 12) {
    return { date: `${numeric[3]}-${pad(numeric[2])}-${pad(numeric[1])}`, month: `${numeric[3]}-${pad(numeric[2])}` };
  }
  const dayMonth = text.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\b/);
  if (dayMonth) {
    const monthIndex = MONTHS.indexOf(dayMonth[2].toLowerCase());
    if (monthIndex >= 0) {
      const year = String((fallbackDate || new Date()).getUTCFullYear());
      return { date: `${year}-${pad(monthIndex + 1)}-${pad(dayMonth[1])}`, month: `${year}-${pad(monthIndex + 1)}` };
    }
  }
  const monthYear = text.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (monthYear) {
    const monthIndex = MONTHS.indexOf(monthYear[1].toLowerCase());
    if (monthIndex >= 0) return { date: `${monthYear[2]}-${pad(monthIndex + 1)}-01`, month: `${monthYear[2]}-${pad(monthIndex + 1)}` };
  }
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return { date: `${iso[1]}-${iso[2]}-${iso[3]}`, month: `${iso[1]}-${iso[2]}` };
  return null;
}

const STATUS_MAP = new Map([
  ['uploading', 'collecting'],
  ['rubric_complete', 'processing'],
  ['grading_queued', 'processing'],
  ['grading_processing', 'processing'],
  ['report_queued', 'processing'],
  ['report_failed', 'processing'],
  ['ready_for_review', 'in_review'],
]);

function examTypeFromResponseTypes(types) {
  const set = new Set(types.filter(Boolean));
  if (!set.size) return null;
  if ([...set].every((t) => t === 'mcq')) return 'mcq';
  if (set.has('mcq')) return 'mixed';
  return 'subjective';
}

async function main() {
  const db = getDb();
  console.log(`${migrationId}: ${apply ? 'APPLY' : 'DRY RUN'}`);
  if (apply && (await alreadyApplied(db, migrationId))) return console.log('Already applied; no changes made.');
  const ts = now();
  const statements = [];
  const flags = { date_confirm: [], type_confirm: [], subject_created: [], orphan_buckets: [], orphan_skipped: [] };

  const resolver = loadSchoolResolver ? await loadSchoolResolver(db) : null;
  const schoolDisplay = new Map(resolver.all.map((s) => [s.id, s.display_name]));
  const yearRows = (await db.execute('SELECT id, school_id, label, is_current FROM academic_years')).rows;
  const currentYearBySchool = new Map(yearRows.filter((r) => Number(r.is_current) === 1).map((r) => [r.school_id, r.id]));
  const subjectRows = (await db.execute("SELECT id, school_id, name FROM subjects WHERE status = 'active'")).rows;
  const subjectBySchoolKey = new Map(subjectRows.map((r) => [`${r.school_id}|${String(r.name).toLowerCase()}`, r.id]));
  const subjectNameById = new Map(subjectRows.map((r) => [r.id, r.name]));
  const subjectFor = (schoolId, rawName) => {
    const parsed = parseSubjectAndSet(rawName);
    if (!parsed || !schoolId) return null;
    const key = `${schoolId}|${parsed.key}`;
    let subjectId = subjectBySchoolKey.get(key);
    if (!subjectId) {
      subjectId = id('sub');
      subjectBySchoolKey.set(key, subjectId);
      subjectNameById.set(subjectId, parsed.display);
      statements.push({ sql: "INSERT INTO subjects (id, school_id, name, code, status, created_at, updated_at) VALUES (?, ?, ?, NULL, 'active', ?, ?)", args: [subjectId, schoolId, parsed.display, ts, ts] });
      flags.subject_created.push(`${schoolDisplay.get(schoolId) || schoolId}: ${parsed.display}`);
    }
    return subjectId;
  };

  const upsertSetQuestions = (setId, questions) => {
    let added = 0;
    for (const q of questions) {
      if (!q || !q.question_number) continue;
      added += 1;
      statements.push({
        sql: `INSERT INTO exam_set_questions (id, set_id, question_number, question_text, answer_key_text, max_marks, rubric_json, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(set_id, question_number) DO UPDATE SET question_text = excluded.question_text, answer_key_text = excluded.answer_key_text,
                max_marks = excluded.max_marks, rubric_json = excluded.rubric_json, updated_at = excluded.updated_at`,
        args: [stableId('esq', `${setId}|${q.question_number}`), setId, String(q.question_number), q.question_text || null, q.answer_key_text || null, q.max_marks ?? null, q.rubric_json || null, ts, ts],
      });
    }
    return added;
  };

  // ---------- 1-4. Real tests -> exams / exam_batches / exam_sets / exam_set_questions
  const tests = (await db.execute('SELECT id, school, school_id, title, subject, status, created_by, created_at, updated_at FROM tests')).rows;
  const rubricRows = (await db.execute('SELECT test_id, question_map_json FROM exam_rubric_versions WHERE is_active = 1 AND question_map_json IS NOT NULL')).rows;
  const rubricByTest = new Map(rubricRows.map((r) => [r.test_id, r.question_map_json]));
  const assetRows = (await db.execute(`SELECT test_id, kind, id, created_at FROM file_assets WHERE kind IN ('question_paper', 'answer_key') ORDER BY created_at DESC`)).rows;
  const assetByTestKind = new Map();
  for (const row of assetRows) {
    const key = `${row.test_id}|${row.kind}`;
    if (!assetByTestKind.has(key)) assetByTestKind.set(key, row.id); // latest first
  }
  const firstQuestions = (await db.execute(`
    SELECT sq.submission_id, sq.question_number, sq.question_text, sq.answer_key_text, sq.marks_total, sq.rubric_json, ts.test_id
    FROM submission_questions sq JOIN test_submissions ts ON ts.id = sq.submission_id
    ORDER BY ts.created_at, sq.id`)).rows;
  const questionsByTest = new Map();
  for (const row of firstQuestions) {
    if (!questionsByTest.has(row.test_id)) questionsByTest.set(row.test_id, new Map());
    const perTest = questionsByTest.get(row.test_id);
    if (!perTest.has(row.question_number)) perTest.set(row.question_number, row);
  }

  let examsFromTests = 0;
  let setQuestionsFromRubrics = 0;
  let setQuestionsFromSubmissions = 0;
  for (const test of tests) {
    const schoolId = test.school_id || resolver.resolve(test.school);
    if (!schoolId) { flags.orphan_skipped.push(`test ${test.id}: school unresolved (${test.school})`); continue; }
    const subjectId = subjectFor(schoolId, test.subject);
    const yearId = currentYearBySchool.get(schoolId);
    if (!subjectId || !yearId) { flags.orphan_skipped.push(`test ${test.id}: subject/year unresolved`); continue; }
    const examId = stableId('exam', `test|${test.id}`);
    const created = new Date(test.created_at);
    const parsedDate = parseDateText(test.title, created);
    const examDate = parsedDate ? parsedDate.date : test.created_at.slice(0, 10);
    if (!parsedDate) flags.date_confirm.push(`${test.title || test.id} (${schoolDisplay.get(schoolId)}): date defaulted to created_at ${examDate}`);

    let examType = null;
    let rubricQuestions = [];
    if (rubricByTest.has(test.id)) {
      try {
        const map = JSON.parse(rubricByTest.get(test.id));
        rubricQuestions = Array.isArray(map.questions) ? map.questions : [];
        examType = examTypeFromResponseTypes(rubricQuestions.map((q) => q.expected_response_type));
      } catch { /* malformed rubric json */ }
    }
    if (!examType) {
      examType = 'subjective';
      flags.type_confirm.push(`${test.title || test.id} (${schoolDisplay.get(schoolId)}): type defaulted to subjective`);
    }

    examsFromTests += 1;
    statements.push({
      sql: `INSERT INTO exams (id, school_id, subject_id, academic_year_id, name, exam_date, exam_type, status, source_test_id, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET school_id = excluded.school_id, subject_id = excluded.subject_id, academic_year_id = excluded.academic_year_id,
              name = excluded.name, exam_date = excluded.exam_date, exam_type = excluded.exam_type, status = excluded.status, updated_at = excluded.updated_at`,
      args: [examId, schoolId, subjectId, yearId, test.title, examDate, examType, STATUS_MAP.get(test.status) || 'draft', test.id, test.created_by || null, test.created_at, ts],
    });
    const setId = stableId('set', `${examId}|A`);
    statements.push({
      sql: `INSERT INTO exam_sets (id, exam_id, set_code, question_paper_asset_id, answer_key_asset_id, status, created_at, updated_at)
            VALUES (?, ?, 'A', ?, ?, 'active', ?, ?)
            ON CONFLICT(exam_id, set_code) DO UPDATE SET question_paper_asset_id = excluded.question_paper_asset_id,
              answer_key_asset_id = excluded.answer_key_asset_id, updated_at = excluded.updated_at`,
      args: [setId, examId, assetByTestKind.get(`${test.id}|question_paper`) || null, assetByTestKind.get(`${test.id}|answer_key`) || null, ts, ts],
    });
    if (rubricQuestions.length) {
      setQuestionsFromRubrics += upsertSetQuestions(setId, rubricQuestions.map((q) => ({
        question_number: q.number,
        question_text: q.question_text,
        answer_key_text: q.correct_answer_summary || q.answer_key_evidence || null,
        max_marks: q.marks_allocated ?? null,
        rubric_json: JSON.stringify(q),
      })));
    } else {
      const perTest = questionsByTest.get(test.id);
      if (perTest) {
        setQuestionsFromSubmissions += upsertSetQuestions(setId, [...perTest.values()].map((q) => ({
          question_number: q.question_number,
          question_text: q.question_text,
          answer_key_text: q.answer_key_text,
          max_marks: q.marks_total,
          rubric_json: q.rubric_json,
        })));
      }
    }
  }
  const testBatchRows = (await db.execute('SELECT test_id, batch_id, created_at FROM test_batches')).rows;
  let examBatches = 0;
  for (const row of testBatchRows) {
    examBatches += 1;
    statements.push({
      sql: 'INSERT INTO exam_batches (exam_id, batch_id, created_at) VALUES (?, ?, ?) ON CONFLICT(exam_id, batch_id) DO NOTHING',
      args: [stableId('exam', `test|${row.test_id}`), row.batch_id, row.created_at || ts],
    });
  }

  // ---------- 5. Synthetic legacy exams for orphan submissions
  const orphanSubs = (await db.execute(`
    SELECT ts.id, ts.test_id, ts.student_id, ts.created_at
    FROM test_submissions ts LEFT JOIN tests t ON t.id = ts.test_id WHERE t.id IS NULL`)).rows;
  const orphanIds = orphanSubs.map((s) => s.id);
  const contextBySubmission = new Map();
  if (orphanIds.length) {
    const ph = orphanIds.map(() => '?').join(',');
    const sqContext = (await db.execute({
      sql: `SELECT submission_id, school, subject, COUNT(*) n FROM submission_questions
            WHERE submission_id IN (${ph}) AND subject IS NOT NULL AND TRIM(subject) != ''
            GROUP BY submission_id, school, subject ORDER BY submission_id, n DESC`,
      args: orphanIds,
    })).rows;
    for (const row of sqContext) {
      if (!contextBySubmission.has(row.submission_id)) contextBySubmission.set(row.submission_id, { school: row.school, subject: row.subject });
    }
    const reports = (await db.execute({
      sql: `SELECT submission_id, username, school, payload_json FROM report_versions
            WHERE submission_id IN (${ph}) AND status = 'published' ORDER BY version DESC`,
      args: orphanIds,
    })).rows;
    for (const row of reports) {
      if (contextBySubmission.has(row.submission_id) && contextBySubmission.get(row.submission_id).grade) continue;
      const ctx = contextBySubmission.get(row.submission_id) || { school: row.school, subject: null };
      try {
        const payload = JSON.parse(row.payload_json);
        ctx.grade = String(payload.student?.class || '').trim() || null;
        const exams = Array.isArray(payload.exams) ? payload.exams : [];
        ctx.dateText = exams[0]?.date || null;
        if (!ctx.subject) ctx.subject = payload.term1?.subjects?.[0]?.name || null;
      } catch { /* malformed payload */ }
      contextBySubmission.set(row.submission_id, ctx);
    }
  }

  const bucketByKey = new Map();
  for (const sub of orphanSubs) {
    const ctx = contextBySubmission.get(sub.id) || {};
    const schoolId = resolver.resolve(ctx.school);
    if (!schoolId) { flags.orphan_skipped.push(`${sub.id}: school unresolved (${ctx.school || 'unknown'})`); continue; }
    const subjectId = subjectFor(schoolId, ctx.subject);
    if (!subjectId) { flags.orphan_skipped.push(`${sub.id}: subject unresolved (${ctx.subject || 'unknown'})`); continue; }
    let grade = ctx.grade || null;
    if (!grade) {
      const prefix = String(sub.student_id || '').match(/^(\d{1,2}(?:th|st|nd|rd))/i);
      grade = prefix ? prefix[1].toLowerCase() : null;
    }
    const created = new Date(sub.created_at);
    const parsed = parseDateText(ctx.dateText, created);
    const month = parsed ? parsed.month : sub.created_at.slice(0, 7);
    const examDate = parsed ? parsed.date : `${month}-01`;
    const bucketKey = `${schoolId}|${subjectId}|${grade || ''}|${month}`;
    if (!bucketByKey.has(bucketKey)) bucketByKey.set(bucketKey, { schoolId, subjectId, grade, month, examDate, submissions: [] });
    bucketByKey.get(bucketKey).submissions.push(sub);
  }

  let syntheticExams = 0;
  for (const [bucketKey, bucket] of bucketByKey) {
    const yearId = currentYearBySchool.get(bucket.schoolId);
    if (!yearId) { flags.orphan_skipped.push(`bucket ${bucketKey}: no academic year`); continue; }
    const examId = stableId('exam', `legacy|${bucketKey}`);
    const schoolName = schoolDisplay.get(bucket.schoolId) || bucket.schoolId;
    const subjectName = subjectNameById.get(bucket.subjectId) || 'Unknown';
    const monthLabel = `${MONTHS[Number(bucket.month.slice(5, 7)) - 1].replace(/^./, (c) => c.toUpperCase())} ${bucket.month.slice(0, 4)}`;
    const name = `${schoolName} ${bucket.grade ? `${bucket.grade} ` : ''}${subjectName} (legacy ${monthLabel})`;
    syntheticExams += 1;
    flags.orphan_buckets.push(`${name}: ${bucket.submissions.length} submissions`);
    flags.type_confirm.push(`${name}: synthetic legacy exam defaulted to subjective`);
    flags.date_confirm.push(`${name}: date defaulted to ${bucket.examDate}`);
    statements.push({
      sql: `INSERT INTO exams (id, school_id, subject_id, academic_year_id, name, exam_date, exam_type, status, source_test_id, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 'subjective', 'archived', NULL, 'legacy_backfill', ?, ?)
            ON CONFLICT(id) DO UPDATE SET school_id = excluded.school_id, subject_id = excluded.subject_id, academic_year_id = excluded.academic_year_id,
              name = excluded.name, exam_date = excluded.exam_date, status = excluded.status, updated_at = excluded.updated_at`,
      args: [examId, bucket.schoolId, bucket.subjectId, yearId, name, bucket.examDate, bucket.submissions[0].created_at, ts],
    });
    const setId = stableId('set', `${examId}|A`);
    statements.push({
      sql: `INSERT INTO exam_sets (id, exam_id, set_code, question_paper_asset_id, answer_key_asset_id, status, created_at, updated_at)
            VALUES (?, ?, 'A', NULL, NULL, 'active', ?, ?)
            ON CONFLICT(exam_id, set_code) DO UPDATE SET updated_at = excluded.updated_at`,
      args: [setId, examId, ts, ts],
    });
    // Set questions: first submission's rows per question_number within this bucket.
    const bucketTestIds = [...new Set(bucket.submissions.map((s) => s.test_id))];
    const perQuestion = new Map();
    for (const testId of bucketTestIds) {
      const perTest = questionsByTest.get(testId);
      if (!perTest) continue;
      for (const [questionNumber, row] of perTest) if (!perQuestion.has(questionNumber)) perQuestion.set(questionNumber, row);
    }
    setQuestionsFromSubmissions += upsertSetQuestions(setId, [...perQuestion.values()].map((q) => ({
      question_number: q.question_number,
      question_text: q.question_text,
      answer_key_text: q.answer_key_text,
      max_marks: q.marks_total,
      rubric_json: q.rubric_json,
    })));
  }

  const summary = { examsFromTests, examBatches, syntheticExams, setQuestionsFromRubrics, setQuestionsFromSubmissions, statements: statements.length };
  console.log(JSON.stringify(summary, null, 2));
  if (flags.orphan_buckets.length) console.log(`Legacy buckets:\n  ${flags.orphan_buckets.join('\n  ')}`);
  if (flags.date_confirm.length) console.log(`Date confirm list:\n  ${flags.date_confirm.join('\n  ')}`);
  if (flags.type_confirm.length) console.log(`Type confirm list:\n  ${flags.type_confirm.join('\n  ')}`);
  if (flags.subject_created.length) console.log(`Subjects created:\n  ${flags.subject_created.join('\n  ')}`);
  if (flags.orphan_skipped.length) console.log(`Skipped:\n  ${flags.orphan_skipped.join('\n  ')}`);
  if (!apply) return;

  const CHUNK = 400;
  for (let i = 0; i < statements.length; i += CHUNK) await db.batch(statements.slice(i, i + CHUNK), 'write');
  const reportDir = path.resolve(__dirname, '..', '..', 'execution', 'migration_reports');
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, '026_flags.json'), `${JSON.stringify({ generated_at: ts, ...flags }, null, 2)}\n`);
  await markApplied(db, migrationId, [`exams:${examsFromTests}+${syntheticExams}`, `set_questions:${setQuestionsFromRubrics}+${setQuestionsFromSubmissions}`]);
  console.log(`Applied ${migrationId}.`);
}

main().catch((error) => { console.error(`${migrationId} failed: ${error.message}`); process.exitCode = 1; });
