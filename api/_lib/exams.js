import { randomUUID } from 'node:crypto';
import { resolveCanonicalSubject } from '../../shared/subjects.js';

export function examRowId(prefix) { return `${prefix}_${randomUUID()}`; }

/* Trim/collapse whitespace, strip a trailing ' set X' suffix, and map onto the allowlist. */
export function normalizeSubjectName(raw) {
  const display = resolveCanonicalSubject(raw);
  if (!display) return null;
  return { key: display.toLowerCase(), display };
}

export async function ensureSubjectId(db, schoolId, rawName, now) {
  const normalized = normalizeSubjectName(rawName);
  if (!normalized) return null;
  const existing = await db.execute({
    sql: 'SELECT id, name FROM subjects WHERE school_id = ? AND LOWER(name) = ? LIMIT 1',
    args: [schoolId, normalized.key],
  });
  if (existing.rows.length) {
    if (existing.rows[0].name !== normalized.display) {
      await db.execute({
        sql: 'UPDATE subjects SET name = ?, updated_at = ? WHERE id = ?',
        args: [normalized.display, now, existing.rows[0].id],
      });
    }
    return existing.rows[0].id;
  }
  const subjectId = examRowId('sub');
  await db.execute({
    sql: "INSERT INTO subjects (id, school_id, name, code, status, created_at, updated_at) VALUES (?, ?, ?, NULL, 'active', ?, ?)",
    args: [subjectId, schoolId, normalized.display, now, now],
  });
  return subjectId;
}

export async function currentAcademicYearId(db, schoolId) {
  const result = await db.execute({
    sql: 'SELECT id FROM academic_years WHERE school_id = ? AND is_current = 1 LIMIT 1',
    args: [schoolId],
  });
  return result.rows[0]?.id || null;
}

/* Build the canonical exams/exam_batches/exam_sets/exam_set_assignments write set for a newly
 * created intake test. `sets` defaults to a single set 'A' spanning every batch. */
export function canonicalExamStatements({
  examId, schoolId, subjectId, academicYearId, name, examDate, examType, status, sourceTestId,
  createdBy, batchIds, sets, roster, now,
}) {
  const statements = [{
    sql: `INSERT INTO exams (id, school_id, subject_id, academic_year_id, name, exam_date, exam_type, status, source_test_id, created_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [examId, schoolId, subjectId, academicYearId, name, examDate, examType || 'subjective', status || 'collecting', sourceTestId || null, createdBy || null, now, now],
  }];
  for (const batchId of batchIds) {
    statements.push({ sql: 'INSERT INTO exam_batches (exam_id, batch_id, created_at) VALUES (?, ?, ?)', args: [examId, batchId, now] });
  }
  const effectiveSets = (Array.isArray(sets) && sets.length ? sets : [{ code: 'A', batches: batchIds }]).slice(0, 8);
  for (const set of effectiveSets) {
    const setId = examRowId('set');
    const setCode = String(set.code || 'A').trim().toUpperCase().slice(0, 4) || 'A';
    statements.push({
      sql: "INSERT INTO exam_sets (id, exam_id, set_code, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)",
      args: [setId, examId, setCode, now, now],
    });
    const explicitStudents = Array.isArray(set.students) ? new Set(set.students.map(String)) : null;
    const setBatches = Array.isArray(set.batches) && set.batches.length ? new Set(set.batches.map(String)) : null;
    for (const student of roster) {
      const inSet = explicitStudents ? explicitStudents.has(String(student.student_id)) : (!setBatches || setBatches.has(String(student.batch_id)));
      if (!inSet) continue;
      statements.push({
        sql: 'INSERT INTO exam_set_assignments (id, set_id, student_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(set_id, student_id) DO NOTHING',
        args: [examRowId('esa'), setId, student.student_id, now],
      });
    }
  }
  return statements;
}

/* Sync added batches into the canonical exam (if one exists for this legacy test). */
export async function canonicalExamBatchSync(db, { testId, addedBatchIds, roster, now }) {
  const exam = await db.execute({ sql: 'SELECT id FROM exams WHERE source_test_id = ? LIMIT 1', args: [testId] });
  if (!exam.rows.length) return [];
  const examId = exam.rows[0].id;
  const defaultSet = await db.execute({ sql: "SELECT id FROM exam_sets WHERE exam_id = ? AND status = 'active' ORDER BY set_code LIMIT 1", args: [examId] });
  const statements = addedBatchIds.map((batchId) => ({
    sql: 'INSERT INTO exam_batches (exam_id, batch_id, created_at) VALUES (?, ?, ?) ON CONFLICT(exam_id, batch_id) DO NOTHING',
    args: [examId, batchId, now],
  }));
  if (defaultSet.rows.length) {
    const setId = defaultSet.rows[0].id;
    for (const student of roster) {
      statements.push({
        sql: 'INSERT INTO exam_set_assignments (id, set_id, student_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(set_id, student_id) DO NOTHING',
        args: [examRowId('esa'), setId, student.student_id, now],
      });
    }
  }
  return statements;
}

/* Remove the canonical exam rows for a deleted legacy test. */
export async function canonicalExamDeleteStatements(db, testId) {
  const exam = await db.execute({ sql: 'SELECT id FROM exams WHERE source_test_id = ?', args: [testId] });
  if (!exam.rows.length) return [];
  const examIds = exam.rows.map((row) => row.id);
  const placeholders = examIds.map(() => '?').join(', ');
  const sets = await db.execute({ sql: `SELECT id FROM exam_sets WHERE exam_id IN (${placeholders})`, args: examIds });
  const statements = [];
  if (sets.rows.length) {
    const setPlaceholders = sets.rows.map(() => '?').join(', ');
    const setIds = sets.rows.map((row) => row.id);
    statements.push(
      { sql: `DELETE FROM exam_set_assignments WHERE set_id IN (${setPlaceholders})`, args: setIds },
      { sql: `DELETE FROM exam_set_questions WHERE set_id IN (${setPlaceholders})`, args: setIds },
    );
  }
  statements.push(
    { sql: `DELETE FROM exam_sets WHERE exam_id IN (${placeholders})`, args: examIds },
    { sql: `DELETE FROM exam_batches WHERE exam_id IN (${placeholders})`, args: examIds },
    { sql: `DELETE FROM exams WHERE id IN (${placeholders})`, args: examIds },
  );
  return statements;
}
