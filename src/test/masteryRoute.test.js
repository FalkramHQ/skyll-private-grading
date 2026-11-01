import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildStudentContext } from '../../api/_lib/contextBuilder.js';
import { resetRateLimitBuckets } from '../../api/_lib/aiRateLimit.js';

// Auth helpers (database, requireUser, ensureAuthTables) all live in
// api/_lib/auth.js - the same module server/ai/hive.js imports from.
const mocks = vi.hoisted(() => ({
  db: { execute: async () => ({ rows: [] }) },
  user: { role: 'teacher', school_id: 'sch_x', user_id: 'u1', username: 'teach' },
}));

vi.mock('../../api/_lib/auth.js', () => ({
  database: () => mocks.db,
  requireUser: vi.fn(async () => mocks.user),
  ensureAuthTables: vi.fn(async () => {}),
}));
vi.mock('../../api/_lib/contextBuilder.js', () => ({
  buildStudentContext: vi.fn(async () => ({ studentId: 'stu1' })),
}));

import { getMastery } from '../../server/ai/mastery.js';

const ROW = {
  kc_id: 'kc_a',
  kc_label: 'KC-A',
  subject: 'Mathematics',
  alpha: 3,
  beta: 1,
  theta_mean: 0.75,
  ci_low: 0.42,
  ci_high: 0.96,
  evidence_count: 2,
  last_signal_at: '2026-08-06T00:00:00Z',
};

function makeDb(rows = [ROW]) {
  mocks.db = { execute: vi.fn(async () => ({ rows })) };
  return mocks.db;
}

function makeRes() {
  const res = { status: vi.fn(() => res), json: vi.fn(), setHeader: vi.fn() };
  return res;
}

describe('getMastery', () => {
  beforeEach(() => {
    mocks.user = { role: 'teacher', school_id: 'sch_x', user_id: 'u1', username: 'teach' };
    buildStudentContext.mockResolvedValue({ studentId: 'stu1' });
  });

  afterEach(() => {
    vi.clearAllMocks();
    resetRateLimitBuckets();
  });

  it('returns school-scoped mastery for a teacher-provided studentId', async () => {
    const db = makeDb();
    const res = makeRes();
    await getMastery({ method: 'GET', query: { studentId: 'stu1' } }, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      mastery: expect.arrayContaining([
        expect.objectContaining({ kcId: 'kc_a', kcLabel: 'KC-A', thetaMean: 0.75, wide: false }),
      ]),
      count: 1,
    }));
    expect(db.execute).toHaveBeenCalledWith(expect.objectContaining({
      args: ['sch_x', 'stu1'],
    }));
  });

  it('ignores peer studentId/username for student callers and resolves self', async () => {
    mocks.user = { role: 'student', school_id: 'sch_x', user_id: 'u2', username: 'me12' };
    buildStudentContext.mockResolvedValue({ studentId: 'stu_self' });
    const db = makeDb();
    const res = makeRes();
    await getMastery({ method: 'GET', query: { studentId: 'stu_peer', username: 'peer99' } }, res);
    expect(res.status).toHaveBeenCalledWith(200);
    // Self-resolution goes through the session's user_id, never the query params.
    expect(buildStudentContext).toHaveBeenCalledWith(mocks.db, { schoolId: 'sch_x', userId: 'u2' });
    const { args } = db.execute.mock.calls[0][0];
    expect(args).toContain('stu_self');
    expect(args).not.toContain('stu_peer');
    expect(args).not.toContain('peer99');
  });

  it('returns own mastery for student callers with no params', async () => {
    mocks.user = { role: 'student', school_id: 'sch_x', user_id: 'u2', username: 'me12' };
    buildStudentContext.mockResolvedValue({ studentId: 'stu_self' });
    makeDb();
    const res = makeRes();
    await getMastery({ method: 'GET', query: {} }, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ count: 1 }));
    expect(buildStudentContext).toHaveBeenCalledWith(mocks.db, { schoolId: 'sch_x', userId: 'u2' });
  });

  it('returns 404 when a student caller has no linked student profile', async () => {
    mocks.user = { role: 'student', school_id: 'sch_x', user_id: 'u2', username: 'me12' };
    buildStudentContext.mockResolvedValue({ studentId: '' });
    makeDb();
    const res = makeRes();
    await getMastery({ method: 'GET', query: {} }, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Student profile not found' });
  });

  it('returns 400 for staff callers without studentId or username', async () => {
    makeDb();
    const res = makeRes();
    await getMastery({ method: 'GET', query: {} }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'studentId or username is required' });
    expect(mocks.db.execute).not.toHaveBeenCalled();
  });

  it('returns 404 when staff username does not resolve to a student', async () => {
    buildStudentContext.mockResolvedValue({ studentId: '' });
    makeDb();
    const res = makeRes();
    await getMastery({ method: 'GET', query: { username: 'ghost' } }, res);
    expect(buildStudentContext).toHaveBeenCalledWith(mocks.db, { schoolId: 'sch_x', username: 'ghost' });
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Student not found' });
  });

  it('rejects non-GET methods with 405', async () => {
    const res = makeRes();
    await getMastery({ method: 'POST', query: {} }, res);
    expect(res.status).toHaveBeenCalledWith(405);
    expect(res.json).toHaveBeenCalledWith({ error: 'Method not allowed' });
  });

  it('returns empty mastery list when no rows match', async () => {
    makeDb([]);
    const res = makeRes();
    await getMastery({ method: 'GET', query: { studentId: 'stu1' } }, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ mastery: [], count: 0 });
  });

  it('flags rows with missing confidence bounds as wide', async () => {
    makeDb([
      { ...ROW, kc_id: 'kc_b', ci_low: null },
      { ...ROW, kc_id: 'kc_c', ci_high: null },
    ]);
    const res = makeRes();
    await getMastery({ method: 'GET', query: { studentId: 'stu1' } }, res);
    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.count).toBe(2);
    expect(body.mastery.every((row) => row.wide === true)).toBe(true);
  });

  it('applies the subject filter and binds the caller schoolId', async () => {
    const db = makeDb();
    const res = makeRes();
    await getMastery({ method: 'GET', query: { studentId: 'stu1', subject: 'Science' } }, res);
    expect(res.status).toHaveBeenCalledWith(200);
    const { sql, args } = db.execute.mock.calls[0][0];
    expect(sql).toContain('AND subject = ?');
    expect(args).toEqual(['sch_x', 'stu1', 'Science']);
  });

  it('lets skyll_admin override schoolId via query', async () => {
    mocks.user = { role: 'skyll_admin', user_id: 'u3', username: 'root' };
    const db = makeDb();
    const res = makeRes();
    await getMastery({ method: 'GET', query: { studentId: 'stu1', schoolId: 'sch_y' } }, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(db.execute).toHaveBeenCalledWith(expect.objectContaining({ args: ['sch_y', 'stu1'] }));
  });

  it('returns 400 when skyll_admin provides no schoolId', async () => {
    mocks.user = { role: 'skyll_admin', user_id: 'u3', username: 'root' };
    makeDb();
    const res = makeRes();
    await getMastery({ method: 'GET', query: { studentId: 'stu1' } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'schoolId is required' });
  });

  it('rejects non-admin callers whose account has no school', async () => {
    mocks.user = { role: 'teacher', user_id: 'u4', username: 'noSchool' };
    makeDb();
    const res = makeRes();
    await getMastery({ method: 'GET', query: { studentId: 'stu1' } }, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'School access denied' });
  });

  it('blocks non-admin callers from overriding schoolId to another school', async () => {
    const db = makeDb();
    const res = makeRes();
    await getMastery({ method: 'GET', query: { studentId: 'stu1', schoolId: 'sch_other' } }, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'School access denied' });
    expect(db.execute).not.toHaveBeenCalled();
  });
});
