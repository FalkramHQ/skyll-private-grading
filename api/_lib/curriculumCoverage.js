/**
 * Curriculum coverage: which syllabus topics a cohort has tested vs still missing.
 */

import { listCurriculumStandards } from './curriculumMap.js';

function text(value) {
  return String(value || '').trim();
}

function normalizeSubject(value) {
  return text(value).toLowerCase().replace('mathematics', 'maths');
}

async function resolveExamScope(db, { schoolId, examId }) {
  if (!examId) return null;
  const row = (await db.execute({
    sql: `SELECT e.id, e.name, e.grade, e.school_id, sub.name AS subject
          FROM exams e
          LEFT JOIN subjects sub ON sub.id = e.subject_id
          WHERE e.id = ? AND e.school_id = ?
          LIMIT 1`,
    args: [examId, schoolId],
  }).catch(() => ({ rows: [] }))).rows[0];
  if (!row) return null;
  return {
    examId: row.id,
    examName: row.name,
    grade: text(row.grade) || null,
    subject: text(row.subject) || null,
  };
}

/**
 * @param {object} db
 * @param {{
 *   schoolId: string,
 *   board?: string,
 *   grade?: string,
 *   subject?: string,
 *   examId?: string,
 *   includeProposed?: boolean,
 * }} scope
 */
export async function computeCurriculumCoverage(db, {
  schoolId,
  board = 'CBSE',
  grade = null,
  subject = null,
  examId = null,
  includeProposed = false,
} = {}) {
  if (!db) throw new Error('database client is required');
  if (!schoolId) throw new Error('schoolId is required');

  const examScope = await resolveExamScope(db, { schoolId, examId });
  const resolvedSubject = text(subject) || text(examScope?.subject) || null;
  const resolvedGrade = text(grade) || text(examScope?.grade) || null;
  const resolvedBoard = text(board) || 'CBSE';

  if (!resolvedSubject) {
    return {
      schoolId,
      board: resolvedBoard,
      grade: resolvedGrade,
      subject: null,
      examId: examScope?.examId || null,
      examName: examScope?.examName || null,
      totals: { standards: 0, tested: 0, missing: 0, pendingLinks: 0, unmappedQuestions: 0 },
      pctCovered: null,
      tested: [],
      missing: [],
      note: 'subject is required to compute syllabus coverage',
    };
  }

  const standards = await listCurriculumStandards(db, {
    board: resolvedBoard,
    grade: resolvedGrade || undefined,
    subject: resolvedSubject,
    limit: 400,
  });

  // If grade filter yields nothing (e.g. "10th" vs "10"), retry subject-only.
  const effectiveStandards = standards.length || !resolvedGrade
    ? standards
    : await listCurriculumStandards(db, {
      board: resolvedBoard,
      subject: resolvedSubject,
      limit: 400,
    });

  const statusClause = includeProposed
    ? "l.status IN ('approved', 'proposed')"
    : "l.status = 'approved'";
  const linkArgs = [schoolId];
  let examFilter = '';
  if (examScope?.examId) {
    examFilter = 'AND e.id = ?';
    linkArgs.push(examScope.examId);
  }
  linkArgs.push(normalizeSubject(resolvedSubject));

  const linked = await db.execute({
    sql: `SELECT l.curriculum_standard_id AS standard_id,
                 cs.topic AS topic,
                 cs.grade AS grade,
                 cs.board AS board,
                 l.status AS status,
                 COUNT(DISTINCT esq.id) AS question_count
          FROM exam_question_curriculum_links l
          JOIN exam_set_questions esq ON esq.id = l.exam_set_question_id
          JOIN exam_sets es ON es.id = esq.set_id
          JOIN exams e ON e.id = es.exam_id
          JOIN curriculum_standards cs ON cs.id = l.curriculum_standard_id
          WHERE e.school_id = ?
            ${examFilter}
            AND ${statusClause}
            AND REPLACE(LOWER(cs.subject), 'mathematics', 'maths') = ?
          GROUP BY l.curriculum_standard_id, cs.topic, cs.grade, cs.board, l.status
          ORDER BY cs.topic`,
    args: linkArgs,
  }).catch(() => ({ rows: [] }));

  const testedMap = new Map();
  let pendingLinks = 0;
  for (const row of linked.rows) {
    if (row.status === 'proposed') {
      pendingLinks += Number(row.question_count || 0);
      continue;
    }
    const current = testedMap.get(row.standard_id) || {
      id: row.standard_id,
      topic: row.topic,
      grade: row.grade,
      board: row.board,
      questionCount: 0,
    };
    current.questionCount += Number(row.question_count || 0);
    testedMap.set(row.standard_id, current);
  }

  // Pending proposed counts even when includeProposed is false (informational).
  if (!includeProposed) {
    const proposed = await db.execute({
      sql: `SELECT COUNT(*) AS c
            FROM exam_question_curriculum_links l
            JOIN exam_set_questions esq ON esq.id = l.exam_set_question_id
            JOIN exam_sets es ON es.id = esq.set_id
            JOIN exams e ON e.id = es.exam_id
            JOIN curriculum_standards cs ON cs.id = l.curriculum_standard_id
            WHERE e.school_id = ?
              ${examFilter}
              AND l.status = 'proposed'
              AND REPLACE(LOWER(cs.subject), 'mathematics', 'maths') = ?`,
      args: linkArgs,
    }).catch(() => ({ rows: [{ c: 0 }] }));
    pendingLinks = Number(proposed.rows[0]?.c || 0);
  }

  const unmappedArgs = [schoolId];
  let unmappedExamFilter = '';
  if (examScope?.examId) {
    unmappedExamFilter = 'AND e.id = ?';
    unmappedArgs.push(examScope.examId);
  }
  const unmapped = await db.execute({
    sql: `SELECT COUNT(*) AS c
          FROM exam_set_questions esq
          JOIN exam_sets es ON es.id = esq.set_id
          JOIN exams e ON e.id = es.exam_id
          LEFT JOIN exam_question_curriculum_links l ON l.exam_set_question_id = esq.id
          WHERE e.school_id = ?
            ${unmappedExamFilter}
            AND l.id IS NULL`,
    args: unmappedArgs,
  }).catch(() => ({ rows: [{ c: 0 }] }));

  const tested = [...testedMap.values()].sort((a, b) => a.topic.localeCompare(b.topic));
  const testedIds = new Set(tested.map((row) => row.id));
  const missing = effectiveStandards
    .filter((row) => !testedIds.has(row.id))
    .map((row) => ({ id: row.id, topic: row.topic, grade: row.grade, board: row.board }))
    .sort((a, b) => a.topic.localeCompare(b.topic));

  const totals = {
    standards: effectiveStandards.length,
    tested: tested.length,
    missing: missing.length,
    pendingLinks,
    unmappedQuestions: Number(unmapped.rows[0]?.c || 0),
  };
  const pctCovered = totals.standards
    ? Math.round((totals.tested / totals.standards) * 1000) / 10
    : null;

  return {
    schoolId,
    board: resolvedBoard,
    grade: resolvedGrade,
    subject: resolvedSubject,
    examId: examScope?.examId || null,
    examName: examScope?.examName || null,
    totals,
    pctCovered,
    tested,
    missing,
    note: effectiveStandards.length
      ? null
      : 'No curriculum standards matched this board/grade/subject filter.',
  };
}
