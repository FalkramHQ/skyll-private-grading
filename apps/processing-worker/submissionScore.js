import { applyScoringPlan } from './scoringPlan.js';
import { presentQuestionForReport } from './reportReadiness.js';

// A submission's total, recomputed from its question rows the way
// processReports builds it: the teacher's mark when there is one, else the AI
// mark; evidence-blocked questions count as zero; the active rubric's choice
// rules decide which questions count. Used to re-total after a cohort regrade
// and to check that stored scores (test_submissions, submissions, the published
// report) still match the marks.

const EPSILON = 1e-6;

function parse(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || ''); } catch { return fallback; }
}

// The scoring view of one submission_questions row. Mirrors the fields
// processReports passes to applyScoringPlan (it sets no `attempted`).
export function scoringQuestion(row) {
  const payload = parse(row.payload_json);
  const evidence = parse(row.evidence_json);
  const presented = presentQuestionForReport({
    gradeStatus: payload.grade?.status,
    marks: row.approved_marks ?? row.ai_marks ?? 0,
    total: row.marks_total,
    attempted: evidence.attempted !== false,
    teacherMarks: teacherKeptMarks(row),
  });
  return {
    number: row.question_number,
    marks_obtained: presented.marks_obtained,
    marks_total: Number(row.marks_total || 0),
    source_pages: Array.isArray(evidence.source_pages) ? evidence.source_pages : [],
  };
}

export function scoreQuestionRows(rows, scoringPlan) {
  return applyScoringPlan(rows.map(scoringQuestion), scoringPlan || { groups: [] });
}

/**
 * Loads a submission's question rows and active scoring plan and totals them.
 * `fallbackPlan` is used when the test has no active rubric (e.g. the plan
 * stored in an older report). Returns null when the submission is unknown.
 */
export async function loadSubmissionScoring(db, submissionId, { fallbackPlan = null } = {}) {
  const submission = (await db.execute({
    sql: 'SELECT s.id, s.test_id, s.score, s.max_marks, t.school FROM test_submissions s LEFT JOIN tests t ON t.id = s.test_id WHERE s.id = ?',
    args: [submissionId],
  })).rows[0];
  if (!submission) return null;
  const [questions, rubric] = await Promise.all([
    db.execute({
      sql: `SELECT question_number, ai_marks, approved_marks, review_revision, marks_total, payload_json, evidence_json
            FROM submission_questions WHERE submission_id = ? ORDER BY question_number`,
      args: [submissionId],
    }),
    db.execute({
      sql: `SELECT question_map_json FROM exam_rubric_versions
            WHERE test_id = ? AND is_active = 1 AND status = 'succeeded' ORDER BY version DESC LIMIT 1`,
      args: [submission.test_id],
    }),
  ]);
  const plan = parse(rubric.rows[0]?.question_map_json, null)?.exam?.scoring_plan || fallbackPlan || { groups: [] };
  return { submission, plan, scoring: scoreQuestionRows(questions.rows, plan) };
}

function reportSubject(report, subjectName) {
  const subjects = report?.term1?.subjects || report?.subjects || [];
  const wanted = String(subjectName || '').toLowerCase();
  return subjects.find((item) => wanted && String(item.name || item.id || '').toLowerCase() === wanted)
    || (subjects.length === 1 ? subjects[0] : null);
}

const numberKey = (value) => String(value ?? '').trim().toLowerCase();

/**
 * Writes the live totals into a report's subject: per-question marks, which
 * questions count, the subject score/total, plan and notes. Returns
 * { report, synced: false } when the subject cannot be found, so the caller
 * can still re-total the score columns and the check reports the gap.
 */
export function syncReportTotals(report, { scoring, plan }, subjectName) {
  const next = structuredClone(report || {});
  const subject = reportSubject(next, subjectName);
  if (!subject) return { report: next, synced: false };
  const live = new Map(scoring.questions.map((question) => [numberKey(question.number), question]));
  subject.questions = (subject.questions || []).map((question) => {
    const match = live.get(numberKey(question.number ?? question.question_number));
    if (!match) return question;
    return {
      ...question,
      marks_obtained: match.marks_obtained,
      marks_total: match.marks_total,
      counts_toward_score: match.counts_toward_score,
      scored_marks_obtained: match.scored_marks_obtained,
      scored_marks_allocated: match.scored_marks_allocated,
    };
  });
  subject.score = scoring.score;
  subject.total = scoring.total;
  subject.scoring_plan = plan;
  subject.scoring_notes = scoring.notes;
  const ratio = scoring.score / Math.max(scoring.total, 1);
  subject.status = ratio >= 0.75 ? 'strong' : ratio >= 0.45 ? 'developing' : 'needs_work';
  return { report: next, synced: true };
}

/** Sum of published subject score/total, as the student report shows it. */
export function reportTotals(report) {
  const subjects = report?.term1?.subjects || report?.subjects || [];
  return subjects.reduce((sum, subject) => ({
    score: sum.score + (Number(subject.score) || 0),
    total: sum.total + (Number(subject.total) || 0),
  }), { score: 0, total: 0 });
}

const differs = (stored, expected) => stored == null || Math.abs(Number(stored) - Number(expected)) > EPSILON;

/**
 * Compares the stored score in test_submissions, submissions and the published
 * report with `expected` ({ score, total }). Returns the list of places that
 * differ; a missing row in submissions counts as a mismatch (a silent mirror
 * failure), a missing published report does not (held or not yet built).
 */
export async function findScoreMismatches(db, submissionId, expected) {
  const [legacy, canonical, report] = await Promise.all([
    db.execute({ sql: 'SELECT score, max_marks FROM test_submissions WHERE id = ?', args: [submissionId] }),
    db.execute({ sql: 'SELECT score, max_marks FROM submissions WHERE id = ?', args: [submissionId] }),
    db.execute({
      sql: "SELECT payload_json FROM report_versions WHERE submission_id = ? AND status = 'published' ORDER BY version DESC LIMIT 1",
      args: [submissionId],
    }),
  ]);
  const places = [
    ['test_submissions', legacy.rows[0] || {}],
    ['submissions', canonical.rows[0] || {}],
  ];
  if (report.rows[0]) {
    const totals = reportTotals(parse(report.rows[0].payload_json));
    places.push(['report', { score: totals.score, max_marks: totals.total }]);
  }
  return places
    .filter(([, row]) => differs(row.score, expected.score) || differs(row.max_marks, expected.total))
    .map(([place, row]) => ({ place, score: row.score ?? null, max_marks: row.max_marks ?? null }));
}

/**
 * Logs every mismatch and sends one score_mismatch alert per call (rate-limited
 * per test by the alerter). `items` is [{ submissionId, expected, mismatches }].
 */
export async function reportScoreMismatches({ alerts, log = (entry) => console.warn(JSON.stringify(entry)), school, testId, source, items }) {
  const stale = items.filter((item) => item.mismatches.length);
  for (const item of stale) {
    log({ event: 'score_mismatch', source, school, testId, submissionId: item.submissionId, expected: item.expected, mismatches: item.mismatches });
  }
  if (!stale.length || !alerts) return stale.length;
  const first = stale[0];
  await alerts.send('score_mismatch', {
    school,
    testId,
    source,
    submissions: stale.length,
    submissionIds: stale.slice(0, 5).map((item) => item.submissionId).join(', '),
    expected: `${first.expected.score}/${first.expected.total}`,
    stored: first.mismatches.map((m) => `${m.place} ${m.score ?? 'null'}/${m.max_marks ?? 'null'}`).join('; '),
  }, { key: testId || first.submissionId }).catch(() => null);
  return stale.length;
}

/**
 * The teacher's mark on a reviewed question (review_revision > 0), else null.
 * A worker re-grade refreshes ai_marks and the AI feedback but must keep this.
 */
export function teacherKeptMarks(question) {
  return Number(question?.review_revision || 0) > 0 && question?.approved_marks != null ? Number(question.approved_marks) : null;
}

/**
 * Writes a fresh AI grade to both question tables. ai_marks always takes the
 * new AI mark; approved_marks does too unless a teacher has reviewed the
 * question, decided in SQL so a review saved mid-grade is not lost.
 */
export function gradeMarkStatements({ questionId, aiMarks, payloadJson, completed }) {
  const keepTeacher = 'CASE WHEN review_revision > 0 AND approved_marks IS NOT NULL THEN approved_marks ELSE ? END';
  return [
    { sql: `UPDATE submission_questions SET ai_marks = ?, approved_marks = ${keepTeacher}, status = 'graded', payload_json = ?, updated_at = ? WHERE id = ?`, args: [aiMarks, aiMarks, payloadJson, completed, questionId] },
    { sql: `UPDATE submission_questions_v2 SET ai_marks = ?, approved_marks = ${keepTeacher}, status = 'graded', render_json = ?, updated_at = ? WHERE id = ?`, args: [aiMarks, aiMarks, payloadJson, completed, questionId] },
  ];
}
