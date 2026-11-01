import { ensureAuthTables, requireUser, database } from '../../api/_lib/auth.js';
import { ensureIntakeTables, id } from '../../api/_lib/intake.js';
import { deleteObject } from '../../api/_lib/storage.js';
import { canonicalExamStatements, canonicalExamBatchSync, canonicalExamDeleteStatements, currentAcademicYearId, ensureSubjectId, examRowId } from '../../api/_lib/exams.js';
import { resolveCanonicalSubject, subjectValidationError } from '../../shared/subjects.js';
import { INTAKE_SCANNER_ROLES, canCreateOrDeleteTests, scannerDeniedMessage } from './rolePolicy.js';
import { sendPrivateCollection } from './privateCollectionCache.js';

// Applied to both create (POST) and rename (PATCH) so a rename can never exceed
// what creation allows (trimmed non-empty, capped length).
export const MAX_TITLE_LENGTH = 120;

function uniqueIds(values) {
  return [...new Set(Array.isArray(values) ? values.map((value) => String(value).trim()).filter(Boolean) : [])];
}

async function loadTestDetail(db, school, testId) {
  const testResult = await db.execute({ sql: 'SELECT t.*, e.exam_date AS exam_date, e.exam_type AS exam_type FROM tests t LEFT JOIN exams e ON e.source_test_id = t.id WHERE t.id = ? AND t.school = ?', args: [testId, school] });
  const test = testResult.rows[0];
  if (!test) return null;
  const [batches, students, assets, jobs] = await Promise.all([
    db.execute({ sql: `SELECT b.id, b.name, b.grade, b.board, b.stream FROM test_batches tb JOIN batches b ON b.id = tb.batch_id WHERE tb.test_id = ? ORDER BY b.name COLLATE NOCASE`, args: [testId] }),
    db.execute({ sql: 'SELECT id, student_id, student_name, batch_id, status, expected_page_count FROM test_students WHERE test_id = ? ORDER BY student_name COLLATE NOCASE', args: [testId] }),
    db.execute({ sql: 'SELECT id, test_student_id, kind, mime_type, byte_size, status, storage_key, created_at FROM file_assets WHERE test_id = ? ORDER BY created_at', args: [testId] }),
    // Only active jobs lock the editor; cancelled/failed/succeeded must not poison the client.
    db.execute({
      sql: `SELECT id, status, requested_at FROM processing_jobs
            WHERE test_id = ? AND status IN ('queued', 'running')
            ORDER BY requested_at DESC LIMIT 1`,
      args: [testId],
    }),
  ]);
  return {
    id: test.id, school: test.school, title: test.title, subject: test.subject, grade: test.grade, status: test.status,
    examDate: test.exam_date || null, examType: test.exam_type || null,
    batches: batches.rows.map((batch) => ({ ...batch })),
    students: students.rows.map((student) => ({ id: student.student_id, name: student.student_name, testStudentId: student.id, batchId: student.batch_id, status: student.status, expectedPageCount: student.expected_page_count || null })),
    assets: assets.rows.map((asset) => ({ id: asset.id, remoteAssetId: asset.id, kind: asset.kind, label: asset.storage_key?.split('/').pop() || asset.kind.replace('_', ' '), testStudentId: asset.test_student_id, status: asset.status, file: null })),
    job: jobs.rows[0] ? { id: jobs.rows[0].id, testId, status: jobs.rows[0].status } : null,
  };
}

export default async function handler(req, res) {
  try {
    await ensureAuthTables(); await ensureIntakeTables();
    const user = await requireUser(req, res, INTAKE_SCANNER_ROLES);
    if (!user) return;
    const db = database();
    if (req.method === 'GET') {
      const testId = String(req.query?.id || '').trim();
      if (testId) {
        const test = await loadTestDetail(db, user.school, testId);
        if (!test) return res.status(404).json({ error: 'Test not found' });
        return res.status(200).json({ test });
      }
      const result = await db.execute({
        sql: `SELECT t.*,
                     COUNT(DISTINCT ts.id) AS student_count,
                     pj.status AS job_status
              FROM tests t
              LEFT JOIN test_students ts ON ts.test_id = t.id
              LEFT JOIN (
                SELECT test_id, status,
                       ROW_NUMBER() OVER (PARTITION BY test_id ORDER BY requested_at DESC, id DESC) AS rn
                FROM processing_jobs
                WHERE school = ? AND status IN ('queued', 'running')
              ) pj ON pj.test_id = t.id AND pj.rn = 1
              WHERE t.school = ?
              GROUP BY t.id, pj.status
              ORDER BY t.created_at DESC
              LIMIT 100`,
        args: [user.school, user.school],
      });
      const tests = result.rows.map(({ student_count: studentCount, job_status: jobStatus, ...test }) => ({
        ...test,
        studentCount: Number(studentCount || 0),
        jobStatus: jobStatus || null,
      }));
      return sendPrivateCollection(req, res, { tests }, { scope: user.school });
    }
    if (req.method === 'DELETE') {
      if (!canCreateOrDeleteTests(user)) return res.status(403).json({ error: scannerDeniedMessage() });
      const testId = String(req.query?.id || '').trim();
      if (!testId) return res.status(400).json({ error: 'A test ID is required' });
      const test = await db.execute({ sql: 'SELECT id FROM tests WHERE id = ? AND school = ?', args: [testId, user.school] });
      if (!test.rows.length) return res.status(404).json({ error: 'Test not found' });
      const running = await db.execute({ sql: "SELECT id FROM processing_jobs WHERE test_id = ? AND status = 'running' LIMIT 1", args: [testId] });
      if (running.rows.length) return res.status(409).json({ error: 'A running test cannot be deleted.' });
      const assets = await db.execute({ sql: 'SELECT storage_key FROM file_assets WHERE test_id = ?', args: [testId] });
      await Promise.all(assets.rows.map(async (asset) => {
        const response = await deleteObject({ key: asset.storage_key });
        if (!response.ok && response.status !== 404) throw new Error(`Could not remove an uploaded file (${response.status})`);
      }));
      const statements = [];
      statements.push(
        { sql: 'DELETE FROM processing_jobs WHERE test_id = ?', args: [testId] },
        { sql: 'DELETE FROM file_assets WHERE test_id = ?', args: [testId] },
        { sql: 'DELETE FROM test_students WHERE test_id = ?', args: [testId] },
        { sql: 'DELETE FROM test_batches WHERE test_id = ?', args: [testId] },
        { sql: 'DELETE FROM tests WHERE id = ?', args: [testId] },
      );
      statements.push(...await canonicalExamDeleteStatements(db, testId));
      await db.batch(statements, 'write');
      return res.status(200).json({ ok: true, deletedTestId: testId });
    }
    if (req.method === 'PATCH') {
      if (!canCreateOrDeleteTests(user)) return res.status(403).json({ error: scannerDeniedMessage() });
      const { testId, batchIds, exam_date: examDate, exam_type: examType, title } = req.body || {};
      const selectedBatchIds = uniqueIds(batchIds);
      const titleValue = title !== undefined ? String(title).trim() : null;
      const examDateValue = examDate !== undefined ? String(examDate).trim() : null;
      const examTypeValue = examType !== undefined ? String(examType).trim().toLowerCase() : null;
      if (examDateValue && !/^\d{4}-\d{2}-\d{2}$/.test(examDateValue)) return res.status(400).json({ error: 'exam_date must be YYYY-MM-DD' });
      if (examTypeValue && !['mcq', 'subjective', 'mixed'].includes(examTypeValue)) return res.status(400).json({ error: 'exam_type must be mcq, subjective, or mixed' });
      if (titleValue !== null && !titleValue) return res.status(400).json({ error: 'title must not be empty' });
      if (titleValue !== null && titleValue.length > MAX_TITLE_LENGTH) return res.status(400).json({ error: `title must be at most ${MAX_TITLE_LENGTH} characters` });
      const hasMetadata = examDateValue !== null || examTypeValue !== null || titleValue !== null;
      if (!testId || (!selectedBatchIds.length && !hasMetadata)) return res.status(400).json({ error: 'testId and at least one change are required' });
      const test = await db.execute({ sql: 'SELECT * FROM tests WHERE id = ? AND school = ?', args: [testId, user.school] });
      if (!test.rows.length) return res.status(404).json({ error: 'Test not found' });
      const activeJob = await db.execute({ sql: "SELECT id FROM processing_jobs WHERE test_id = ? AND status IN ('queued', 'running') LIMIT 1", args: [testId] });
      if (activeJob.rows.length) return res.status(409).json({ error: 'This test is already processing and its roster is locked.' });
      const now = new Date().toISOString();
      const statements = [];
      let addedCount = 0;
      // Metadata update (exam_date / exam_type / title) — applied alongside or without batch changes.
      if (hasMetadata) {
        if (titleValue !== null) {
          statements.push({ sql: `UPDATE tests SET title = ?, updated_at = ? WHERE id = ?`, args: [titleValue, now, testId] });
        }
        // Best-effort mirror into canonical exams (may not exist for schools without an academic year).
        const examSetClauses = [];
        const examSetArgs = [];
        if (titleValue !== null) { examSetClauses.push('name = ?'); examSetArgs.push(titleValue); }
        if (examDateValue !== null) { examSetClauses.push('exam_date = ?'); examSetArgs.push(examDateValue); }
        if (examTypeValue !== null) { examSetClauses.push('exam_type = ?'); examSetArgs.push(examTypeValue); }
        if (examSetClauses.length) {
          examSetClauses.push('updated_at = ?'); examSetArgs.push(now);
          examSetArgs.push(testId);
          statements.push({ sql: `UPDATE exams SET ${examSetClauses.join(', ')} WHERE source_test_id = ?`, args: examSetArgs });
        }
      }
      // Batch add (existing logic, skipped when no new batches).
      if (selectedBatchIds.length) {
        const existing = await db.execute({ sql: 'SELECT batch_id FROM test_batches WHERE test_id = ?', args: [testId] });
        const existingIds = new Set(existing.rows.map((row) => row.batch_id));
        const addedIds = selectedBatchIds.filter((batchId) => !existingIds.has(batchId));
        if (addedIds.length) {
          const placeholders = addedIds.map(() => '?').join(', ');
          const selected = await db.execute({ sql: `SELECT id, name, grade FROM batches WHERE school = ? AND status = 'active' AND id IN (${placeholders})`, args: [user.school, ...addedIds] });
          if (selected.rows.length !== addedIds.length) return res.status(400).json({ error: 'One or more selected batches are unavailable for your school' });
          const roster = await db.execute({ sql: `SELECT bs.batch_id, s.id AS student_id, s.display_name FROM batch_memberships bs JOIN students s ON s.id = bs.student_id WHERE bs.batch_id IN (${placeholders}) AND bs.status = 'active' AND s.school = ? AND s.status = 'active' ORDER BY s.display_name COLLATE NOCASE`, args: [...addedIds, user.school] });
          if (!roster.rows.length) return res.status(400).json({ error: 'The selected batch has no active students.' });
          const currentStudents = await db.execute({ sql: 'SELECT student_id FROM test_students WHERE test_id = ?', args: [testId] });
          const presentStudentIds = new Set(currentStudents.rows.map((row) => row.student_id));
          for (const batchId of addedIds) statements.push({ sql: 'INSERT INTO test_batches (test_id, batch_id, created_at) VALUES (?, ?, ?)', args: [testId, batchId, now] });
          for (const student of roster.rows) {
            if (presentStudentIds.has(student.student_id)) continue;
            statements.push({ sql: 'INSERT INTO test_students (id, test_id, student_id, student_name, batch_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', args: [id('test_student'), testId, student.student_id, student.display_name, student.batch_id, 'expected', now] });
          }
          const grade = [...new Set(selected.rows.map((batch) => batch.grade).concat(String(test.rows[0].grade || '').split(', ')).filter(Boolean))].join(', ');
          statements.push({ sql: 'UPDATE tests SET grade = ?, updated_at = ? WHERE id = ?', args: [grade, now, testId] });
          statements.push(...await canonicalExamBatchSync(db, { testId, addedBatchIds: addedIds, roster: roster.rows, now }));
          addedCount = addedIds.length;
        }
      }
      if (!statements.length) return res.status(200).json({ test: await loadTestDetail(db, user.school, testId), added: 0 });
      await db.batch(statements, 'write');
      return res.status(200).json({ test: await loadTestDetail(db, user.school, testId), added: addedCount });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    if (!canCreateOrDeleteTests(user)) return res.status(403).json({ error: scannerDeniedMessage() });
    const { title, subject, batchIds, name, exam_date: examDate, subject_id: subjectIdRaw, batch_ids: batchIdsNew, sets, exam_type: examType } = req.body || {};
    const examName = String(name || title || '').trim();
    const subjectError = subjectValidationError(subject);
    const subjectCanonical = resolveCanonicalSubject(subject);
    const selectedBatchIds = uniqueIds(batchIdsNew || batchIds);
    if (!examName || (!subjectCanonical && !subjectIdRaw) || !selectedBatchIds.length) {
      return res.status(400).json({ error: subjectError || 'name, subject, and at least one existing batch are required' });
    }
    if (examName.length > MAX_TITLE_LENGTH) return res.status(400).json({ error: `name must be at most ${MAX_TITLE_LENGTH} characters` });
    if (!subjectIdRaw && subjectError) return res.status(400).json({ error: subjectError });
    if (selectedBatchIds.length > 10) return res.status(400).json({ error: 'A test can include at most 10 batches' });
    const examDateValue = examDate ? String(examDate).trim() : null;
    if (examDateValue && !/^\d{4}-\d{2}-\d{2}$/.test(examDateValue)) return res.status(400).json({ error: 'exam_date must be YYYY-MM-DD' });
    const examTypeValue = examType ? String(examType).trim().toLowerCase() : 'subjective';
    if (!['mcq', 'subjective', 'mixed'].includes(examTypeValue)) return res.status(400).json({ error: 'exam_type must be mcq, subjective, or mixed' });
    if (sets !== undefined && (!Array.isArray(sets) || !sets.length || sets.length > 8)) return res.status(400).json({ error: 'sets must be an array of 1-8 set definitions' });
    const placeholders = selectedBatchIds.map(() => '?').join(', ');
    const batchesResult = await db.execute({
      sql: `SELECT id, name, grade FROM batches WHERE school = ? AND status = 'active' AND id IN (${placeholders})`,
      args: [user.school, ...selectedBatchIds],
    });
    if (batchesResult.rows.length !== selectedBatchIds.length) return res.status(400).json({ error: 'One or more selected batches are unavailable for your school' });
    const rosterResult = await db.execute({
      sql: `SELECT bs.batch_id, s.id AS student_id, s.display_name
            FROM batch_memberships bs JOIN students s ON s.id = bs.student_id
            WHERE bs.batch_id IN (${placeholders}) AND bs.status = 'active' AND s.school = ? AND s.status = 'active'
            ORDER BY s.display_name COLLATE NOCASE`,
      args: [...selectedBatchIds, user.school],
    });
    const rosterByStudent = new Map();
    for (const row of rosterResult.rows) if (!rosterByStudent.has(row.student_id)) rosterByStudent.set(row.student_id, row);
    const roster = [...rosterByStudent.values()];
    if (!roster.length) return res.status(400).json({ error: 'The selected batch has no active students. Ask an administrator to import its roster before creating a test.' });
    if (roster.length > 500) return res.status(400).json({ error: 'A test can contain at most 500 students' });
    const now = new Date().toISOString(); const testId = id('test');
    const grade = [...new Set(batchesResult.rows.map((batch) => batch.grade).filter(Boolean))].join(', ') || 'Mixed';
    const subjectStored = subjectCanonical;
    if (!subjectStored && !subjectIdRaw) return res.status(400).json({ error: subjectError || 'subject is required' });
    // When only subject_id is provided, resolve its display name for tests.subject.
    let subjectForTest = subjectStored;
    if (!subjectForTest && subjectIdRaw) {
      const named = await db.execute({ sql: 'SELECT name FROM subjects WHERE id = ? AND school_id = ? LIMIT 1', args: [subjectIdRaw, user.school_id] });
      subjectForTest = resolveCanonicalSubject(named.rows[0]?.name) || named.rows[0]?.name;
      if (!resolveCanonicalSubject(subjectForTest)) {
        return res.status(400).json({ error: subjectValidationError(subjectForTest) || 'subject_id must point to an allowlisted subject' });
      }
    }
    const statements = [{ sql: 'INSERT INTO tests (id, school, title, subject, grade, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', args: [testId, user.school, examName, subjectForTest, grade, 'uploading', user.username, now, now] }];
    for (const batchId of selectedBatchIds) statements.push({ sql: 'INSERT INTO test_batches (test_id, batch_id, created_at) VALUES (?, ?, ?)', args: [testId, batchId, now] });
    const createdStudents = [];
    for (const student of roster) {
      const testStudentId = id('test_student');
      statements.push({ sql: 'INSERT INTO test_students (id, test_id, student_id, student_name, batch_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', args: [testStudentId, testId, student.student_id, student.display_name, student.batch_id, 'expected', now] });
      createdStudents.push({ id: student.student_id, name: student.display_name, testStudentId, batchId: student.batch_id });
    }
    // Canonical exams model: every new intake test lands in exams/exam_sets alongside
    // the pipeline tables so the review/reporting side reads one proper schema.
    const subjectId = subjectIdRaw || await ensureSubjectId(db, user.school_id, subjectForTest, now);
    if (!subjectId) return res.status(400).json({ error: subjectValidationError(subjectForTest) || 'subject is required' });
    const academicYearId = await currentAcademicYearId(db, user.school_id);
    if (subjectId && academicYearId) {
      statements.push(...canonicalExamStatements({
        examId: examRowId('exam'), schoolId: user.school_id, subjectId, academicYearId,
        name: examName, examDate: examDateValue || now.slice(0, 10), examType: examTypeValue, status: 'collecting',
        sourceTestId: testId, createdBy: user.username, batchIds: selectedBatchIds, sets, roster, now,
      }));
    }
    await db.batch(statements, 'write');
    return res.status(201).json({ test: { id: testId, school: user.school, title: examName, subject: subjectForTest, grade, status: 'uploading', examDate: examDateValue || now.slice(0, 10), examType: examTypeValue, batches: batchesResult.rows, students: createdStudents } });
  } catch (error) { return res.status(500).json({ error: error.message }); }
}
