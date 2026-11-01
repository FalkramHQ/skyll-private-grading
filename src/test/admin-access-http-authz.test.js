import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockDb = vi.hoisted(() => ({ execute: vi.fn(), batch: vi.fn() }));

const auth = vi.hoisted(() => ({
  database: vi.fn(() => mockDb),
  ensureAuthTables: vi.fn().mockResolvedValue(),
  hashPassword: vi.fn((password) => `scrypt$salt$${password}`),
  requireUser: vi.fn(),
}));

vi.mock('../../api/_lib/auth.js', () => auth);

import handler, { presentMembership } from '../../server/admin/access.js';
import { SCHOOL_FEATURES } from '../../api/_lib/featureFlags.js';

function response() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    setHeader: vi.fn(function setHeader(key, value) { this.headers[key] = value; return this; }),
    status: vi.fn(function status(code) { this.statusCode = code; return this; }),
    json: vi.fn(function json(data) { this.body = data; return this; }),
  };
}

const adminAlpha = { user_id: 'user_admin', username: 'alpha_admin', role: 'admin', school: 'Alpha School', school_id: 'school_alpha' };
const platformAdmin = { user_id: 'user_sky', username: 'skyll_ops', role: 'skyll_admin', school: 'Skyll', school_id: 'school_skyll' };
const alphaSchool = { id: 'school_alpha', slug: 'alpha', display_name: 'Alpha School' };
const betaSchool = { id: 'school_beta', slug: 'beta', display_name: 'Beta School' };

/** Simulates requireUser's role gate so the role allowlist of each route is exercised. */
function signIn(user) {
  auth.requireUser.mockImplementation(async (_req, res, roles) => {
    if (roles && !roles.includes(user.role)) { res.status(403).json({ error: 'You do not have permission for this action' }); return null; }
    return user;
  });
}

const membershipRow = { membership_id: 'mem_1', role: 'school_admin', membership_status: 'active', created_at: '2026-01-01T00:00:00.000Z', user_id: 'user_1', display_name: 'Alpha Admin', user_status: 'active', login_id: 'alpha_admin', credential_status: 'active', school_id: 'school_alpha', school: 'Alpha School', last_session_at: '2026-03-01T00:00:00.000Z' };

describe('admin access routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.execute.mockImplementation(async () => ({ rows: [] }));
    mockDb.batch.mockResolvedValue({});
  });

  it('returns 404 for unknown admin resources', async () => {
    const res = response();
    await handler({ method: 'GET', query: {} }, res, ['nope']);
    expect(res.statusCode).toBe(404);
  });

  describe('users', () => {
    it('refuses teachers', async () => {
      signIn({ ...adminAlpha, role: 'teacher' });
      const res = response();
      await handler({ method: 'GET', query: {} }, res, ['users']);
      expect(res.statusCode).toBe(403);
      expect(mockDb.execute).not.toHaveBeenCalled();
    });

    it('pins a school admin to their own school even when another is requested', async () => {
      signIn(adminAlpha);
      let membershipQuery = null;
      mockDb.execute.mockImplementation(async ({ sql, args }) => {
        if (sql.includes('FROM school_memberships m')) { membershipQuery = { sql, args }; return { rows: [membershipRow] }; }
        return { rows: [] };
      });
      const res = response();
      await handler({ method: 'GET', query: { schoolId: 'school_beta' } }, res, ['users']);
      expect(res.statusCode).toBe(200);
      expect(membershipQuery.sql).toContain('WHERE m.school_id = ?');
      expect(membershipQuery.args[0]).toBe('school_alpha');
      expect(membershipQuery.args).not.toContain('school_beta');
      expect(res.body.scope.schoolId).toBe('school_alpha');
      expect(res.body.users[0]).toMatchObject({ loginId: 'alpha_admin', role: 'admin', school: 'Alpha School', status: 'active', lastSessionAt: '2026-03-01T00:00:00.000Z' });
      expect(res.body.schools).toEqual([{ id: 'school_alpha', name: 'Alpha School' }]);
      expect(res.headers['Cache-Control']).toBe('private, no-store');
    });

    it('lets a platform admin list every school or filter to one', async () => {
      signIn(platformAdmin);
      const queries = [];
      mockDb.execute.mockImplementation(async ({ sql, args }) => {
        if (sql.includes('FROM school_memberships m')) { queries.push({ sql, args }); return { rows: [] }; }
        if (sql.includes('FROM schools WHERE status')) return { rows: [alphaSchool, betaSchool] };
        return { rows: [] };
      });
      let res = response();
      await handler({ method: 'GET', query: {} }, res, ['users']);
      expect(res.statusCode).toBe(200);
      expect(queries[0].sql).not.toContain('m.school_id = ?');
      // Students are excluded unless asked for.
      expect(queries[0].sql).toContain('m.role IN (');
      expect(res.body.schools).toEqual([{ id: 'school_alpha', slug: 'alpha', name: 'Alpha School' }, { id: 'school_beta', slug: 'beta', name: 'Beta School' }]);

      res = response();
      await handler({ method: 'GET', query: { schoolId: 'school_beta', role: 'teacher' } }, res, ['users']);
      expect(queries[1].sql).toContain('m.school_id = ?');
      expect(queries[1].args).toEqual(['school_beta', 'teacher']);
    });

    it('presents inactive credentials as inactive memberships', () => {
      expect(presentMembership({ ...membershipRow, credential_status: 'disabled' }).status).toBe('inactive');
      expect(presentMembership({ ...membershipRow, role: 'teacher' }).role).toBe('teacher');
    });
  });

  describe('flags', () => {
    it('is platform-admin only', async () => {
      signIn(adminAlpha);
      const res = response();
      await handler({ method: 'POST', body: { schoolId: 'school_alpha', featureKey: 'crm', enabled: true } }, res, ['flags']);
      expect(res.statusCode).toBe(403);
      expect(mockDb.execute).not.toHaveBeenCalled();
    });

    it('validates the feature key and the enabled flag', async () => {
      signIn(platformAdmin);
      let res = response();
      await handler({ method: 'POST', body: { schoolId: 'school_alpha', featureKey: 'not_a_feature', enabled: true } }, res, ['flags']);
      expect(res.statusCode).toBe(400);
      expect(res.body.features).toEqual(SCHOOL_FEATURES);

      res = response();
      await handler({ method: 'POST', body: { schoolId: 'school_alpha', featureKey: 'crm', enabled: 'yes' } }, res, ['flags']);
      expect(res.statusCode).toBe(400);
      expect(mockDb.execute).not.toHaveBeenCalled();
    });

    it('upserts the flag for an existing school with the actor as updated_by', async () => {
      signIn(platformAdmin);
      let upsert = null;
      mockDb.execute.mockImplementation(async ({ sql, args }) => {
        if (sql.includes('FROM schools WHERE id = ?')) return { rows: args[0] === 'school_alpha' ? [alphaSchool] : [] };
        if (sql.includes('INSERT INTO school_feature_flags')) { upsert = { sql, args }; return { rows: [] }; }
        return { rows: [] };
      });
      let res = response();
      await handler({ method: 'POST', body: { schoolId: 'school_missing', featureKey: 'crm', enabled: true } }, res, ['flags']);
      expect(res.statusCode).toBe(404);

      res = response();
      await handler({ method: 'POST', body: { schoolId: 'school_alpha', featureKey: 'deep_signals', enabled: true } }, res, ['flags']);
      expect(res.statusCode).toBe(200);
      expect(upsert.sql).toContain('ON CONFLICT(school_id, feature_key) DO UPDATE');
      expect(upsert.args.slice(0, 4)).toEqual(['school_alpha', 'deep_signals', 1, 'skyll_ops']);
      expect(res.body.flag).toMatchObject({ schoolId: 'school_alpha', featureKey: 'deep_signals', enabled: true, updatedBy: 'skyll_ops' });
    });

    it('lists flags with the allowed feature keys and schools', async () => {
      signIn(platformAdmin);
      mockDb.execute.mockImplementation(async ({ sql }) => {
        if (sql.includes('FROM school_feature_flags f')) return { rows: [{ school_id: 'school_alpha', school: 'Alpha School', feature_key: 'crm', enabled: 1, updated_by: 'skyll_ops', updated_at: '2026-01-01T00:00:00.000Z' }] };
        if (sql.includes('FROM schools WHERE status')) return { rows: [alphaSchool] };
        return { rows: [] };
      });
      const res = response();
      await handler({ method: 'GET', query: {} }, res, ['flags']);
      expect(res.statusCode).toBe(200);
      expect(res.body.features).toEqual(SCHOOL_FEATURES);
      expect(res.body.flags).toEqual([{ schoolId: 'school_alpha', school: 'Alpha School', featureKey: 'crm', enabled: true, updatedBy: 'skyll_ops', updatedAt: '2026-01-01T00:00:00.000Z' }]);
    });
  });

  describe('teachers', () => {
    function schoolLookups() {
      mockDb.execute.mockImplementation(async ({ sql, args }) => {
        if (sql.includes('FROM schools WHERE id = ?')) return { rows: [alphaSchool, betaSchool].filter((school) => school.id === args[0]) };
        return { rows: [] };
      });
    }

    it('refuses teachers and scanners', async () => {
      signIn({ ...adminAlpha, role: 'teacher' });
      const res = response();
      await handler({ method: 'POST', body: { displayName: 'New Teacher' } }, res, ['teachers']);
      expect(res.statusCode).toBe(403);
    });

    it('creates the teacher in the school admin\'s own school and returns the password once', async () => {
      signIn(adminAlpha);
      schoolLookups();
      const res = response();
      await handler({ method: 'POST', body: { schoolId: 'school_beta', displayName: 'Priya Sharma' } }, res, ['teachers']);
      expect(res.statusCode).toBe(201);
      expect(res.body.teacher).toMatchObject({ displayName: 'Priya Sharma', loginId: 'alpha_priya_sharma', role: 'teacher', schoolId: 'school_alpha', school: 'Alpha School', loginUrl: '/alpha' });
      expect(res.body.password).toMatch(/^[A-Za-z0-9_-]{12,24}$/);
      const [users, credential, membership] = mockDb.batch.mock.calls[0][0];
      expect(users.sql).toContain('INSERT INTO users');
      expect(credential.sql).toContain('INSERT INTO user_credentials');
      expect(credential.args[2]).toBe('alpha_priya_sharma');
      expect(credential.args[3]).toBe(`scrypt$salt$${res.body.password}`);
      expect(membership.sql).toContain("'teacher', 'active'");
      expect(membership.args[1]).toBe('school_alpha');
    });

    it('requires a platform admin to name the school', async () => {
      signIn(platformAdmin);
      schoolLookups();
      let res = response();
      await handler({ method: 'POST', body: { displayName: 'Priya Sharma' } }, res, ['teachers']);
      expect(res.statusCode).toBe(400);

      res = response();
      await handler({ method: 'POST', body: { schoolId: 'school_beta', displayName: 'Priya Sharma', loginId: 'beta.priya' } }, res, ['teachers']);
      expect(res.statusCode).toBe(201);
      expect(res.body.teacher).toMatchObject({ loginId: 'beta.priya', schoolId: 'school_beta' });
    });

    it('rejects malformed or taken login ids and short names', async () => {
      signIn(adminAlpha);
      mockDb.execute.mockImplementation(async ({ sql, args }) => {
        if (sql.includes('FROM schools WHERE id = ?')) return { rows: [alphaSchool] };
        if (sql.includes('FROM user_credentials WHERE login_id = ?')) return { rows: args[0] === 'taken_login' ? [{ 1: 1 }] : [] };
        return { rows: [] };
      });
      let res = response();
      await handler({ method: 'POST', body: { displayName: 'P' } }, res, ['teachers']);
      expect(res.statusCode).toBe(400);

      res = response();
      await handler({ method: 'POST', body: { displayName: 'Priya Sharma', loginId: 'Bad Login!' } }, res, ['teachers']);
      expect(res.statusCode).toBe(400);

      res = response();
      await handler({ method: 'POST', body: { displayName: 'Priya Sharma', loginId: 'taken_login' } }, res, ['teachers']);
      expect(res.statusCode).toBe(409);
      expect(mockDb.batch).not.toHaveBeenCalled();
    });
  });
});
