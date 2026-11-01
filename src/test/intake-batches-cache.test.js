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
vi.mock('../../api/_lib/intake.js', () => ({ ensureIntakeTables: mocks.ensureIntakeTables }));

const { default: handler } = await import('../../server/intake/batches.js');

function response() {
  return {
    headers: {},
    setHeader: vi.fn(function setHeader(name, value) { this.headers[name] = value; }),
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
    end: vi.fn(),
  };
}

describe('intake batches cache behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureAuthTables.mockResolvedValue(undefined);
    mocks.ensureIntakeTables.mockResolvedValue(undefined);
    mocks.requireUser.mockResolvedValue({ school: 'Skyll School', role: 'admin' });
  });

  it('returns a private, credential-varying cacheable collection response', async () => {
    mocks.db.execute.mockResolvedValue({
      rows: [{ id: 'batch_1', name: 'A', grade: '11', board: 'CBSE', stream: 'Science', academic_year: '2026', student_count: '24' }],
    });
    const res = response();

    await handler({ method: 'GET', headers: {} }, res);

    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, max-age=30');
    expect(res.setHeader).toHaveBeenCalledWith('Vary', 'Authorization, Cookie');
    expect(res.setHeader).toHaveBeenCalledWith('ETag', expect.any(String));
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      batches: [{ id: 'batch_1', name: 'A', grade: '11', board: 'CBSE', stream: 'Science', academicYear: '2026', studentCount: 24 }],
    });
  });

  it('does not add cache headers to rejected methods', async () => {
    const res = response();

    await handler({ method: 'POST', headers: {} }, res);

    expect(res.status).toHaveBeenCalledWith(405);
    expect(res.setHeader).not.toHaveBeenCalled();
  });
});
