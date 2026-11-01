import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockDb = vi.hoisted(() => ({ execute: vi.fn(), batch: vi.fn() }));

const auth = vi.hoisted(() => ({
  database: vi.fn(() => mockDb),
  ensureAuthTables: vi.fn().mockResolvedValue(),
  requireUser: vi.fn(),
}));

const intake = vi.hoisted(() => ({ ensureIntakeTables: vi.fn().mockResolvedValue() }));

const schoolScope = vi.hoisted(() => ({
  inActorSchool: vi.fn(async (_db, actor, { schoolId, schoolName }) => (schoolId ? schoolId === actor.school_id : schoolName === actor.school)),
}));

vi.mock('../../api/_lib/auth.js', () => auth);
vi.mock('../../api/_lib/intake.js', () => intake);
vi.mock('../../api/_lib/schoolScope.js', () => schoolScope);

import handler, { reconciledTestStatus, retryTargetStatus } from '../../server/admin/operationsActions.js';

function response() {
  return {
    statusCode: null,
    body: null,
    status: vi.fn(function status(code) { this.statusCode = code; return this; }),
    json: vi.fn(function json(data) { this.body = data; return this; }),
  };
}

const adminAlpha = { username: 'admin_a', role: 'admin', school: 'Alpha School', school_id: 'school_alpha' };
const platformAdmin = { username: 'sky', role: 'skyll_admin', school: 'Skyll', school_id: 'school_skyll' };
const betaTest = { id: 'test_beta', school: 'Beta School', school_id: 'school_beta', status: 'grading_failed' };
const alphaTest = { id: 'test_alpha', school: 'Alpha School', school_id: 'school_alpha', status: 'grading_failed' };

function rowsFor(sql, tables) {
  if (sql.includes('FROM tests WHERE id = ?')) return { rows: tables.tests || [] };
  if (sql.includes('FROM processing_jobs WHERE id = ?')) return { rows: tables.job || [] };
  if (sql.includes("status IN ('queued', 'running')")) return { rows: tables.active || [] };
  if (sql.includes('FROM processing_jobs WHERE test_id = ?')) return { rows: tables.jobs || [] };
  return { rows: [] };
}

describe('operations job actions: pure rules', () => {
  it('re-queues the earliest pipeline stage and ignores hive side jobs', () => {
    expect(retryTargetStatus(['build_reports', 'grade_submission', 'hive_synthesis'])).toBe('grading_queued');
    expect(retryTargetStatus(['materialize_evidence', 'mistral_ocr'])).toBe('ocr_queued');
    expect(retryTargetStatus(['deep_signal_extraction'])).toBeNull();
    expect(retryTargetStatus([])).toBeNull();
  });

  it('keeps human-owned statuses and leaves tests without pipeline jobs alone', () => {
    expect(reconciledTestStatus([{ type: 'grade_submission', status: 'failed' }], 'published')).toMatchObject({ status: 'published', changed: false, reason: 'human_owned_status' });
    expect(reconciledTestStatus([{ type: 'hive_synthesis', status: 'failed' }], 'grading_processing')).toMatchObject({ changed: false, reason: 'no_pipeline_jobs' });
    expect(reconciledTestStatus([], 'evidence_processing')).toMatchObject({ changed: false });
  });

  it('reports the earliest failed stage of the current round', () => {
    const jobs = [
      { type: 'mistral_ocr', status: 'succeeded', requested_at: '2026-01-01T00:00:00Z' },
      { type: 'build_rubric', status: 'succeeded', requested_at: '2026-01-01T01:00:00Z' },
      { type: 'materialize_evidence', status: 'succeeded', requested_at: '2026-01-01T02:00:00Z' },
      { type: 'grade_submission', status: 'succeeded', requested_at: '2026-01-01T03:00:00Z' },
      { type: 'grade_submission', status: 'failed_retryable', requested_at: '2026-01-01T03:00:00Z' },
      { type: 'build_reports', status: 'failed', requested_at: '2026-01-01T04:00:00Z' },
    ];
    expect(reconciledTestStatus(jobs, 'report_processing')).toMatchObject({ status: 'grading_failed', changed: true, reason: 'failed_grade_submission' });
  });

  it('ignores failures from before the newest rubric build', () => {
    const jobs = [
      { type: 'mistral_ocr', status: 'failed', requested_at: '2026-01-01T00:00:00Z' },
      { type: 'build_rubric', status: 'succeeded', requested_at: '2026-01-02T00:00:00Z' },
      { type: 'materialize_evidence', status: 'succeeded', requested_at: '2026-01-02T01:00:00Z' },
    ];
    expect(reconciledTestStatus(jobs, 'evidence_processing')).toMatchObject({ status: 'grading_queued', changed: true, reason: 'succeeded_materialize_evidence' });
  });

  it('judges single-run stages by their newest job', () => {
    const jobs = [
      { type: 'mistral_ocr', status: 'failed_retryable', requested_at: '2026-01-01T00:00:00Z' },
      { type: 'mistral_ocr', status: 'succeeded', requested_at: '2026-01-01T00:30:00Z' },
    ];
    expect(reconciledTestStatus(jobs, 'ocr_processing')).toMatchObject({ status: 'ocr_succeeded', changed: true });
    expect(reconciledTestStatus([{ type: 'build_reports', status: 'succeeded', requested_at: '2026-01-01T00:00:00Z' }], 'report_processing')).toMatchObject({ status: 'ready_for_review' });
    expect(reconciledTestStatus([{ type: 'build_reports', status: 'succeeded', requested_at: '2026-01-01T00:00:00Z' }], 'ready_for_review')).toMatchObject({ status: 'ready_for_review', changed: false });
  });
});

describe('operations job actions: HTTP handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.execute.mockImplementation(async ({ sql }) => rowsFor(sql, {}));
    mockDb.batch.mockResolvedValue({});
  });

  it('rejects non-POST methods with 405', async () => {
    const res = response();
    await handler({ method: 'GET', query: {} }, res);
    expect(res.statusCode).toBe(405);
    expect(auth.requireUser).not.toHaveBeenCalled();
  });

  it('stops when authentication or role checks fail', async () => {
    auth.requireUser.mockImplementationOnce(async (_req, res) => { res.status(403).json({ error: 'You do not have permission for this action' }); return null; });
    const res = response();
    await handler({ method: 'POST', body: { action: 'retry_failed_jobs', testId: 'test_alpha' } }, res);
    expect(res.statusCode).toBe(403);
    expect(auth.requireUser).toHaveBeenCalledWith(expect.anything(), res, ['admin', 'skyll_admin']);
    expect(mockDb.execute).not.toHaveBeenCalled();
  });

  it('rejects unsupported actions with 400', async () => {
    auth.requireUser.mockResolvedValueOnce(adminAlpha);
    const res = response();
    await handler({ method: 'POST', body: { action: 'drop_everything', testId: 'test_alpha' } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.supportedActions).toEqual(['retry_failed_jobs', 'retry_job', 'reconcile_status']);
  });

  it('hides another school\'s test from a school admin', async () => {
    auth.requireUser.mockResolvedValueOnce(adminAlpha);
    mockDb.execute.mockImplementation(async ({ sql }) => rowsFor(sql, { tests: [betaTest], jobs: [{ id: 'job_1', type: 'grade_submission' }] }));
    const res = response();
    await handler({ method: 'POST', body: { action: 'retry_failed_jobs', testId: 'test_beta' } }, res);
    expect(res.statusCode).toBe(404);
    expect(schoolScope.inActorSchool).toHaveBeenCalledWith(mockDb, adminAlpha, { schoolId: 'school_beta', schoolName: 'Beta School' });
    expect(mockDb.batch).not.toHaveBeenCalled();
  });

  it('resets every failed job of a test and re-queues the earliest stage', async () => {
    auth.requireUser.mockResolvedValueOnce(adminAlpha);
    mockDb.execute.mockImplementation(async ({ sql }) => rowsFor(sql, {
      tests: [alphaTest],
      jobs: [{ id: 'job_grade', type: 'grade_submission' }, { id: 'job_reports', type: 'build_reports' }],
    }));
    const res = response();
    await handler({ method: 'POST', body: { action: 'retry_failed_jobs', testId: 'test_alpha' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, jobsReset: 2, jobIds: ['job_grade', 'job_reports'], testStatus: 'grading_queued' });
    const [reset, status] = mockDb.batch.mock.calls[0][0];
    expect(reset.sql).toContain("SET status = 'queued', attempt_count = 0, lease_reclaim_count = 0, error = NULL, last_error_code = NULL");
    expect(reset.sql).toContain('next_attempt_at = NULL, worker_id = NULL, completed_at = NULL');
    expect(reset.sql).toContain("WHERE id IN (?, ?) AND status IN ('failed_retryable', 'failed')");
    expect(reset.args).toEqual(['job_grade', 'job_reports']);
    expect(status.sql).toContain('UPDATE tests SET status = ?');
    expect(status.args[0]).toBe('grading_queued');
    expect(status.args[2]).toBe('test_alpha');
  });

  it('retries only the newest failed run of a stage job (one active per test)', async () => {
    auth.requireUser.mockResolvedValueOnce(adminAlpha);
    // Newest first, as the query orders them.
    mockDb.execute.mockImplementation(async ({ sql }) => rowsFor(sql, {
      tests: [alphaTest],
      jobs: [{ id: 'ocr_new', type: 'mistral_ocr' }, { id: 'ocr_old', type: 'mistral_ocr' }, { id: 'grade_1', type: 'grade_submission' }],
    }));
    const res = response();
    await handler({ method: 'POST', body: { action: 'retry_failed_jobs', testId: 'test_alpha' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.jobIds).toEqual(['ocr_new', 'grade_1']);
  });

  it('does not retry a stage that is already queued or running again', async () => {
    auth.requireUser.mockResolvedValueOnce(adminAlpha);
    mockDb.execute.mockImplementation(async ({ sql }) => rowsFor(sql, {
      tests: [alphaTest],
      jobs: [{ id: 'ocr_failed', type: 'mistral_ocr' }],
      active: [{ type: 'mistral_ocr' }],
    }));
    const res = response();
    await handler({ method: 'POST', body: { action: 'retry_failed_jobs', testId: 'test_alpha' } }, res);
    expect(res.statusCode).toBe(409);
    expect(mockDb.batch).not.toHaveBeenCalled();
  });

  it('answers 409, not 500, when a stage was queued concurrently', async () => {
    auth.requireUser.mockResolvedValueOnce(adminAlpha);
    mockDb.execute.mockImplementation(async ({ sql }) => rowsFor(sql, { tests: [alphaTest], jobs: [{ id: 'ocr_failed', type: 'mistral_ocr' }] }));
    mockDb.batch.mockRejectedValueOnce(new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed: processing_jobs.test_id, processing_jobs.type'));
    const res = response();
    await handler({ method: 'POST', body: { action: 'retry_failed_jobs', testId: 'test_alpha' } }, res);
    expect(res.statusCode).toBe(409);
  });

  it('lets a platform admin retry another school\'s test', async () => {
    auth.requireUser.mockResolvedValueOnce(platformAdmin);
    mockDb.execute.mockImplementation(async ({ sql }) => rowsFor(sql, { tests: [betaTest], jobs: [{ id: 'job_1', type: 'materialize_evidence' }] }));
    const res = response();
    await handler({ method: 'POST', body: { action: 'retry_failed_jobs', testId: 'test_beta' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.testStatus).toBe('evidence_queued');
    expect(schoolScope.inActorSchool).not.toHaveBeenCalled();
  });

  it('answers 409 when there is nothing failed to retry', async () => {
    auth.requireUser.mockResolvedValueOnce(adminAlpha);
    mockDb.execute.mockImplementation(async ({ sql }) => rowsFor(sql, { tests: [alphaTest], jobs: [] }));
    const res = response();
    await handler({ method: 'POST', body: { action: 'retry_failed_jobs', testId: 'test_alpha' } }, res);
    expect(res.statusCode).toBe(409);
  });

  it('retries a single job only when it is failed', async () => {
    auth.requireUser.mockResolvedValue(adminAlpha);
    mockDb.execute.mockImplementation(async ({ sql }) => rowsFor(sql, { tests: [alphaTest], job: [{ id: 'job_1', test_id: 'test_alpha', type: 'build_reports', status: 'succeeded' }] }));
    let res = response();
    await handler({ method: 'POST', body: { action: 'retry_job', jobId: 'job_1' } }, res);
    expect(res.statusCode).toBe(409);
    expect(mockDb.batch).not.toHaveBeenCalled();

    mockDb.execute.mockImplementation(async ({ sql }) => rowsFor(sql, { tests: [alphaTest], job: [{ id: 'job_1', test_id: 'test_alpha', type: 'build_reports', status: 'failed_retryable' }] }));
    res = response();
    await handler({ method: 'POST', body: { action: 'retry_job', jobId: 'job_1' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ jobId: 'job_1', jobsReset: 1, testStatus: 'report_queued' });
    const [reset] = mockDb.batch.mock.calls[0][0];
    expect(reset.sql).toContain('WHERE id = ?');
    expect(reset.args).toEqual(['job_1']);
  });

  it('refuses to reconcile while jobs are active and otherwise rewrites the status', async () => {
    auth.requireUser.mockResolvedValue(adminAlpha);
    mockDb.execute.mockImplementation(async ({ sql }) => rowsFor(sql, { tests: [{ ...alphaTest, status: 'grading_processing' }], jobs: [{ id: 'job_1', type: 'grade_submission', status: 'running', requested_at: '2026-01-01T00:00:00Z' }] }));
    let res = response();
    await handler({ method: 'POST', body: { action: 'reconcile_status', testId: 'test_alpha' } }, res);
    expect(res.statusCode).toBe(409);

    mockDb.execute.mockImplementation(async ({ sql }) => rowsFor(sql, { tests: [{ ...alphaTest, status: 'grading_processing' }], jobs: [
      { id: 'job_e', type: 'materialize_evidence', status: 'succeeded', requested_at: '2026-01-01T00:00:00Z' },
      { id: 'job_1', type: 'grade_submission', status: 'succeeded', requested_at: '2026-01-01T01:00:00Z' },
      { id: 'job_2', type: 'grade_submission', status: 'succeeded', requested_at: '2026-01-01T01:00:00Z' },
    ] }));
    res = response();
    await handler({ method: 'POST', body: { action: 'reconcile_status', testId: 'test_alpha' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ previousStatus: 'grading_processing', testStatus: 'report_queued', changed: true });
    const update = mockDb.execute.mock.calls.map(([call]) => call).find((call) => call.sql.includes('UPDATE tests SET status = ?'));
    expect(update.args[0]).toBe('report_queued');
    expect(update.args[2]).toBe('test_alpha');
  });
});
