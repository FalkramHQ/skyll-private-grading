/**
 * Question bank filters for practice / quiz generation.
 * Vectors deferred until the bank is large enough (~500+).
 */

import { randomUUID } from 'node:crypto';

function text(value) {
  return String(value || '').trim();
}

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function rowToQuestion(row) {
  if (!row) return null;
  return {
    id: row.id,
    board: row.board,
    grade: row.grade,
    subject: row.subject,
    topic: row.topic,
    curriculumStandardId: row.curriculum_standard_id,
    difficulty: row.difficulty,
    questionType: row.question_type,
    questionText: row.question_text,
    answerKey: row.answer_key,
    rubric: parseJson(row.rubric_json, null),
    maxMarks: row.max_marks == null ? null : Number(row.max_marks),
    source: row.source,
    sourceExamId: row.source_exam_id,
    sourceExamSetQuestionId: row.source_exam_set_question_id,
    qualityScore: row.quality_score == null ? null : Number(row.quality_score),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Filter question bank rows.
 *
 * @param {object} db
 * @param {{
 *   board?: string,
 *   grade?: string,
 *   subject?: string,
 *   topic?: string,
 *   difficulty?: string,
 *   questionType?: string,
 *   curriculumStandardId?: string,
 *   source?: string,
 *   status?: string,
 *   limit?: number,
 * }} [filters]
 */
export async function listQuestionBank(db, filters = {}) {
  if (!db) throw new Error('database client is required');
  const clauses = [];
  const args = [];

  const eq = (column, value) => {
    if (!text(value)) return;
    clauses.push(`LOWER(${column}) = LOWER(?)`);
    args.push(text(value));
  };

  eq('board', filters.board);
  eq('grade', filters.grade);
  eq('subject', filters.subject);
  eq('difficulty', filters.difficulty);
  eq('question_type', filters.questionType);
  eq('source', filters.source);
  eq('status', filters.status || 'active');

  if (filters.topic) {
    clauses.push('LOWER(topic) LIKE ?');
    args.push(`%${text(filters.topic).toLowerCase()}%`);
  }
  if (filters.curriculumStandardId) {
    clauses.push('curriculum_standard_id = ?');
    args.push(text(filters.curriculumStandardId));
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(200, Number(filters.limit) || 50));
  args.push(limit);

  const result = await db.execute({
    sql: `SELECT id, board, grade, subject, topic, curriculum_standard_id, difficulty,
                 question_type, question_text, answer_key, rubric_json, max_marks, source,
                 source_exam_id, source_exam_set_question_id, quality_score, status,
                 created_at, updated_at
          FROM question_bank
          ${where}
          ORDER BY updated_at DESC
          LIMIT ?`,
    args,
  });
  return result.rows.map(rowToQuestion);
}

/**
 * Insert or update a bank question. Embedding intentionally omitted (future).
 */
export async function upsertQuestionBankItem(db, item = {}) {
  if (!db) throw new Error('database client is required');
  const questionText = text(item.questionText || item.question_text);
  const subject = text(item.subject);
  if (!questionText) throw new Error('questionText is required');
  if (!subject) throw new Error('subject is required');

  const at = text(item.updatedAt) || new Date().toISOString();
  const id = text(item.id) || `qb_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  await db.execute({
    sql: `INSERT INTO question_bank (
            id, board, grade, subject, topic, curriculum_standard_id, difficulty,
            question_type, question_text, answer_key, rubric_json, max_marks, source,
            source_exam_id, source_exam_set_question_id, quality_score, embedding,
            status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            board = excluded.board,
            grade = excluded.grade,
            subject = excluded.subject,
            topic = excluded.topic,
            curriculum_standard_id = excluded.curriculum_standard_id,
            difficulty = excluded.difficulty,
            question_type = excluded.question_type,
            question_text = excluded.question_text,
            answer_key = excluded.answer_key,
            rubric_json = excluded.rubric_json,
            max_marks = excluded.max_marks,
            source = excluded.source,
            source_exam_id = excluded.source_exam_id,
            source_exam_set_question_id = excluded.source_exam_set_question_id,
            quality_score = excluded.quality_score,
            status = excluded.status,
            updated_at = excluded.updated_at`,
    args: [
      id,
      text(item.board) || null,
      text(item.grade) || null,
      subject,
      text(item.topic) || null,
      text(item.curriculumStandardId || item.curriculum_standard_id) || null,
      text(item.difficulty) || null,
      text(item.questionType || item.question_type) || null,
      questionText,
      text(item.answerKey || item.answer_key) || null,
      item.rubric != null ? JSON.stringify(item.rubric) : (item.rubric_json || null),
      item.maxMarks ?? item.max_marks ?? null,
      text(item.source) || 'ai_generated',
      text(item.sourceExamId || item.source_exam_id) || null,
      text(item.sourceExamSetQuestionId || item.source_exam_set_question_id) || null,
      item.qualityScore ?? item.quality_score ?? null,
      text(item.status) || 'active',
      text(item.createdAt) || at,
      at,
    ],
  });
  return { id };
}

/**
 * Copy an exam_set_question into the bank, optionally attaching a curriculum standard.
 */
export async function importExamQuestionToBank(db, {
  examSetQuestion,
  board = null,
  grade = null,
  subject = 'Mathematics',
  curriculumStandardId = null,
  difficulty = null,
  sourceExamId = null,
} = {}) {
  const rubric = typeof examSetQuestion?.rubric_json === 'string'
    ? parseJson(examSetQuestion.rubric_json, {})
    : (examSetQuestion?.rubric || examSetQuestion?.rubric_json || {});
  const topic = text(rubric.topic) || text(examSetQuestion?.topic) || null;
  return upsertQuestionBankItem(db, {
    board,
    grade,
    subject: text(examSetQuestion?.subject) || subject,
    topic,
    curriculumStandardId,
    difficulty: difficulty || text(rubric.difficulty) || null,
    questionType: text(rubric.expected_response_type) || null,
    questionText: text(examSetQuestion?.question_text) || text(rubric.question_text),
    answerKey: text(examSetQuestion?.answer_key_text) || text(rubric.correct_answer_summary),
    rubric,
    maxMarks: examSetQuestion?.max_marks ?? rubric.marks_allocated ?? null,
    source: 'exam_extracted',
    sourceExamId,
    sourceExamSetQuestionId: examSetQuestion?.id || null,
    qualityScore: 0.7,
  });
}
