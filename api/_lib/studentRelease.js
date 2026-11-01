// Students and parents see a test only after a teacher releases it
// ("Release to students" in the review dashboard sets exams.released_at).
// Teachers and admins keep seeing every graded result, released or not.
// Migration 089 marked every exam that already had a report as released, so
// nothing students could see before disappeared.

const STAFF_ROLES = new Set(['teacher', 'admin', 'skyll_admin']);

/** Whether this viewer sees results before release (staff do; students and parents do not). */
export function seesUnreleasedResults(user) {
  return STAFF_ROLES.has(String(user?.role || ''));
}

/**
 * SQL condition: the row's exam has been released to students. `examIdColumn`
 * is the qualified exam id column (e.g. "rv.exam_id"). A row without an exam id
 * predates canonical exams and stays visible.
 */
export function releasedExamSql(examIdColumn) {
  return `(${examIdColumn} IS NULL OR EXISTS (SELECT 1 FROM exams released_exam WHERE released_exam.id = ${examIdColumn} AND released_exam.released_at IS NOT NULL))`;
}
