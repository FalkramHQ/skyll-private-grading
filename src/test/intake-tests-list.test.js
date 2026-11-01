import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  db: { execute: vi.fn() },
  ensureAuthTables: vi.fn(),
  ensureIntakeTables: vi.fn(),
  requireUser: vi.fn(),
}));

vi.mock('../../api/_lib/auth.js', () => ({
  database: () => mocks.db,
  ensureAuthTables: mocks.ensureAuthTables,
  requireUser: mocks.requireUser,
}));

vi.mock('../../api/_lib/intake.js', () => ({
  ensureIntakeTables: mocks.ensureIntakeTables,
  id: vi.fn(),
}));

vi.mock('../../api/_lib/storage.js', () => ({ deleteObject: vi.fn() }));
vi.mock('../../api/_lib/exams.js', () => ({
  canonicalExamStatements: vi.fn(), canonicalExamBatchSync: vi.fn(), canonicalExamDeleteStatements: vi.fn(),
  currentAcademicYearId: vi.fn(), ensureSubjectId: vi.fn(), examRowId: vi.fn(),
}));
vi.mock('../../shared/subjects.js', () => ({ resolveCanonicalSubject: vi.fn(), subjectValidationError: vi.fn() }));
vi.mock('../../server/intake/rolePolicy.js', () => ({
  INTAKE_SCANNER_ROLES: ['admin'], canCreateOrDeleteTests: vi.fn(), scannerDeniedMessage: vi.fn(),
}));

const { default: handler } = await import('../../server/intake/tests.js');

function response() {
  return {
    headers: {},
    setHeader: vi.fn(function setHeader(name, value) { this.headers[name] = value; }),
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
    end: vi.fn(),
  };
}

describe('intake tests list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureAuthTables.mockResolvedValue(undefined);
    mocks.ensureIntakeTables.mockResolvedValue(undefined);
    mocks.requireUser.mockResolvedValue({ school: 'Skyll School', role: 'admin' });
  });

  it('loads test summaries, student counts, and latest job statuses in one scoped query', async () => {
    mocks.db.execute.mockResolvedValue({
      rows: [{ id: 'test_1', school: 'Skyll School', title: 'Physics', student_count: '2', job_status: 'queued' }],
    });
    const res = response();

    await handler({ method: 'GET', query: {} }, res);

    expect(mocks.db.execute).toHaveBeenCalledTimes(1);
    expect(mocks.db.execute).toHaveBeenCalledWith(expect.objectContaining({
      sql: expect.stringContaining('ROW_NUMBER() OVER (PARTITION BY test_id ORDER BY requested_at DESC, id DESC)'),
      args: ['Skyll School', 'Skyll School'],
    }));
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      tests: [{ id: 'test_1', school: 'Skyll School', title: 'Physics', studentCount: 2, jobStatus: 'queued' }],
    });
  });

  it('returns zero and null for tests without students or processing jobs', async () => {
    mocks.db.execute.mockResolvedValue({
      rows: [{ id: 'test_2', school: 'Skyll School', title: 'Chemistry', student_count: 0, job_status: null }],
    });
    const res = response();

    await handler({ method: 'GET', query: {} }, res);

    expect(res.json).toHaveBeenCalledWith({
      tests: [{ id: 'test_2', school: 'Skyll School', title: 'Chemistry', studentCount: 0, jobStatus: null }],
    });
  });

  it('caches only the collection response and revalidates it with an ETag', async () => {
    const rows = [{ id: 'test_3', school: 'Skyll School', title: 'Maths', student_count: 1, job_status: 'queued' }];
    mocks.db.execute.mockResolvedValue({ rows });
    const initial = response();

    await handler({ method: 'GET', query: {}, headers: {} }, initial);

    expect(initial.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, max-age=30');
    expect(initial.setHeader).toHaveBeenCalledWith('Vary', 'Authorization, Cookie');
    const etag = initial.headers.ETag;
    expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/);

    const revalidated = response();
    await handler({ method: 'GET', query: {}, headers: { 'if-none-match': etag } }, revalidated);

    expect(revalidated.status).toHaveBeenCalledWith(304);
    expect(revalidated.end).toHaveBeenCalledOnce();
    expect(revalidated.json).not.toHaveBeenCalled();
  });

  it('does not cache a test-detail error response', async () => {
    mocks.db.execute.mockResolvedValue({ rows: [] });
    const res = response();

    await handler({ method: 'GET', query: { id: 'missing_test' }, headers: {} }, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.setHeader).not.toHaveBeenCalled();
  });
});
