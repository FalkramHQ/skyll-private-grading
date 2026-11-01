import { beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  clearLoginFailures: vi.fn(),
  database: vi.fn(),
  ensureAuthTables: vi.fn(),
  hashPassword: vi.fn(),
  requireUser: vi.fn(),
  reserveLoginAttempt: vi.fn(),
  verifyPassword: vi.fn(),
}));

vi.mock('../../api/_lib/auth.js', () => auth);

import changePassword from '../../server/auth/changePassword.js';
import profile from '../../server/auth/profile.js';

function response() {
  return {
    headers: {},
    setHeader: vi.fn(function setHeader(name, value) { this.headers[name] = value; }),
    status: vi.fn(function status(code) { this.statusCode = code; return this; }),
    json: vi.fn(function json(body) { this.body = body; return this; }),
  };
}

const student = { user_id: 'user_1', school_id: 'school_1', username: 'ab12cd', role: 'student' };
const teacher = { user_id: 'user_2', school_id: 'school_1', username: 'teach01', role: 'teacher' };
const admin = { user_id: 'admin_1', school_id: 'school_1', username: 'admin', role: 'admin' };

describe('student profile authentication handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.requireUser.mockResolvedValue(teacher);
    auth.reserveLoginAttempt.mockResolvedValue({ allowed: true, keyHash: 'attempt_1' });
    auth.hashPassword.mockReturnValue('scrypt$new');
  });

  it('returns only the approved school-scoped profile fields', async () => {
    auth.requireUser.mockResolvedValue(student);
    const db = { execute: vi.fn()
      .mockResolvedValueOnce({ rows: [{ student_id: 'student_1', name: 'Aarav Shah', username: 'ab12cd', school: 'Example School' }] })
      .mockResolvedValueOnce({ rows: [{ standard: '10' }] })
      .mockResolvedValueOnce({ rows: [
        { name: 'Science A', grade: '10', board: 'CBSE' },
        { name: 'Maths A', grade: '10', board: 'CBSE' },
      ] }),
    };
    auth.database.mockReturnValue(db);
    const res = response();

    await profile({ method: 'GET' }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body).toEqual({
      profile: {
        name: 'Aarav Shah', class: '10', school: 'Example School', username: 'ab12cd',
        batches: ['Maths A', 'Science A'], board: 'CBSE',
      },
    });
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    expect(db.execute.mock.calls[0][0].args).toEqual(['school_1', 'school_1', 'user_1']);
  });

  it('rejects a student self-service password change with a non-sensitive error', async () => {
    auth.requireUser.mockResolvedValue(student);
    const db = { execute: vi.fn(), batch: vi.fn() };
    auth.database.mockReturnValue(db);
    const res = response();

    await changePassword({ method: 'POST', body: { currentPassword: 'Old123', newPassword: 'New123' } }, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.body.error).toMatch(/managed by your school/i);
    expect(db.execute).not.toHaveBeenCalled();
    expect(db.batch).not.toHaveBeenCalled();
  });

  it('changes only the primary credential and revokes all sessions for a teacher', async () => {
    const db = {
      execute: vi.fn().mockResolvedValue({ rows: [{ id: 'credential_1', password_hash: 'scrypt$old' }] }),
      batch: vi.fn().mockResolvedValue({}),
    };
    auth.database.mockReturnValue(db);
    auth.verifyPassword.mockReturnValueOnce(true).mockReturnValueOnce(false);
    const res = response();

    await changePassword({ method: 'POST', body: { currentPassword: 'Old123', newPassword: 'NewTeacher123' } }, res);

    expect(auth.requireUser).toHaveBeenCalledWith(expect.anything(), res, ['student', 'teacher', 'admin']);
    expect(db.batch).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ sql: expect.stringContaining('UPDATE user_credentials'), args: ['scrypt$new', expect.any(String), 'credential_1', 'user_2'] }),
      expect.objectContaining({ sql: expect.stringContaining('UPDATE sessions'), args: [expect.any(String), 'user_2'] }),
    ]), 'write');
    expect(auth.clearLoginFailures).toHaveBeenCalledWith({ allowed: true, keyHash: 'attempt_1' });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body.message).toContain('sign in again');
  });

  it('allows school admins to change their password with the staff policy', async () => {
    auth.requireUser.mockResolvedValue(admin);
    const db = {
      execute: vi.fn().mockResolvedValue({ rows: [{ id: 'credential_1', password_hash: 'scrypt$old' }] }),
      batch: vi.fn().mockResolvedValue({}),
    };
    auth.database.mockReturnValue(db);
    auth.verifyPassword.mockReturnValueOnce(true).mockReturnValueOnce(false);
    const res = response();

    await changePassword({ method: 'POST', body: { currentPassword: 'old_admin_pass', newPassword: 'new_admin_pass1' } }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(db.batch).toHaveBeenCalled();
  });

  it('does not update a credential when the current password is incorrect (staff)', async () => {
    const db = {
      execute: vi.fn().mockResolvedValue({ rows: [{ id: 'credential_1', password_hash: 'scrypt$old' }] }),
      batch: vi.fn(),
    };
    auth.database.mockReturnValue(db);
    auth.verifyPassword.mockReturnValue(false);
    const res = response();

    await changePassword({ method: 'POST', body: { currentPassword: 'Wrong1', newPassword: 'NewTeacher123' } }, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(db.batch).not.toHaveBeenCalled();
    expect(auth.clearLoginFailures).not.toHaveBeenCalled();
  });
});
