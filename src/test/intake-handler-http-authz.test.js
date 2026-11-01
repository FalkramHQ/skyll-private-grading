import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockDb = vi.hoisted(() => ({ execute: vi.fn(), batch: vi.fn() }));

const auth = vi.hoisted(() => ({
  database: vi.fn(() => mockDb),
  ensureAuthTables: vi.fn().mockResolvedValue(),
  requireUser: vi.fn(),
}));

const intakeLib = vi.hoisted(() => ({
  ensureIntakeTables: vi.fn().mockResolvedValue(),
  id: vi.fn((prefix) => `${prefix}_1`),
}));

const rolePolicy = vi.hoisted(() => ({
  INTAKE_MANAGER_ROLES: ['admin', 'skyll_admin'],
  INTAKE_SCANNER_ROLES: ['admin', 'skyll_admin', 'scanner'],
  isIntakeManager: vi.fn((user) => ['admin', 'skyll_admin'].includes(user?.role)),
  isScannerOnly: vi.fn((user) => user?.role === 'scanner'),
  canUseIntake: vi.fn((user) => ['admin', 'skyll_admin', 'scanner'].includes(user?.role)),
  canCreateOrDeleteTests: vi.fn((user) => ['admin', 'skyll_admin'].includes(user?.role)),
  canUploadIntakeAsset: vi.fn((user, kind) => {
    if (!['admin', 'skyll_admin', 'scanner'].includes(user?.role)) return false;
    if (user?.role === 'scanner') return kind === 'answer_sheet';
    return true;
  }),
  scannerDeniedMessage: vi.fn(() => 'Scanner accounts can only open existing tests and upload answer sheets.'),
}));

const storage = vi.hoisted(() => ({
  assetKey: vi.fn(() => 'schools/alpha/asset.pdf'),
  createDownloadUrl: vi.fn(() => 'https://download.example/asset'),
  createUploadUrl: vi.fn(() => 'https://upload.example/asset'),
  deleteObject: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
}));

const examsLib = vi.hoisted(() => ({
  canonicalExamStatements: vi.fn(() => []),
  canonicalExamBatchSync: vi.fn(),
  canonicalExamDeleteStatements: vi.fn(async () => []),
  currentAcademicYearId: vi.fn(async () => 'ay_1'),
  ensureSubjectId: vi.fn(async (_db, _schoolId, _name, _now) => 'sub_1'),
  examRowId: vi.fn(() => 'exam_1'),
}));

const subjectsShared = vi.hoisted(() => ({
  resolveCanonicalSubject: vi.fn((name) => ({ key: name.toLowerCase(), display: name })),
  subjectValidationError: vi.fn(),
}));

const lifecycle = vi.hoisted(() => ({
  canRemoveStudentScan: vi.fn(() => true),
  canAcceptAnswerSheetUpload: vi.fn(() => true),
  answerSheetUploadBlockedMessage: vi.fn((status) => `This assessment is locked (${status || 'delivered'}).`),
}));

vi.mock('../../api/_lib/auth.js', () => auth);
vi.mock('../../api/_lib/intake.js', () => intakeLib);
vi.mock('../../api/_lib/storage.js', () => storage);
vi.mock('../../api/_lib/exams.js', () => examsLib);
vi.mock('../../shared/subjects.js', () => subjectsShared);
vi.mock('../../shared/workflowLifecycle.js', () => lifecycle);
vi.mock('./rolePolicy.js', () => rolePolicy);

import batches from '../../server/intake/batches.js';
import devices from '../../server/intake/devices.js';
import tests from '../../server/intake/tests.js';
import jobs from '../../server/intake/jobs.js';
import uploads from '../../server/intake/uploads.js';

function response() {
  const res = {
    statusCode: null,
    body: null,
    setHeader: vi.fn(function setHeader(k, v) { this.headers = this.headers || {}; this.headers[k] = v; return this; }),
    status: vi.fn(function status(code) { this.statusCode = code; return this; }),
    json: vi.fn(function json(data) { this.body = data; return this; }),
    end: vi.fn(),
  };
  return res;
}

const adminAlpha = { username: 'admin_a', role: 'admin', school: 'Alpha School' };
const scannerAlpha = { username: 'scanner_a', role: 'scanner', school: 'Alpha School' };

describe('intake handler HTTP authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.execute.mockImplementation(async () => ({ rows: [] }));
    mockDb.batch.mockResolvedValue({});
  });

  describe('batches', () => {
    it('stops when authentication fails with 401', async () => {
      auth.requireUser.mockImplementationOnce(async (_req, res) => {
        res.status(401).json({ error: 'Sign in required' });
        return null;
      });
      const res = response();
      await batches({ method: 'GET', query: {} }, res);
      expect(res.statusCode).toBe(401);
    });

    it('scopes the batch list to the admin school', async () => {
      auth.requireUser.mockResolvedValueOnce(adminAlpha);
      mockDb.execute.mockImplementation(async ({ sql, args }) => {
        expect(sql).toContain('WHERE b.school = ?');
        expect(args).toEqual(['Alpha School']);
        return { rows: [{ id: 'b1', name: '11A', grade: '11th', board: null, stream: null, academic_year: '2025-26', student_count: 12 }] };
      });
      const res = response();
      await batches({ method: 'GET', query: {}, headers: {} }, res);
      expect(res.statusCode).toBe(200);
      expect(res.body.batches).toHaveLength(1);
      expect(res.body.batches[0].studentCount).toBe(12);
    });
  });

  describe('devices', () => {
    it('rejects a scanner reading device status with 403', async () => {
      auth.requireUser.mockResolvedValueOnce(scannerAlpha);
      const res = response();
      await devices({ method: 'GET', query: {} }, res);
      expect(res.statusCode).toBe(403);
      expect(res.body.error).toBe('Device status is available only to school administrators.');
    });

    it('scopes device status to the admin school', async () => {
      auth.requireUser.mockResolvedValueOnce(adminAlpha);
      mockDb.execute.mockImplementation(async ({ sql, args }) => {
        expect(sql).toContain('WHERE school = ?');
        expect(args).toEqual(['Alpha School']);
        return { rows: [{ installation_id: 'inst_1', username: 'admin_a' }] };
      });
      const res = response();
      await devices({ method: 'GET', query: {} }, res);
      expect(res.statusCode).toBe(200);
      expect(res.body.installations).toHaveLength(1);
    });

    it('scopes a scanner registration to their school', async () => {
      auth.requireUser.mockResolvedValueOnce(scannerAlpha);
      const res = response();
      await devices({ method: 'POST', body: { installationId: 'inst_2', platform: 'android' } }, res);
      expect(res.statusCode).toBe(200);
      const [, schoolArg] = mockDb.execute.mock.calls[0][0].args;
      expect(schoolArg).toBe('Alpha School');
    });
  });

  describe('tests', () => {
    it('rejects a scanner deleting a test with 403', async () => {
      auth.requireUser.mockResolvedValueOnce(scannerAlpha);
      const res = response();
      await tests({ method: 'DELETE', query: { id: 'test_1' } }, res);
      expect(res.statusCode).toBe(403);
      expect(mockDb.execute).not.toHaveBeenCalled();
    });

    it('scopes the admin test lookup during deletion', async () => {
      auth.requireUser.mockResolvedValueOnce(adminAlpha);
      mockDb.execute.mockImplementation(async ({ sql }) => {
        if (sql.includes('SELECT id FROM tests')) return { rows: [{ id: 'test_1' }] };
        if (sql.includes("status = 'running'")) return { rows: [] };
        if (sql.includes('SELECT storage_key FROM file_assets')) return { rows: [] };
        return { rows: [] };
      });
      const res = response();
      await tests({ method: 'DELETE', query: { id: 'test_1' } }, res);
      expect(res.statusCode).toBe(200);
      const deleteLookup = mockDb.execute.mock.calls.find(([{ sql }]) => sql.includes('SELECT id FROM tests'));
      expect(deleteLookup[0].args).toEqual(['test_1', 'Alpha School']);
      expect(mockDb.batch).toHaveBeenCalled();
    });

    it('scopes the admin test list to the admin school', async () => {
      auth.requireUser.mockResolvedValueOnce(adminAlpha);
      mockDb.execute.mockImplementation(async ({ sql, args }) => {
        expect(sql).toContain('WHERE t.school = ?');
        expect(args).toEqual(['Alpha School', 'Alpha School']);
        return { rows: [{ id: 'test_1', school: 'Alpha School', title: 'Physics', student_count: 4, job_status: null }] };
      });
      const res = response();
      await tests({ method: 'GET', query: {}, headers: {} }, res);
      expect(res.statusCode).toBe(200);
      expect(res.body.tests).toHaveLength(1);
    });
  });

  describe('jobs', () => {
    it('stops when authentication fails with 401', async () => {
      auth.requireUser.mockImplementationOnce(async (_req, res) => {
        res.status(401).json({ error: 'Sign in required' });
        return null;
      });
      const res = response();
      await jobs({ method: 'GET', query: {} }, res);
      expect(res.statusCode).toBe(401);
    });

    it('scopes the job list to the admin school', async () => {
      auth.requireUser.mockResolvedValueOnce(adminAlpha);
      mockDb.execute.mockImplementation(async ({ sql, args }) => {
        expect(sql).toContain('WHERE school = ?');
        expect(args).toEqual(['Alpha School']);
        return { rows: [] };
      });
      const res = response();
      await jobs({ method: 'GET', query: {} }, res);
      expect(res.statusCode).toBe(200);
    });

    function uploadedCounts() {
      return { rows: [{ kind: 'question_paper', count: 1 }, { kind: 'answer_key', count: 1 }, { kind: 'answer_sheet', count: 3 }] };
    }

    it('keeps a school admin scoped to their own school when starting OCR', async () => {
      auth.requireUser.mockResolvedValueOnce(adminAlpha);
      const testLookups = [];
      mockDb.execute.mockImplementation(async ({ sql, args }) => {
        if (sql.includes('FROM tests WHERE id = ?')) { testLookups.push({ sql, args }); return { rows: [] }; }
        return { rows: [] };
      });
      const res = response();
      await jobs({ method: 'POST', body: { testId: 'test_beta', action: 'start_ocr' } }, res);
      expect(res.statusCode).toBe(404);
      expect(testLookups).toEqual([{ sql: 'SELECT * FROM tests WHERE id = ? AND school = ?', args: ['test_beta', 'Alpha School'] }]);
      expect(mockDb.batch).not.toHaveBeenCalled();
    });

    it('lets a platform admin act on another school\'s test and stamps that school on the job', async () => {
      auth.requireUser.mockResolvedValueOnce({ username: 'sky_admin', role: 'skyll_admin', school: 'Skyll', school_id: 'school_skyll' });
      const testLookups = [];
      mockDb.execute.mockImplementation(async ({ sql, args }) => {
        if (sql.includes('FROM tests WHERE id = ?')) {
          testLookups.push({ sql, args });
          return { rows: [{ id: 'test_beta', school: 'Beta School', school_id: 'school_beta', status: 'ready_for_processing' }] };
        }
        if (sql.includes("status = 'uploaded'") && sql.includes('GROUP BY kind')) return uploadedCounts();
        return { rows: [] };
      });
      const res = response();
      await jobs({ method: 'POST', body: { testId: 'test_beta', action: 'start_ocr' } }, res);
      expect(res.statusCode).toBe(201);
      expect(testLookups).toEqual([{ sql: 'SELECT * FROM tests WHERE id = ?', args: ['test_beta'] }]);
      expect(mockDb.batch).toHaveBeenCalledTimes(1);
      const [insert, statusUpdate] = mockDb.batch.mock.calls[0][0];
      expect(insert.sql).toContain('INSERT INTO processing_jobs (id, test_id, school, school_id, type');
      // Tenancy comes from the test, never from the acting platform admin.
      expect(insert.args.slice(1, 5)).toEqual(['test_beta', 'Beta School', 'school_beta', 'mistral_ocr']);
      expect(insert.args[7]).toBe('sky_admin');
      expect(statusUpdate.sql).toContain("UPDATE tests SET status = 'ocr_queued'");
      expect(statusUpdate.args[1]).toBe('test_beta');
    });

    it.each([
      ['start_ocr', 'mistral_ocr'],
      ['build_rubric', 'build_rubric'],
      ['process', 'process_test'],
    ])('reports a double-click %s race as the already-queued job (migration 088)', async (action, type) => {
      auth.requireUser.mockResolvedValueOnce(adminAlpha);
      let activeChecks = 0;
      mockDb.execute.mockImplementation(async ({ sql }) => {
        if (sql.includes('FROM tests WHERE id = ?')) return { rows: [{ id: 'test_1', school: 'Alpha School', school_id: 'school_a', status: 'ready_for_processing' }] };
        if (sql.includes("status = 'uploaded'") && sql.includes('GROUP BY kind')) return uploadedCounts();
        if (sql.includes('FROM file_assets a JOIN asset_ocr_runs')) return { rows: [{ kind: 'question_paper' }, { kind: 'answer_key' }] };
        if (sql.includes("status IN ('queued', 'running')") && sql.includes('type = ?')) {
          activeChecks += 1;
          // The pre-check misses; after the losing insert, the winner is visible.
          return { rows: activeChecks === 1 ? [] : [{ id: 'job_winner', status: 'queued' }] };
        }
        return { rows: [] };
      });
      mockDb.batch.mockRejectedValueOnce(new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed: processing_jobs.test_id, processing_jobs.type'));
      const res = response();
      await jobs({ method: 'POST', body: { testId: 'test_1', action } }, res);
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({ job: { id: 'job_winner', testId: 'test_1', status: 'queued' }, reused: true });
      expect(mockDb.batch.mock.calls[0][0][0].args[4]).toBe(type);
    });

    it('still fails a job insert that hits a different error', async () => {
      auth.requireUser.mockResolvedValueOnce(adminAlpha);
      mockDb.execute.mockImplementation(async ({ sql }) => {
        if (sql.includes('FROM tests WHERE id = ?')) return { rows: [{ id: 'test_1', school: 'Alpha School', status: 'ready_for_processing' }] };
        if (sql.includes("status = 'uploaded'") && sql.includes('GROUP BY kind')) return uploadedCounts();
        return { rows: [] };
      });
      mockDb.batch.mockRejectedValueOnce(new Error('database is locked'));
      const res = response();
      await jobs({ method: 'POST', body: { testId: 'test_1', action: 'process' } }, res);
      expect(res.statusCode).toBe(500);
    });

    it('rejects a job action without a testId', async () => {
      auth.requireUser.mockResolvedValueOnce(adminAlpha);
      const res = response();
      await jobs({ method: 'POST', body: { action: 'start_ocr' } }, res);
      expect(res.statusCode).toBe(400);
    });
  });

  describe('uploads', () => {
    it('rejects a scanner uploading a question paper with 403', async () => {
      auth.requireUser.mockResolvedValueOnce(scannerAlpha);
      const res = response();
      await uploads({
        method: 'POST',
        body: { action: 'create', testId: 'test_1', kind: 'question_paper', filename: 'paper.pdf', mimeType: 'application/pdf', byteSize: 1024 },
      }, res);
      expect(res.statusCode).toBe(403);
      expect(mockDb.execute).not.toHaveBeenCalled();
    });

    it('scopes the admin asset upload lookup to their school', async () => {
      auth.requireUser.mockResolvedValueOnce(adminAlpha);
      mockDb.execute.mockImplementation(async ({ sql, args }) => {
        if (sql.includes('SELECT * FROM tests')) {
          expect(args).toEqual(['test_1', 'Alpha School']);
          return { rows: [{ id: 'test_1', school: 'Alpha School', status: 'uploading' }] };
        }
        if (sql.includes('FROM processing_jobs') && sql.includes("status IN ('queued', 'running')")) {
          return { rows: [] };
        }
        if (sql.includes('SELECT id FROM test_students')) {
          return { rows: [{ id: 'ts_1' }] };
        }
        if (sql.includes('INSERT INTO file_assets')) {
          expect(args[1]).toBe('test_1');
          expect(args[7]).toBe('admin_a');
        }
        return { rows: [] };
      });
      const res = response();
      await uploads({
        method: 'POST',
        body: { action: 'create', testId: 'test_1', testStudentId: 'ts_1', kind: 'answer_sheet', filename: 'sheet.pdf', mimeType: 'application/pdf', byteSize: 2048 },
      }, res);
      expect(res.statusCode).toBe(201);
      expect(lifecycle.canAcceptAnswerSheetUpload).toHaveBeenCalledWith({
        testStatus: 'uploading',
        hasActiveProcessingJob: false,
      });
    });

    it('rejects answer-sheet creates on delivered assessments with 409', async () => {
      auth.requireUser.mockResolvedValueOnce(adminAlpha);
      lifecycle.canAcceptAnswerSheetUpload.mockReturnValueOnce(false);
      mockDb.execute.mockImplementation(async ({ sql }) => {
        if (sql.includes('SELECT * FROM tests')) {
          return { rows: [{ id: 'test_1', school: 'Alpha School', status: 'ready_for_review' }] };
        }
        if (sql.includes('FROM processing_jobs')) return { rows: [] };
        return { rows: [] };
      });
      const res = response();
      await uploads({
        method: 'POST',
        body: { action: 'create', testId: 'test_1', testStudentId: 'ts_1', kind: 'answer_sheet', filename: 'sheet.jpg', mimeType: 'image/jpeg', byteSize: 2048 },
      }, res);
      expect(res.statusCode).toBe(409);
      expect(res.body.code).toBe('answer_sheet_upload_locked');
      expect(mockDb.execute.mock.calls.some(([call]) => String(call.sql || '').includes('INSERT INTO file_assets'))).toBe(false);
    });
  });
});
