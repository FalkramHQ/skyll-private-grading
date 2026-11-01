import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockDb = vi.hoisted(() => ({ execute: vi.fn() }));

const auth = vi.hoisted(() => ({
  database: vi.fn(() => mockDb),
  ensureAuthTables: vi.fn().mockResolvedValue(),
  requireUser: vi.fn(),
}));

const intake = vi.hoisted(() => ({ ensureIntakeTables: vi.fn().mockResolvedValue() }));

const projection = vi.hoisted(() => ({
  projectOperationsAssessment: vi.fn(() => ({ state: 'ready', nextAction: 'queue' })),
}));

vi.mock('../../api/_lib/auth.js', () => auth);
vi.mock('../../api/_lib/intake.js', () => intake);
vi.mock('./assessmentLifecycleProjection.js', () => projection);

import handler from '../../server/admin/operations.js';

function response() {
  const res = {
    statusCode: null,
    body: null,
    setHeader: vi.fn(function setHeader(k, v) { this.headers = this.headers || {}; this.headers[k] = v; return this; }),
    status: vi.fn(function status(code) { this.statusCode = code; return this; }),
    json: vi.fn(function json(data) { this.body = data; return this; }),
  };
  return res;
}

function defaultRows(sql) {
  if (sql.includes('FROM tests t')) {
    return { rows: [{ id: 'test_1', school: 'Alpha School', title: 'Physics Test', subject: 'Physics', grade: '11th', status: 'live', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z', expected_students: 10, uploaded_students: 5, answer_sheets: 5, question_papers: 1, answer_keys: 1, pending_uploads: 0 }] };
  }
  return { rows: [] };
}

describe('admin operations HTTP handler authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.execute.mockImplementation(async ({ sql }) => defaultRows(sql));
  });

  it('rejects non-GET methods with 405', async () => {
    const res = response();
    await handler({ method: 'POST', query: {} }, res);
    expect(res.statusCode).toBe(405);
  });

  it('stops when authentication fails with 401', async () => {
    auth.requireUser.mockImplementationOnce(async (_req, res) => {
      res.status(401).json({ error: 'Sign in required' });
      return null;
    });
    const res = response();
    await handler({ method: 'GET', query: {} }, res);
    expect(res.statusCode).toBe(401);
    expect(mockDb.execute).not.toHaveBeenCalled();
  });

  it('scopes the test page to the admin school and jobs to that page', async () => {
    auth.requireUser.mockResolvedValueOnce({ username: 'admin_a', role: 'admin', school: 'Alpha School' });

    const testCalls = [];
    const jobCalls = [];
    mockDb.execute.mockImplementation(async ({ sql, args }) => {
      if (sql.includes('FROM tests t')) testCalls.push(args);
      if (sql.includes('FROM processing_jobs')) jobCalls.push(args);
      return defaultRows(sql);
    });

    const res = response();
    await handler({ method: 'GET', query: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(testCalls).toHaveLength(1);
    expect(testCalls[0]).toEqual(['Alpha School']);
    // Jobs are restricted to the ids of the school-scoped test page.
    expect(jobCalls).toHaveLength(1);
    expect(jobCalls[0]).toEqual(['test_1']);
  });

  it('scopes regrade runs by canonical school id and reports the latest run per test', async () => {
    auth.requireUser.mockResolvedValueOnce({ username: 'admin_a', role: 'admin', school: 'Alpha School', school_id: 'school_alpha' });
    let regradeArgs = null;
    mockDb.execute.mockImplementation(async ({ sql, args }) => {
      if (sql.includes('FROM regrade_runs r')) {
        regradeArgs = args;
        expect(sql).toContain('WHERE r.school_id = ?');
        return { rows: [
          { id: 'run_new', test_id: 'test_1', status: 'partial', requested_at: '2026-02-02T00:00:00.000Z', error: 'model timeout', question_count: 4, student_count: 10, queued_items: 0, processing_items: 0, completed_items: 38, failed_items: 2 },
          { id: 'run_old', test_id: 'test_1', status: 'published', requested_at: '2026-01-01T00:00:00.000Z', queued_items: 0, processing_items: 0, completed_items: 40, failed_items: 0 },
        ] };
      }
      return defaultRows(sql);
    });
    const res = response();
    await handler({ method: 'GET', query: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(regradeArgs).toEqual(['school_alpha']);
    expect(res.body.tests[0].regrade).toEqual({
      runId: 'run_new', status: 'partial', requestedAt: '2026-02-02T00:00:00.000Z', startedAt: null, completedAt: null, error: 'model timeout',
      questionCount: 4, studentCount: 10, items: { queued: 0, processing: 0, completed: 38, failed: 2 }, total: 40, retryable: true,
    });
  });

  it('reports no regrade for tests without runs', async () => {
    auth.requireUser.mockResolvedValueOnce({ username: 'admin_a', role: 'admin', school: 'Alpha School', school_id: 'school_alpha' });
    const res = response();
    await handler({ method: 'GET', query: {} }, res);
    expect(res.body.tests[0].regrade).toBeNull();
  });

  it('leaves queries unscoped for a skyll_admin', async () => {
    auth.requireUser.mockResolvedValueOnce({ username: 'sky_admin', role: 'skyll_admin', school: '' });

    const testCalls = [];
    const jobCalls = [];
    mockDb.execute.mockImplementation(async ({ sql, args }) => {
      if (sql.includes('FROM tests t')) testCalls.push(args);
      if (sql.includes('FROM processing_jobs')) jobCalls.push(args);
      return defaultRows(sql);
    });

    const res = response();
    await handler({ method: 'GET', query: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(testCalls[0]).toEqual([]);
    expect(jobCalls[0]).toEqual(['test_1']);
    const regradeCall = mockDb.execute.mock.calls.map(([call]) => call).find((call) => call.sql.includes('FROM regrade_runs r'));
    expect(regradeCall.sql).not.toContain('WHERE r.school_id');
    expect(regradeCall.args).toEqual([]);
  });
});
