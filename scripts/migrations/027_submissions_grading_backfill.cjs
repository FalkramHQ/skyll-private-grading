#!/usr/bin/env node

/* Phase 4: submissions & grading backfill —
 *   1. submissions <- test_submissions (id preserved; exam via tests or the same legacy
 *      bucket derivation as 026; set = the exam's default 'A' set; batch snapshot from
 *      test_submissions.batch_id else test_students.batch_id)
 *   2. submission_questions_v2: grading rows rekeyed to exam_set_questions (question
 *      text/rubric now lives once per set). Rows keep their legacy ids so
 *      review_decisions / revisions / rechecks keep pointing at them. A question_number
 *      shared by multiple subjects inside one submission (the multi-subject PartnerI
 *      legacy paper) is disambiguated with the subject-qualified legacy question_id.
 *   3. question_reviews <- review_decisions (revision-preserving, columns align 1:1)
 *   4. file_assets.submission_id backfill for answer_sheet assets (via test_students)
 *   5. parity self-check after apply: per-submission question counts and marks sums
 *      must match the legacy tables exactly.
 *
 * Idempotent: deterministic ids + upserts; safe to re-run.
 *
 *   node scripts/migrations/027_submissions_grading_backfill.cjs --dry-run
 *   node scripts/migrations/027_submissions_grading_backfill.cjs --apply
 */
const { getDb, now, stableId, loadSchoolResolver, parseSubjectAndSet, alreadyApplied, markApplied } = require('./_lib.cjs');

const migrationId = '027_submissions_grading_backfill';
const apply = process.argv.includes('--apply');

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const pad = (n) => String(n).padStart(2, '0');

/* Exact copy of 026's parser — the legacy bucket derivation must stay bit-identical. */
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

const CREATE_V2 = [
  `CREATE TABLE IF NOT EXISTS submission_questions_v2 (
    id TEXT PRIMARY KEY,
    submission_id TEXT NOT NULL,
    exam_set_question_id TEXT NOT NULL,
    question_number TEXT NOT NULL,
    ai_marks REAL,
    approved_marks REAL,
    status TEXT NOT NULL,
    review_revision INTEGER NOT NULL DEFAULT 0,
    regraded_revision INTEGER NOT NULL DEFAULT 0,
    evidence_json TEXT NOT NULL,
    source_asset_ids_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(submission_id, exam_set_question_id)
  )`,
  'CREATE INDEX IF NOT EXISTS submission_questions_v2_submission_idx ON submission_questions_v2 (submission_id, question_number)',
  'CREATE INDEX IF NOT EXISTS submission_questions_v2_set_question_idx ON submission_questions_v2 (exam_set_question_id)',
  'CREATE INDEX IF NOT EXISTS submission_questions_v2_status_idx ON submission_questions_v2 (status)',
];

async function main() {
  const db = getDb();
  console.log(`${migrationId}: ${apply ? 'APPLY' : 'DRY RUN'}`);
  if (apply && (await alreadyApplied(db, migrationId))) return console.log('Already applied; no changes made.');
  const ts = now();
  const statements = [];
  const flags = { missing_exam: [], missing_esq_created: 0, review_orphans: 0, asset_unmatched: 0 };

  // ---------- exam/set maps for real tests
  const examRows = (await db.execute('SELECT id, source_test_id FROM exams')).rows;
  const examByTestId = new Map(examRows.filter((r) => r.source_test_id).map((r) => [r.source_test_id, r.id]));
  const examIds = new Set(examRows.map((r) => r.id));
  const setRows = (await db.execute("SELECT id, exam_id FROM exam_sets WHERE set_code = 'A' AND status = 'active'")).rows;
  const defaultSetByExam = new Map(setRows.map((r) => [r.exam_id, r.id]));

  // ---------- legacy orphan submission -> synthetic exam mapping (mirrors 026 exactly)
  const resolver = await loadSchoolResolver(db);
  const subjectRows = (await db.execute("SELECT id, school_id, name FROM subjects WHERE status = 'active'")).rows;
  const subjectBySchoolKey = new Map(subjectRows.map((r) => [`${r.school_id}|${String(r.name).toLowerCase()}`, r.id]));
  const subjectFor = (schoolId, rawName) => {
    const parsed = parseSubjectAndSet(rawName);
    if (!parsed || !schoolId) return null;
    return subjectBySchoolKey.get(`${schoolId}|${parsed.key}`) || null;
  };

  const orphanSubs = (await db.execute(`
    SELECT ts.id, ts.test_id, ts.student_id, ts.created_at
    FROM test_submissions ts LEFT JOIN tests t ON t.id = ts.test_id WHERE t.id IS NULL`)).rows;
  const orphanExamBySubmission = new Map();
  if (orphanSubs.length) {
    const orphanIds = orphanSubs.map((s) => s.id);
    const ph = orphanIds.map(() => '?').join(',');
    const contextBySubmission = new Map();
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
      sql: `SELECT submission_id, payload_json FROM report_versions
            WHERE submission_id IN (${ph}) AND status = 'published' ORDER BY version DESC`,
      args: orphanIds,
    })).rows;
    for (const row of reports) {
      if (contextBySubmission.has(row.submission_id) && contextBySubmission.get(row.submission_id).grade) continue;
      const ctx = contextBySubmission.get(row.submission_id) || { school: null, subject: null };
      try {
        const payload = JSON.parse(row.payload_json);
        ctx.grade = String(payload.student?.class || '').trim() || null;
        const payloadExams = Array.isArray(payload.exams) ? payload.exams : [];
        ctx.dateText = payloadExams[0]?.date || null;
        if (!ctx.subject) ctx.subject = payload.term1?.subjects?.[0]?.name || null;
        if (!ctx.school) ctx.school = payload.student?.school || null;
      } catch { /* malformed payload */ }
      contextBySubmission.set(row.submission_id, ctx);
    }
    for (const sub of orphanSubs) {
      const ctx = contextBySubmission.get(sub.id) || {};
      const schoolId = resolver.resolve(ctx.school);
      const subjectId = subjectFor(schoolId, ctx.subject);
      if (!schoolId || !subjectId) { flags.missing_exam.push(`${sub.id}: context unresolved`); continue; }
      let grade = ctx.grade || null;
      if (!grade) {
        const prefix = String(sub.student_id || '').match(/^(\d{1,2}(?:th|st|nd|rd))/i);
        grade = prefix ? prefix[1].toLowerCase() : null;
      }
      const parsed = parseDateText(ctx.dateText, new Date(sub.created_at));
      const month = parsed ? parsed.month : sub.created_at.slice(0, 7);
      const examId = stableId('exam', `legacy|${`${schoolId}|${subjectId}|${grade || ''}|${month}`}`);
      if (!examIds.has(examId)) { flags.missing_exam.push(`${sub.id}: synthetic exam ${examId} not found`); continue; }
      orphanExamBySubmission.set(sub.id, examId);
    }
  }

  // ---------- 1. submissions <- test_submissions
  const testStudentRows = (await db.execute('SELECT test_id, student_id, batch_id FROM test_students')).rows;
  const batchByTestStudent = new Map(testStudentRows.map((r) => [`${r.test_id}|${r.student_id}`, r.batch_id]));
  const allSubs = (await db.execute('SELECT * FROM test_submissions')).rows;
  let submissionsMapped = 0;
  for (const sub of allSubs) {
    const examId = examByTestId.get(sub.test_id) || orphanExamBySubmission.get(sub.id);
    if (!examId) { flags.missing_exam.push(`${sub.id} (test ${sub.test_id})`); continue; }
    const setId = defaultSetByExam.get(examId) || null;
    const batchSnapshot = sub.batch_id || batchByTestStudent.get(`${sub.test_id}|${sub.student_id}`) || null;
    submissionsMapped += 1;
    statements.push({
      sql: `INSERT INTO submissions (id, exam_id, set_id, student_id, batch_id_snapshot, status, active_asset_revision,
              current_workflow_run_id, score, max_marks, review_status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET exam_id = excluded.exam_id, set_id = excluded.set_id, student_id = excluded.student_id,
              batch_id_snapshot = excluded.batch_id_snapshot, status = excluded.status, active_asset_revision = excluded.active_asset_revision,
              current_workflow_run_id = excluded.current_workflow_run_id, score = excluded.score, max_marks = excluded.max_marks,
              review_status = excluded.review_status, updated_at = excluded.updated_at`,
      args: [sub.id, examId, setId, sub.student_id, batchSnapshot, sub.status, sub.active_asset_revision ?? 1,
        sub.current_workflow_run_id || null, sub.score ?? null, sub.max_marks ?? null, sub.review_status || 'pending', sub.created_at, ts],
    });
  }

  // ---------- 2. submission_questions_v2 + missing exam_set_questions
  const examBySubmission = new Map();
  for (const sub of allSubs) {
    const examId = examByTestId.get(sub.test_id) || orphanExamBySubmission.get(sub.id);
    if (examId) examBySubmission.set(sub.id, examId);
  }
  const existingEsq = new Set((await db.execute('SELECT set_id, question_number FROM exam_set_questions')).rows.map((r) => `${r.set_id}|${r.question_number}`));
  const sqRows = (await db.execute('SELECT * FROM submission_questions ORDER BY submission_id, question_number, id')).rows;
  const groupCount = new Map();
  for (const row of sqRows) {
    const key = `${row.submission_id}|${row.question_number}`;
    groupCount.set(key, (groupCount.get(key) || 0) + 1);
  }
  let v2Mapped = 0;
  let v2Skipped = 0;
  for (const row of sqRows) {
    const examId = examBySubmission.get(row.submission_id);
    if (!examId) { v2Skipped += 1; continue; }
    const setId = defaultSetByExam.get(examId);
    if (!setId) { v2Skipped += 1; continue; }
    const ambiguous = groupCount.get(`${row.submission_id}|${row.question_number}`) > 1;
    const effectiveNumber = ambiguous ? String(row.question_id) : String(row.question_number);
    const esqId = stableId('esq', `${setId}|${effectiveNumber}`);
    if (!existingEsq.has(`${setId}|${effectiveNumber}`)) {
      existingEsq.add(`${setId}|${effectiveNumber}`);
      flags.missing_esq_created += 1;
      statements.push({
        sql: `INSERT INTO exam_set_questions (id, set_id, question_number, question_text, answer_key_text, max_marks, rubric_json, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(set_id, question_number) DO NOTHING`,
        args: [esqId, setId, effectiveNumber, row.question_text || null, row.answer_key_text || null, row.marks_total ?? null, row.rubric_json || null, ts, ts],
      });
    }
    v2Mapped += 1;
    statements.push({
      sql: `INSERT INTO submission_questions_v2 (id, submission_id, exam_set_question_id, question_number, ai_marks, approved_marks,
              status, review_revision, regraded_revision, evidence_json, source_asset_ids_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET submission_id = excluded.submission_id, exam_set_question_id = excluded.exam_set_question_id,
              question_number = excluded.question_number, ai_marks = excluded.ai_marks, approved_marks = excluded.approved_marks,
              status = excluded.status, review_revision = excluded.review_revision, regraded_revision = excluded.regraded_revision,
              evidence_json = excluded.evidence_json, source_asset_ids_json = excluded.source_asset_ids_json, updated_at = excluded.updated_at`,
      args: [row.id, row.submission_id, esqId, effectiveNumber, row.ai_marks ?? null, row.approved_marks ?? null,
        row.status, row.review_revision ?? 0, row.regraded_revision ?? 0, row.evidence_json, row.source_asset_ids_json, row.created_at, ts],
    });
  }

  // ---------- 3. question_reviews <- review_decisions
  // Fold ALL review_decisions in (plan §2) — 2,876 reference question rows replaced by
  // later regrade runs; they stay as historical review state keyed by their legacy id.
  const decisionRows = (await db.execute('SELECT * FROM review_decisions')).rows;
  const sqIdSet = new Set(sqRows.map((r) => r.id));
  let reviewsMapped = 0;
  for (const row of decisionRows) {
    if (!sqIdSet.has(row.submission_question_id)) flags.review_orphans += 1;
    reviewsMapped += 1;
    statements.push({
      sql: `INSERT INTO question_reviews (submission_question_id, state, corrected_answer, approved_marks, reviewer_id, reason, revision, approved_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(submission_question_id) DO UPDATE SET state = excluded.state, corrected_answer = excluded.corrected_answer,
              approved_marks = excluded.approved_marks, reviewer_id = excluded.reviewer_id, reason = excluded.reason,
              revision = excluded.revision, approved_at = excluded.approved_at, updated_at = excluded.updated_at`,
      args: [row.submission_question_id, row.state, row.corrected_answer ?? null, row.approved_marks ?? null,
        row.reviewer_id || null, row.reason || null, row.revision ?? 0, row.approved_at || null, row.updated_at],
    });
  }

  // ---------- 4. file_assets.submission_id for answer sheets
  const assetRows = (await db.execute(`
    SELECT fa.id AS asset_id, ts2.id AS submission_id
    FROM file_assets fa
    JOIN test_students s ON s.id = fa.test_student_id AND s.test_id = fa.test_id
    JOIN test_submissions ts2 ON ts2.test_id = fa.test_id AND ts2.student_id = s.student_id
    WHERE fa.kind = 'answer_sheet' AND fa.submission_id IS NULL`)).rows;
  const assetTotal = (await db.execute("SELECT COUNT(*) n FROM file_assets WHERE kind = 'answer_sheet'")).rows[0].n;
  for (const row of assetRows) {
    statements.push({ sql: 'UPDATE file_assets SET submission_id = ? WHERE id = ?', args: [row.submission_id, row.asset_id] });
  }
  flags.asset_unmatched = Number(assetTotal) - assetRows.length;

  const summary = {
    submissions: submissionsMapped,
    submissionQuestionsV2: v2Mapped,
    v2Skipped,
    missingEsqCreated: flags.missing_esq_created,
    questionReviews: reviewsMapped,
    reviewOrphans: flags.review_orphans,
    assetLinks: assetRows.length,
    assetUnmatched: flags.asset_unmatched,
    missingExam: flags.missing_exam.length,
    statements: statements.length,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (flags.missing_exam.length) console.log(`Missing exams:\n  ${flags.missing_exam.slice(0, 20).join('\n  ')}`);
  if (!apply) return;

  await db.batch(CREATE_V2.map((sql) => ({ sql })), 'write');
  const CHUNK = 400;
  for (let i = 0; i < statements.length; i += CHUNK) await db.batch(statements.slice(i, i + CHUNK), 'write');

  // ---------- 5. parity self-check: per-submission question counts + marks sums must match exactly
  const legacyAgg = (await db.execute(`
    SELECT submission_id, COUNT(*) n, ROUND(COALESCE(SUM(ai_marks), 0), 4) ai, ROUND(COALESCE(SUM(approved_marks), 0), 4) ap
    FROM submission_questions GROUP BY submission_id`)).rows;
  const newAgg = new Map((await db.execute(`
    SELECT submission_id, COUNT(*) n, ROUND(COALESCE(SUM(ai_marks), 0), 4) ai, ROUND(COALESCE(SUM(approved_marks), 0), 4) ap
    FROM submission_questions_v2 GROUP BY submission_id`)).rows.map((r) => [r.submission_id, r]));
  let mismatches = 0;
  for (const row of legacyAgg) {
    const next = newAgg.get(row.submission_id);
    if (!next || Number(next.n) !== Number(row.n) || Number(next.ai) !== Number(row.ai) || Number(next.ap) !== Number(row.ap)) {
      mismatches += 1;
      if (mismatches <= 10) console.log(`PARITY MISMATCH ${row.submission_id}: legacy ${JSON.stringify(row)} vs v2 ${JSON.stringify(next || null)}`);
    }
  }
  const subCount = (await db.execute('SELECT (SELECT COUNT(*) FROM test_submissions) legacy, (SELECT COUNT(*) FROM submissions) canonical')).rows[0];
  const reviewCount = (await db.execute('SELECT (SELECT COUNT(*) FROM review_decisions) legacy, (SELECT COUNT(*) FROM question_reviews) canonical')).rows[0];
  console.log(`PARITY: submissions ${subCount.legacy}->${subCount.canonical}, reviews ${reviewCount.legacy}->${reviewCount.canonical}, question mismatches ${mismatches}/${legacyAgg.length}`);
  if (mismatches || Number(subCount.legacy) !== Number(subCount.canonical) || Number(reviewCount.legacy) !== Number(reviewCount.canonical)) {
    throw new Error('Parity check failed — investigate before proceeding.');
  }
  await markApplied(db, migrationId, [`submissions:${submissionsMapped}`, `v2:${v2Mapped}`, `reviews:${reviewsMapped}`, `assets:${assetRows.length}`]);
  console.log(`Applied ${migrationId}. PARITY OK.`);
}

main().catch((error) => { console.error(`${migrationId} failed: ${error.message}`); process.exitCode = 1; });
