import { beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => {
  const mocks = {
  authenticateUser: vi.fn(),
  clearLoginFailures: vi.fn(),
  createSession: vi.fn(),
  database: vi.fn(() => ({ execute: vi.fn() })),
  ensureAuthTables: vi.fn(),
  reserveLoginAttempt: vi.fn(),
  // Portals declare their school by name; login compares the resolved id (FLKRM-389).
  portalSchoolId: vi.fn(async (name) => ({ PartnerH: 'sch_partnerh', PartnerG: 'sch_partnerg' })[name] || null),
  verifyPassword: vi.fn(),
  };
  // Unknown logins still run a hash check (against a dummy) and fail.
  mocks.verifyPasswordOrDummy = vi.fn((password, hash) => {
    const ok = mocks.verifyPassword(password, hash);
    return hash ? ok : false;
  });
  return mocks;
});

vi.mock('../../api/_lib/auth.js', () => auth);
vi.mock('../../api/_lib/userEvents.js', () => ({
  recordLoginEventSafe: vi.fn(async () => null),
}));

import handler from '../../server/auth/login.js';

function response() {
  return {
    headers: {},
    setHeader: vi.fn(function setHeader(name, value) { this.headers[name] = value; }),
    status: vi.fn(function status(code) { this.statusCode = code; return this; }),
    json: vi.fn(function json(body) { this.body = body; return this; }),
  };
}

describe('login handler security controls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.reserveLoginAttempt.mockResolvedValue({ allowed: true, keyHash: 'key' });
    auth.authenticateUser.mockResolvedValue({
      username: 'student_1',
      password_hash: 'hash',
      role: 'student',
      school: 'PartnerH',
      school_id: 'sch_partnerh',
      active: 1,
    });
    auth.verifyPassword.mockReturnValue(true);
    auth.createSession.mockResolvedValue('token');
  });

  it('rejects a portal-school mismatch before creating a session', async () => {
    const res = response();
    await handler({
      method: 'POST',
      headers: {},
      body: { username: 'student_1', password: 'secret', expectedSchool: 'PartnerG' },
    }, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(auth.createSession).not.toHaveBeenCalled();
    expect(auth.clearLoginFailures).not.toHaveBeenCalled();
  });

  it('rejects login when the password is incorrect', async () => {
    auth.verifyPassword.mockReturnValue(false);
    const res = response();
    await handler({
      method: 'POST',
      headers: {},
      body: { username: 'student_1', password: 'wrong' },
    }, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid username or password' });
    expect(auth.createSession).not.toHaveBeenCalled();
  });

  it('rejects login when the user is inactive', async () => {
    auth.authenticateUser.mockResolvedValue({
      username: 'student_1',
      password_hash: 'hash',
      role: 'student',
      school: 'PartnerH',
      school_id: 'sch_partnerh',
      active: 0,
    });
    const res = response();
    await handler({
      method: 'POST',
      headers: {},
      body: { username: 'student_1', password: 'secret' },
    }, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(auth.createSession).not.toHaveBeenCalled();
  });

  it('rejects login when the user role is not allowed for the portal', async () => {
    const res = response();
    await handler({
      method: 'POST',
      headers: {},
      body: { username: 'student_1', password: 'secret', allowedRoles: ['teacher', 'admin'] },
    }, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'This account does not have access to this portal' });
    expect(auth.createSession).not.toHaveBeenCalled();
  });

  it('authenticates successfully and clears login failures', async () => {
    const res = response();
    await handler({
      method: 'POST',
      headers: {},
      body: { username: 'student_1', password: 'secret' },
    }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(auth.clearLoginFailures).toHaveBeenCalledWith({ allowed: true, keyHash: 'key' });
    expect(auth.createSession).toHaveBeenCalled();
  });

  it('returns retry metadata without checking credentials when the atomic reservation is blocked', async () => {
    auth.reserveLoginAttempt.mockResolvedValue({ allowed: false, retryAfter: 900, keyHash: 'key' });
    const res = response();
    await handler({
      method: 'POST',
      headers: {},
      body: { username: 'student_1', password: 'secret' },
    }, res);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '900');
    expect(auth.authenticateUser).not.toHaveBeenCalled();
  });

  it('asks a multi-school account to pick a portal only after the password checks out', async () => {
    auth.authenticateUser.mockResolvedValue({
      username: 'teacher_1',
      password_hash: 'hash',
      role: 'teacher',
      active: 1,
      needsSchoolPortal: true,
      school_id: null,
      school: null,
    });
    const res = response();
    await handler({
      method: 'POST',
      headers: {},
      body: { username: 'teacher_1', password: 'secret' },
    }, res);

    expect(auth.verifyPassword).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'This account belongs to multiple schools. Sign in through your school portal.' });
    expect(auth.createSession).not.toHaveBeenCalled();
  });

  it('does not reveal a multi-school account when the password is wrong', async () => {
    auth.authenticateUser.mockResolvedValue({
      username: 'teacher_1',
      password_hash: 'hash',
      role: 'teacher',
      active: 1,
      needsSchoolPortal: true,
      school_id: null,
      school: null,
    });
    auth.verifyPassword.mockReturnValue(false);
    const res = response();
    await handler({
      method: 'POST',
      headers: {},
      body: { username: 'teacher_1', password: 'wrong' },
    }, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid username or password' });
    expect(auth.createSession).not.toHaveBeenCalled();
  });

  it('fails closed on an unresolvable login without claiming ambiguity', async () => {
    auth.authenticateUser.mockResolvedValue(null);
    const res = response();
    await handler({
      method: 'POST',
      headers: {},
      body: { username: 'ghost', password: 'secret' },
    }, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(auth.createSession).not.toHaveBeenCalled();
  });

  it('passes the portal roles and an explicit role into membership resolution (FLKRM-387)', async () => {
    await handler({
      method: 'POST',
      headers: {},
      body: { username: 'beta_admin', password: 'secret', expectedSchool: 'PartnerH', allowedRoles: ['scanner', 'admin'], expectedRole: 'scanner' },
    }, response());
    expect(auth.authenticateUser).toHaveBeenCalledWith('beta_admin', 'PartnerH', { allowedRoles: ['scanner', 'admin'], expectedRole: 'scanner' });
  });

  it('asks the user to choose a role only after the password checks out', async () => {
    auth.authenticateUser.mockResolvedValue({ username: 'beta_admin', password_hash: 'hash', active: 1, needsRole: true, roleChoices: ['admin', 'scanner'] });
    const ok = response();
    await handler({ method: 'POST', headers: {}, body: { username: 'beta_admin', password: 'secret' } }, ok);
    expect(ok.statusCode).toBe(409);
    expect(ok.body.roles).toEqual(['admin', 'scanner']);
    expect(auth.createSession).not.toHaveBeenCalled();

    auth.verifyPassword.mockReturnValue(false);
    const wrong = response();
    await handler({ method: 'POST', headers: {}, body: { username: 'beta_admin', password: 'nope' } }, wrong);
    expect(wrong.statusCode).toBe(401);
    expect(wrong.body.roles).toBeUndefined();
  });

  it('refuses a login with no membership the portal accepts', async () => {
    auth.authenticateUser.mockResolvedValue({ username: 'beta_admin', password_hash: 'hash', active: 1, noPortalAccess: true });
    const res = response();
    await handler({ method: 'POST', headers: {}, body: { username: 'beta_admin', password: 'secret', allowedRoles: ['teacher'] } }, res);
    expect(res.statusCode).toBe(403);
    expect(auth.createSession).not.toHaveBeenCalled();
  });

  it('creates the session against the school resolved at login', async () => {
    const res = response();
    await handler({
      method: 'POST',
      headers: {},
      body: { username: 'student_1', password: 'secret' },
    }, res);

    expect(auth.createSession).toHaveBeenCalledWith(res, expect.objectContaining({ school: 'PartnerH' }));
  });

  it('runs a password check even when the login does not exist', async () => {
    auth.reserveLoginAttempt.mockResolvedValue({ allowed: true, retryAfter: 0, keyHash: 'k' });
    auth.authenticateUser.mockResolvedValue(null);
    auth.verifyPassword.mockReturnValue(true);
    const res = response();
    await handler({ method: 'POST', body: { username: 'nobody', password: 'guess' }, headers: {} }, res);
    expect(res.statusCode).toBe(401);
    expect(auth.verifyPasswordOrDummy).toHaveBeenCalledWith('guess', undefined);
  });
});
