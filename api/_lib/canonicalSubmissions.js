/* Phase 4→7 canonical mirrors: worker still writes legacy grading tables first,
 * then mirrors into submissions / submission_questions_v2 / question_reviews.
 * Review/API surfaces are canonical-first. Mirror failures on grade/report paths
 * must fail the job (see requireMirror) so canonical never silently drifts. */
import { examRowId } from './exams.js';

export function logMirrorFailure(scope, error) {
  console.warn(JSON.stringify({ event: 'canonical_mirror_failed', scope, error: String(error?.message || error) }));
}

/** Log and rethrow — use on grading / report paths where silent drift is unsafe. */
export async function requireMirror(scope, promise) {
  try {
    return await promise;
  } catch (error) {
    logMirrorFailure(scope, error);
    throw error;
  }
}

// Cache the loading promise, not just its result: a cold instance serving a
// large review queue resolves many names at once, and each of those calls must
// share one `SELECT ... FROM schools` instead of issuing its own.
let schoolMapPromise = null;
let schoolMapLoadedAt = 0;
const SCHOOL_MAP_REFRESH_MS = 30_000;
export function resetSchoolCache() { schoolMapPromise = null; schoolMapLoadedAt = 0; }

function schoolMap(db) {
  if (!schoolMapPromise) {
    const loading = loadSchoolMap(db);
    schoolMapPromise = loading;
    // A failed load must not be cached; the next caller retries it.
    loading.catch(() => { if (schoolMapPromise === loading) schoolMapPromise = null; });
  }
  return schoolMapPromise;
}

async function loadSchoolMap(db) {
  const rows = (await db.execute('SELECT id, slug, display_name FROM schools')).rows;
  const alnum = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  // A key shared by two schools (e.g. "St. Mary's" and "St Marys", or one
  // school's name equal to another's slug) is ambiguous. It resolves to no
  // school rather than whichever row happened to load last (FLKRM-385).
  const owners = new Map();
  const claim = (key, id) => { if (key) (owners.get(key) || owners.set(key, new Set()).get(key)).add(id); };
  for (const row of rows) {
    for (const raw of [row.display_name, row.slug]) {
      claim(String(raw || '').trim().toLowerCase(), row.id);
      claim(alnum(raw), row.id);
    }
  }
  const byKey = new Map();
  for (const [key, ids] of owners) byKey.set(key, ids.size === 1 ? [...ids][0] : null);
  // Historical aliases seen in legacy grading rows.
  const partnerbId = byKey.get("Partner Academy B") || byKey.get('partner-academy-b');
  if (partnerbId) for (const name of ['partner-academy-b', 'Partner Academy B', 'Partner Academy B']) byKey.set(name, partnerbId);
  const skyllId = byKey.get('skyll');
  if (skyllId) for (const name of ['skyll academy', 'skyll internal', 'skyllacademy', 'skyllinternal']) byKey.set(name, skyllId);
  schoolMapLoadedAt = Date.now();
  return { rows, byKey };
}

/* Resolve any historical school string ("Partner Academy B", "Skyll Academy", slug,
 * display name) to schools.id. */
export async function resolveSchoolId(db, schoolName) {
  const key = String(schoolName || '').trim().toLowerCase();
  if (!key) return null;
  const lookup = ({ byKey }) => {
    // An exact match decides, even if ambiguous (null); otherwise fall back to
    // the punctuation-insensitive form.
    if (byKey.has(key)) return byKey.get(key);
    const squashed = key.replace(/[^a-z0-9]/g, '');
    return byKey.has(squashed) ? byKey.get(squashed) : undefined;
  };
  const loaded = schoolMap(db);
  let found = lookup(await loaded);
  // The map is cached per instance; a school provisioned since it loaded would
  // be unknown here and, since this now gates access, wrongly denied. Reload on
  // a miss, at most every 30s so unknown names cannot hammer the database.
  if (found === undefined && Date.now() - schoolMapLoadedAt > SCHOOL_MAP_REFRESH_MS) {
    // Concurrent misses on the same stale map share the first one's reload.
    if (schoolMapPromise === loaded) resetSchoolCache();
    found = lookup(await schoolMap(db));
  }
  return found || null;
}

/* Canonical exam (+ default set) for a legacy intake test. */
export async function examForTest(db, testId) {
  const result = await db.execute({
    sql: `SELECT e.id AS exam_id,
                 (SELECT s.id FROM exam_sets s WHERE s.exam_id = e.id ORDER BY s.set_code LIMIT 1) AS set_id
          FROM exams e WHERE e.source_test_id = ? LIMIT 1`,
    args: [testId],
  });
  const row = result.rows[0];
  return row ? { examId: row.exam_id, setId: row.set_id } : null;
}

/* Mirror one legacy test_submissions row into canonical submissions and link
 * its answer-sheet file assets. Returns the exam mapping or null when the
 * test predates the canonical exam cutover.
 *
 * graded_at is when the paper became billable: its earliest report version
 * (every question graded, max_marks known). Set once and never overwritten,
 * so regrades, reviews and rebuilt reports keep the original invoice month
 * (FLKRM-484). No report yet keeps it NULL. */
export async function syncCanonicalSubmission(db, submissionId, at = new Date().toISOString()) {
  const legacy = await db.execute({ sql: 'SELECT * FROM test_submissions WHERE id = ?', args: [submissionId] });
  const row = legacy.rows[0];
  if (!row) return null;
  const exam = await examForTest(db, row.test_id);
  if (!exam?.setId) return null;
  await db.batch([
    {
      sql: `INSERT INTO submissions (id, exam_id, set_id, student_id, batch_id_snapshot, status, score, max_marks, review_status, graded_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT MIN(generated_at) FROM report_versions WHERE submission_id = ?), ?, ?)
            ON CONFLICT(exam_id, student_id) DO UPDATE SET
              set_id = excluded.set_id,
              batch_id_snapshot = COALESCE(excluded.batch_id_snapshot, submissions.batch_id_snapshot),
              status = excluded.status, score = excluded.score, max_marks = excluded.max_marks,
              review_status = excluded.review_status,
              graded_at = COALESCE(submissions.graded_at, excluded.graded_at),
              updated_at = excluded.updated_at`,
      args: [row.id, exam.examId, exam.setId, row.student_id, row.batch_id || null, row.status,
        row.score ?? null, row.max_marks ?? null, row.review_status || 'pending', row.id, row.created_at || at, at],
    },
    {
      sql: `UPDATE file_assets SET submission_id = ?
            WHERE test_id = ? AND kind = 'answer_sheet' AND submission_id IS NULL
              AND test_student_id IN (SELECT id FROM test_students WHERE test_id = ? AND student_id = ?)`,
      args: [row.id, row.test_id, row.test_id, row.student_id],
    },
  ], 'write');
  return exam;
}

async function ensureSetQuestion(db, setId, number, seed, at) {
  const existing = await db.execute({
    sql: 'SELECT id FROM exam_set_questions WHERE set_id = ? AND question_number = ? LIMIT 1',
    args: [setId, number],
  });
  if (existing.rows.length) return existing.rows[0].id;
  const id = examRowId('esq');
  await db.execute({
    sql: `INSERT INTO exam_set_questions (id, set_id, question_number, question_text, answer_key_text, max_marks, rubric_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [id, setId, number, seed.questionText ?? null, seed.answerKey ?? null, seed.maxMarks ?? null, seed.rubricJson ?? null, at, at],
  });
  return id;
}

/* Upsert the parsed rubric into exam_set_questions: the paper lives once per
 * exam set instead of inside every submission question payload. */
export async function syncExamSetQuestionsFromRubric(db, { testId, rubric, at = new Date().toISOString() }) {
  const exam = await examForTest(db, testId);
  if (!exam?.setId) return 0;
  const numbers = [];
  let count = 0;
  for (const question of rubric?.questions || []) {
    const number = String(question.number || '').trim();
    if (!number) continue;
    numbers.push(number);
    await db.execute({
      sql: `INSERT INTO exam_set_questions (id, set_id, question_number, question_text, answer_key_text, max_marks, rubric_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(set_id, question_number) DO UPDATE SET
              question_text = excluded.question_text, answer_key_text = excluded.answer_key_text,
              max_marks = excluded.max_marks, rubric_json = excluded.rubric_json, updated_at = excluded.updated_at`,
      args: [examRowId('esq'), exam.setId, number, question.question_text ?? null,
        question.correct_answer_summary ?? null, question.marks_allocated ?? null, JSON.stringify(question), at, at],
    });
    count += 1;
  }
  // Alias rows (e.g. Q1i vs Q1.i) are not in the rubric map; drop them so grading
  // does not see duplicate question numbers for one paper.
  if (numbers.length) {
    const placeholders = numbers.map(() => '?').join(', ');
    await db.execute({
      sql: `DELETE FROM exam_set_questions WHERE set_id = ? AND question_number NOT IN (${placeholders})`,
      args: [exam.setId, ...numbers],
    });
  }
  return count;
}

/* Mirror one legacy submission_questions row into submission_questions_v2.
 * render_json carries the full review payload verbatim (render output);
 * filter/join fields live in real columns. */
export async function syncV2Question(db, questionId, at = new Date().toISOString()) {
  const result = await db.execute({
    sql: `SELECT q.*, s.test_id AS test_id FROM submission_questions q
          JOIN test_submissions s ON s.id = q.submission_id WHERE q.id = ? LIMIT 1`,
    args: [questionId],
  });
  const row = result.rows[0];
  if (!row) return null;
  const exam = await examForTest(db, row.test_id);
  if (!exam?.setId) return null;
  const legacyQuestionId = String(row.question_id || '');
  // Multi-subject papers repeat a question number per subject; keep the
  // subject-qualified legacy id in that case (matches migration 027).
  const number = legacyQuestionId.includes(':') ? legacyQuestionId : String(row.question_number || legacyQuestionId);
  const setQuestionId = await ensureSetQuestion(db, exam.setId, number, {
    questionText: row.question_text, answerKey: row.answer_key_text, maxMarks: row.marks_total, rubricJson: row.rubric_json,
  }, at);
  await db.execute({
    sql: `INSERT INTO submission_questions_v2 (id, submission_id, exam_set_question_id, question_number,
            ai_marks, approved_marks, status, review_revision, regraded_revision,
            evidence_json, source_asset_ids_json, render_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(submission_id, exam_set_question_id) DO UPDATE SET
            ai_marks = excluded.ai_marks, approved_marks = excluded.approved_marks, status = excluded.status,
            review_revision = excluded.review_revision, regraded_revision = excluded.regraded_revision,
            evidence_json = excluded.evidence_json, source_asset_ids_json = excluded.source_asset_ids_json,
            render_json = excluded.render_json, updated_at = excluded.updated_at`,
    args: [row.id, row.submission_id, setQuestionId, number, row.ai_marks ?? null, row.approved_marks ?? null,
      row.status, Number(row.review_revision || 0), Number(row.regraded_revision || 0),
      row.evidence_json || '{}', row.source_asset_ids_json || '[]', row.payload_json || '{}', row.created_at || at, at],
  });
  return { examId: exam.examId, setId: exam.setId, setQuestionId };
}

/* Mirror one review_decisions row into consolidated question_reviews. */
export async function syncQuestionReview(db, questionId, at = new Date().toISOString()) {
  const result = await db.execute({ sql: 'SELECT * FROM review_decisions WHERE submission_question_id = ?', args: [questionId] });
  const row = result.rows[0];
  if (!row) return null;
  await db.execute({
    sql: `INSERT INTO question_reviews (submission_question_id, state, approved_marks, reviewer_id, reason, revision, approved_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(submission_question_id) DO UPDATE SET
            state = excluded.state, approved_marks = excluded.approved_marks, reviewer_id = excluded.reviewer_id,
            reason = excluded.reason, revision = excluded.revision, approved_at = excluded.approved_at,
            updated_at = excluded.updated_at`,
    args: [row.submission_question_id, row.state, row.approved_marks ?? null, row.reviewer_id ?? null,
      row.reason ?? null, Number(row.revision || 0), row.approved_at ?? null, row.updated_at || at],
  });
  return true;
}

/* Bulk mirror for endpoints that approve many questions in one batch. */
export async function syncAllQuestionReviews(db) {
  await db.execute({
    sql: `INSERT INTO question_reviews (submission_question_id, state, approved_marks, reviewer_id, reason, revision, approved_at, updated_at)
          SELECT submission_question_id, state, approved_marks, reviewer_id, reason, revision, approved_at, updated_at
          FROM review_decisions
          ON CONFLICT(submission_question_id) DO UPDATE SET
            state = excluded.state, approved_marks = excluded.approved_marks, reviewer_id = excluded.reviewer_id,
            reason = excluded.reason, revision = excluded.revision, approved_at = excluded.approved_at,
            updated_at = excluded.updated_at`,
  });
  return true;
}

/* True once the canonical grading tables exist and carry data; false in
 * legacy-only test fixtures so callers keep the legacy read path there. */
export async function reviewQueueCanonicalReady(db) {
  try {
    const result = await db.execute('SELECT 1 AS ok FROM submission_questions_v2 LIMIT 1');
    return result.rows.length > 0;
  } catch {
    return false;
  }
}
