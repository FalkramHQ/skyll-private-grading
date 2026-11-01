import { indexIntakeAnswerSheetAssets } from './answerSheetAssets.js';
import { inActorSchool } from './schoolScope.js';
import { locateAnswers } from './answerLocator.js';
import { compareQuestionNumbers } from '../../shared/questionNumberSort.js';
import { ocrRunText } from '../../apps/processing-worker/ocrText.js';

function rejectWith(status, message) {
  const error = new Error(message);
  error.statusCode = status;
  throw error;
}

function parseObject(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function loadSheetOcr(db, testId, testStudentId) {
  const assets = await db.execute({
    sql: `SELECT id, storage_key, created_at FROM file_assets
          WHERE test_id = ? AND test_student_id = ? AND kind = 'answer_sheet' AND status = 'uploaded'
          ORDER BY created_at`,
    args: [testId, testStudentId],
  });
  const sheet = indexIntakeAnswerSheetAssets(assets.rows);
  const ocrByAsset = new Map();
  if (!sheet.length) return { sheet, ocrByAsset };
  const ocr = await db.execute({
    sql: `SELECT asset_id, markdown, pages_json FROM asset_ocr_runs
          WHERE asset_id IN (${sheet.map(() => '?').join(', ')}) AND is_active = 1 AND status = 'succeeded'`,
    args: sheet.map((asset) => asset.id),
  });
  for (const row of ocr.rows) ocrByAsset.set(row.asset_id, ocrRunText(row));
  return { sheet, ocrByAsset };
}

/**
 * OCR text for each page of one student's answer sheet, in the order the
 * review screen numbers them (page 1 first). A page without a succeeded
 * active OCR run is '' so later pages keep their numbers.
 */
export async function loadAnswerSheetPageTexts(db, testId, testStudentId) {
  const { sheet, ocrByAsset } = await loadSheetOcr(db, testId, testStudentId);
  return sheet.map((asset) => ocrByAsset.get(asset.id) || '');
}

/**
 * Where each of one student's answers sits on their answer sheet (#342).
 * Pages are numbered exactly as /api/student-answer-sheet serves them.
 */
export async function loadAnswerLocations(db, actor, { testId, testStudentId } = {}) {
  if (!testId || !testStudentId) rejectWith(400, 'testId and testStudentId are required');
  const owner = await db.execute({
    sql: `SELECT t.school FROM test_students ts JOIN tests t ON t.id = ts.test_id
          WHERE ts.test_id = ? AND ts.id = ?`,
    args: [testId, testStudentId],
  });
  if (!owner.rows.length) rejectWith(404, 'Answer sheet not found');
  if (actor.role !== 'skyll_admin' && !(await inActorSchool(db, actor, { schoolName: owner.rows[0].school }))) {
    rejectWith(403, 'School access denied');
  }

  const [{ sheet, ocrByAsset }, questions] = await Promise.all([
    loadSheetOcr(db, testId, testStudentId),
    db.execute({
      sql: `SELECT q.id, q.question_number, q.evidence_json, q.render_json
            FROM submission_questions_v2 q
            JOIN submissions s ON s.id = q.submission_id
            JOIN exams e ON e.id = s.exam_id
            JOIN test_students ts ON ts.test_id = e.source_test_id AND ts.student_id = s.student_id
            WHERE ts.id = ? AND COALESCE(e.source_test_id, e.id) = ?
              AND s.status != 'archived' AND e.status != 'archived'
            ORDER BY q.question_number`,
      args: [testStudentId, testId],
    }),
  ]);

  const locations = locateAnswers({
    pages: sheet.map((asset) => ocrByAsset.get(asset.id) || ''),
    questions: questions.rows
      .map((row) => ({
        id: row.id,
        questionNumber: row.question_number,
        // Evidence keeps the verbatim OCR even after a reviewer edits the
        // answer (edits land in render_json), so it is the text to search for.
        answer: parseObject(row.evidence_json).student_answer
          || parseObject(row.render_json).studentAnswer?.studentWrote
          || '',
      }))
      .sort(compareQuestionNumbers),
  });
  return { testId, testStudentId, pageCount: sheet.length, locations };
}
