import { beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ database: vi.fn(), ensureAuthTables: vi.fn(), requireUser: vi.fn() }));
vi.mock('../../api/_lib/auth.js', () => auth);

import teacherProfile from '../../server/auth/teacherProfile.js';
import teacherRoster, { normalizeRosterName } from '../../server/auth/teacherRoster.js';

function response() {
  return {
    headers: {},
    setHeader: vi.fn(function setHeader(name, value) { this.headers[name] = value; }),
    status: vi.fn(function status(code) { this.statusCode = code; return this; }),
    json: vi.fn(function json(body) { this.body = body; return this; }),
  };
}

describe('normalizeRosterName', () => {
  it('treats Shrivastava and Srivastava as the same roster name', () => {
    expect(normalizeRosterName('Demo Shrivastava')).toBe(normalizeRosterName('Demo Srivastava'));
    expect(normalizeRosterName('  Sample   Teacher ')).toBe('sample teacher');
  });
});

describe('teacher roster authorization', () => {
  let db;

  beforeEach(() => {
    vi.clearAllMocks();
    auth.requireUser.mockResolvedValue({ user_id: 'teacher_1', school_id: 'school_1', school: 'Example School', role: 'teacher', username: 'teacher' });
    db = { execute: vi.fn(), batch: vi.fn() };
    auth.database.mockReturnValue(db);
  });

  it('returns a teacher profile only for the canonical school membership', async () => {
    db.execute.mockResolvedValue({ rows: [{ name: 'Asha Teacher', username: 'teacher', school: 'Example School' }] });
    const res = response();
    await teacherProfile({ method: 'GET' }, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body).toEqual({ profile: { name: 'Asha Teacher', username: 'teacher', school: 'Example School' } });
    expect(db.execute.mock.calls[0][0].args).toEqual(['school_1', 'teacher_1']);
    expect(auth.requireUser).toHaveBeenCalledWith(expect.anything(), res, ['teacher', 'admin']);
  });

  it('allows school admins to load the teacher profile endpoint', async () => {
    auth.requireUser.mockResolvedValue({ user_id: 'admin_1', school_id: 'school_1', school: 'Example School', role: 'admin', username: 'admin' });
    db.execute.mockResolvedValue({ rows: [{ name: 'School Admin', username: 'admin', school: 'Example School' }] });
    const res = response();
    await teacherProfile({ method: 'GET' }, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(db.execute.mock.calls[0][0].sql).toMatch(/role IN \('teacher', 'school_admin'\)/);
  });

  it('lists only roster records constrained by the teacher school id', async () => {
    db.execute
      .mockResolvedValueOnce({ rows: [{ id: 'batch_1', name: 'Batch A', grade: '10', board: 'CBSE', stream: null, academic_year: null, student_count: 1 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'student_1', display_name: 'Aarav', username: 'aa11bb', batch_ids: 'batch_1', batch_names: 'Batch A' }] });
    const res = response();
    await teacherRoster({ method: 'GET' }, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body.students[0]).toMatchObject({ name: 'Aarav', batchIds: ['batch_1'] });
    for (const call of db.execute.mock.calls) expect(call[0].args[0]).toBe('school_1');
    expect(auth.requireUser).toHaveBeenCalledWith(expect.anything(), res, ['teacher', 'admin']);
  });

  it('refuses a student creation request when any selected batch is outside the teacher school', async () => {
    db.execute.mockResolvedValue({ rows: [] });
    const res = response();
    await teacherRoster({ method: 'POST', body: { resource: 'student', name: 'Aarav', batchIds: ['foreign_batch'] } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.error).toMatch(/selected batches are unavailable/i);
    expect(db.batch).not.toHaveBeenCalled();
  });

  it('refuses creating a student when an active roster name already exists', async () => {
    db.execute
      .mockResolvedValueOnce({ rows: [{ id: 'batch_1', grade: '9th', academic_year_id: null }] })
      .mockResolvedValueOnce({ rows: [{ id: 'student_1', display_name: 'Demo Srivastava', username: 'rksykz' }] });
    const res = response();
    await teacherRoster({
      method: 'POST',
      body: { resource: 'student', name: 'Demo Shrivastava', batchIds: ['batch_1'] },
    }, res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.body.error).toMatch(/already exists/i);
    expect(db.batch).not.toHaveBeenCalled();
  });
});
