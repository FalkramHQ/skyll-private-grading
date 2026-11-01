/**
 * When is a test ready for build_reports, and how does a question that never
 * produced gradable evidence appear in a published report?
 *
 * `queueReportsWhenComplete` used to count every submission_questions row
 * whose status was not `graded` / `ready_for_review` as "ungraded". Two
 * legitimate terminal states never match that allowlist, so one such
 * question kept the whole test at grading_processing forever:
 *
 *   - `evidence_blocked`: extraction could not find a trustworthy answer
 *     (common for a blank MCQ with no source pages on the deterministic MCQ
 *     path). It is deliberately not graded; a reviewer resolves it.
 *   - `regraded`: a cohort regrade rewrote the question after review.
 *
 * Readiness is therefore defined by the statuses that genuinely mean work is
 * still pending, not by an allowlist of "done" names. Everything else is
 * terminal for report purposes; in-flight grade/visual jobs are checked
 * separately against processing_jobs.
 *
 * Status vocabulary observed across the worker and api/_lib:
 *   worker writes   pending, evidence_ready, evidence_blocked, graded
 *   regrade writes  regraded
 *   review writes   approved, flagged, published (v2 auto-publish)
 *   report renders  correct, partial, incorrect, not_attempted
 */

export const REPORT_BLOCKING_QUESTION_STATUSES = Object.freeze(['pending', 'evidence_ready', 'grading']);

export const REPORT_TERMINAL_QUESTION_STATUSES = Object.freeze([
  'graded', 'ready_for_review', 'regraded', 'approved', 'published', 'flagged',
  'correct', 'incorrect', 'partial', 'not_attempted', 'evidence_blocked',
]);

export const EVIDENCE_BLOCKED_FLAG = 'evidence_capture_incomplete';
export const EVIDENCE_BLOCKED_REASON = 'No readable answer was captured for this question. It is held for reviewer verification and is not scored.';
export const TEACHER_MARKED_REASON = 'Marked by your teacher from the answer sheet.';

/** True when a question in this status must hold build_reports back. */
export function questionBlocksReports(status) {
  return REPORT_BLOCKING_QUESTION_STATUSES.includes(String(status || '').trim().toLowerCase());
}

/** Count of questions on a test that still block report publication. */
export function reportBlockingCountStatement(testId) {
  const placeholders = REPORT_BLOCKING_QUESTION_STATUSES.map(() => '?').join(', ');
  return {
    sql: `SELECT COUNT(*) AS count
          FROM submission_questions question
          JOIN test_submissions submission ON submission.id = question.submission_id
          WHERE submission.test_id = ? AND LOWER(COALESCE(question.status, 'pending')) IN (${placeholders})`,
    args: [testId, ...REPORT_BLOCKING_QUESTION_STATUSES],
  };
}

/**
 * How a graded-record row is presented inside a student report.
 *
 * An `evidence_blocked` question is rendered as not attempted, carries a
 * visible review flag and a human-readable reason, and contributes zero
 * marks (it was never scored, so there is nothing else honest to show). It
 * is NOT a report guardrail failure: the report publishes with the question
 * flagged, and a reviewer resolving the evidence triggers a regrade.
 *
 * `teacherMarks` is the teacher's mark on a reviewed question (teacherKeptMarks).
 * When a teacher found the answer on the sheet and marked it, that mark counts:
 * it used to be dropped to zero here, so the score and report disagreed with
 * the review screen (PartnerD ICSE Physics, Kavya Q8.1 3/3 scored as 0).
 */
export function presentQuestionForReport({ gradeStatus, marks, total, attempted = true, gradingReason = '', scoreStatus, teacherMarks = null }) {
  const status = String(gradeStatus || '').trim().toLowerCase();
  if (status === 'evidence_blocked' && teacherMarks != null) {
    const fallback = typeof scoreStatus === 'function' ? scoreStatus(teacherMarks, total, true) : 'incorrect';
    return {
      status: fallback,
      marks_obtained: Number(teacherMarks),
      flagged: false,
      review_flag: null,
      grading_reason: gradingReason || TEACHER_MARKED_REASON,
      evidence_blocked: false,
    };
  }
  if (status === 'evidence_blocked') {
    return {
      status: 'not_attempted',
      marks_obtained: 0,
      flagged: true,
      review_flag: EVIDENCE_BLOCKED_FLAG,
      grading_reason: gradingReason || EVIDENCE_BLOCKED_REASON,
      evidence_blocked: true,
    };
  }
  const fallback = typeof scoreStatus === 'function' ? scoreStatus(marks, total, attempted) : (attempted ? 'incorrect' : 'not_attempted');
  return {
    status: status || fallback,
    marks_obtained: Number(marks || 0),
    flagged: false,
    review_flag: null,
    grading_reason: gradingReason,
    evidence_blocked: false,
  };
}
