// api/_lib/examMeta.js
// Resolves { board, grade, subject } for a given exam_id.
// Join chain: exams.source_test_id → tests (subject, grade)
// Board: exam_question_curriculum_links → curriculum_standards.board (first match wins)
// Note: exam_set_questions references its set via `set_id` (not exam_set_id).
export async function resolveExamMeta(db, examId) {
  if (!examId) return null;
  const examRow = await db.execute({
    sql: `SELECT t.subject, t.grade, e.source_test_id, e.name
          FROM exams e LEFT JOIN tests t ON t.id = e.source_test_id
          WHERE e.id = ?`,
    args: [examId],
  });
  const row = examRow.rows[0];
  if (!row || !row.subject) return null;
  // Try to get board from curriculum links
  const boardRow = await db.execute({
    sql: `SELECT cs.board
          FROM exam_question_curriculum_links l
          JOIN curriculum_standards cs ON cs.id = l.curriculum_standard_id
          JOIN exam_set_questions esq ON esq.id = l.exam_set_question_id
          JOIN exam_sets es ON es.id = esq.set_id
          JOIN exams e ON e.id = es.exam_id
          WHERE e.id = ?
          LIMIT 1`,
    args: [examId],
  });
  // No curriculum links for this exam — default to CBSE (majority board).
  // Do NOT guess ICSE from global standard existence; ICSE is only assigned
  // when the exam's own curriculum links point at ICSE standards.
  let board = boardRow.rows[0]?.board || 'CBSE';
  return { board, grade: row.grade, subject: row.subject };
}
