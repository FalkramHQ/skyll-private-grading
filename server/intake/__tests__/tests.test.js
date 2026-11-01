import { describe, expect, test, vi } from 'vitest';

vi.mock('../../../api/_lib/auth.js', () => ({
  ensureAuthTables: vi.fn(async () => {}),
  requireUser: vi.fn(async () => ({ username: 'admin_1', school: 'Test School', school_id: 'school_1', role: 'admin' })),
  database: vi.fn(() => globalThis.__testDb),
}));

vi.mock('../../../api/_lib/intake.js', () => ({
  ensureIntakeTables: vi.fn(async () => {}),
  id: vi.fn((prefix) => `${prefix}_generated`),
}));

vi.mock('../../../api/_lib/storage.js', () => ({
  deleteObject: vi.fn(async () => ({ ok: true, status: 200 })),
}));

vi.mock('../../../api/_lib/exams.js', () => ({
  canonicalExamStatements: vi.fn(() => []),
  canonicalExamBatchSync: vi.fn(async () => []),
  canonicalExamDeleteStatements: vi.fn(async () => []),
  currentAcademicYearId: vi.fn(async () => null),
  ensureSubjectId: vi.fn(async () => null),
  examRowId: vi.fn((prefix) => `${prefix}_generated`),
}));

vi.mock('../../../shared/subjects.js', () => ({
  resolveCanonicalSubject: vi.fn((raw) => {
    const subjects = ['Mathematics', 'Physics', 'Chemistry', 'Biology', 'Science', 'Accounts', 'English', 'Hindi', 'German'];
    return subjects.find((s) => s.toLowerCase() === String(raw).trim().toLowerCase()) || null;
  }),
  subjectValidationError: vi.fn((raw) => {
    const cleaned = String(raw || '').trim();
    if (!cleaned) return 'subject is required';
    const subjects = ['Mathematics', 'Physics', 'Chemistry', 'Biology', 'Science', 'Accounts', 'English', 'Hindi', 'German'];
    if (!subjects.find((s) => s.toLowerCase() === cleaned.toLowerCase())) return `subject must be one of: ${subjects.join(', ')}`;
    return null;
  }),
}));

vi.mock('../../intake/rolePolicy.js', () => ({
  INTAKE_SCANNER_ROLES: ['admin', 'scanner'],
  canCreateOrDeleteTests: vi.fn(() => true),
  scannerDeniedMessage: () => 'Scanner access only.',
}));

const { default: handler } = await import('../tests.js');

import { requireUser } from '../../../api/_lib/auth.js';
import { canCreateOrDeleteTests } from '../rolePolicy.js';

function makeDb(testRow = {}) {
  const execute = vi.fn(async ({ sql }) => {
    if (sql.includes('LEFT JOIN exams') || sql.includes('SELECT * FROM tests WHERE school = ?') || sql.includes('SELECT * FROM tests WHERE id = ?')) {
      return { rows: testRow ? [testRow] : [] };
    }
    if (sql.includes('SELECT batch_id FROM test_batches')) return { rows: [] };
    if (sql.includes('SELECT id, name, grade FROM batches')) return { rows: [] };
    if (sql.includes('SELECT id, student_id, student_name')) return { rows: [] };
    if (sql.includes('SELECT COUNT(*) AS count FROM test_students')) return { rows: [{ count: 0 }] };
    if (sql.includes('SELECT status FROM processing_jobs')) return { rows: [] };
    if (sql.includes("SELECT id FROM processing_jobs WHERE test_id = ? AND status IN ('queued', 'running')")) return { rows: [] };
    if (sql.includes("SELECT id FROM processing_jobs WHERE test_id = ? AND status = 'running'")) return { rows: [] };
    if (sql.includes('SELECT student_id FROM test_students')) return { rows: [] };
    if (sql.includes('PRAGMA table_info')) return { rows: [{ name: 'exam_date' }, { name: 'exam_type' }] };
    return { rows: [] };
  });
  const batch = vi.fn(async (statements) => {
    // Apply a title UPDATE to the live testRow so a subsequent loadTestDetail
    // reflects the persisted name (as the real DB would after db.batch).
    if (testRow && Array.isArray(statements)) {
      for (const st of statements) {
        if (st.sql.startsWith('UPDATE tests SET') && String(st.sql).includes('title = ?') && Array.isArray(st.args)) testRow.title = st.args[0];
      }
    }
  });
  return { execute, batch };
}

function makeRes() {
  const res = { statusCode: 200, body: null };
  res.status = vi.fn((code) => { res.statusCode = code; return res; });
  res.json = vi.fn((data) => { res.body = data; return res; });
  return res;
}

describe('intake tests PATCH metadata', () => {
  test('rejects a PATCH with no changes (only testId)', async () => {
    globalThis.__testDb = makeDb({ id: 'test_1', school: 'Test School', grade: '10' });
    const res = makeRes();
    await handler({ method: 'PATCH', body: { testId: 'test_1' } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/at least one change/i);
  });

  test('accepts a metadata-only PATCH (exam_date + exam_type) and builds an UPDATE', async () => {
    globalThis.__testDb = makeDb({ id: 'test_1', school: 'Test School', grade: '10' });
    const res = makeRes();
    await handler({ method: 'PATCH', body: { testId: 'test_1', exam_date: '2026-09-01', exam_type: 'mcq' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.added).toBe(0);
    const batchCalls = globalThis.__testDb.batch.mock.calls;
    expect(batchCalls.length).toBeGreaterThan(0);
    const statements = batchCalls[0][0];
    const testsUpdate = statements.find((s) => s.sql.startsWith('UPDATE tests SET') && (s.sql.includes('exam_date') || s.sql.includes('exam_type')));
    expect(testsUpdate).toBeFalsy();
    const examUpdate = statements.find((s) => s.sql.startsWith('UPDATE exams SET') && s.sql.includes('exam_date'));
    expect(examUpdate).toBeTruthy();
    expect(examUpdate.args).toContain('2026-09-01');
    expect(examUpdate.args).toContain('mcq');
  });

  test('rejects an invalid exam_date format on PATCH', async () => {
    globalThis.__testDb = makeDb({ id: 'test_1', school: 'Test School', grade: '10' });
    const res = makeRes();
    await handler({ method: 'PATCH', body: { testId: 'test_1', exam_date: '09/01/2026' } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/YYYY-MM-DD/);
  });

  test('rejects an invalid exam_type on PATCH', async () => {
    globalThis.__testDb = makeDb({ id: 'test_1', school: 'Test School', grade: '10' });
    const res = makeRes();
    await handler({ method: 'PATCH', body: { testId: 'test_1', exam_type: 'essay' } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/exam_type must be/);
  });
});

describe('intake tests GET detail returns examDate/examType', () => {
  test('loadTestDetail includes examDate and examType from tests columns', async () => {
    const testRow = {
      id: 'test_1', school: 'Test School', title: 'My Exam', subject: 'Chemistry',
      grade: '10', status: 'uploading', exam_date: '2026-08-15', exam_type: 'mcq',
    };
    globalThis.__testDb = makeDb(testRow);
    const res = makeRes();
    await handler({ method: 'GET', query: { id: 'test_1' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.test.examDate).toBe('2026-08-15');
    expect(res.body.test.examType).toBe('mcq');
  });
});

describe('intake tests rename (PATCH title)', () => {
  test('renames a test and emits a trimmed title UPDATE', async () => {
    globalThis.__testDb = makeDb({ id: 'test_1', school: 'Test School', grade: '10', title: 'Old name' });
    const res = makeRes();
    await handler({ method: 'PATCH', body: { testId: 'test_1', title: '  Weekly Chemistry Midterm  ' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.added).toBe(0);
    const batchCalls = globalThis.__testDb.batch.mock.calls;
    expect(batchCalls.length).toBeGreaterThan(0);
    const statements = batchCalls[0][0];
    const update = statements.find((s) => s.sql.startsWith('UPDATE tests SET') && s.sql.includes('title = ?'));
    expect(update).toBeTruthy();
    expect(update.args[0]).toBe('Weekly Chemistry Midterm');
    // The persisted detail reflects the trimmed new title.
    expect(res.body.test.title).toBe('Weekly Chemistry Midterm');
  });

  test('rejects an empty (whitespace-only) title on PATCH', async () => {
    globalThis.__testDb = makeDb({ id: 'test_1', school: 'Test School' });
    const res = makeRes();
    await handler({ method: 'PATCH', body: { testId: 'test_1', title: '   ' } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/must not be empty/);
  });

  test('rejects a title longer than the creation-equivalent cap on PATCH', async () => {
    globalThis.__testDb = makeDb({ id: 'test_1', school: 'Test School' });
    const res = makeRes();
    await handler({ method: 'PATCH', body: { testId: 'test_1', title: 'x'.repeat(121) } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/at most 120 characters/);
  });

  test('rejects a rename when the scoped test select finds no row (404)', async () => {
    globalThis.__testDb = makeDb(null);
    const res = makeRes();
    await handler({ method: 'PATCH', body: { testId: 'test_missing', title: 'New name' } }, res);
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toMatch(/not found/);
  });

  test('blocks scanner-only accounts from renaming (403)', async () => {
    vi.mocked(requireUser).mockImplementationOnce(async () => ({ username: 'scanner_1', school: 'Test School', school_id: 'school_1', role: 'scanner' }));
    vi.mocked(canCreateOrDeleteTests).mockImplementationOnce(() => false);
    globalThis.__testDb = makeDb({ id: 'test_1', school: 'Test School' });
    const res = makeRes();
    await handler({ method: 'PATCH', body: { testId: 'test_1', title: 'New name' } }, res);
    expect(res.statusCode).toBe(403);
  });
});
