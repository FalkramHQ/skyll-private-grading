import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Buffer } from 'buffer';

const mockClient = vi.hoisted(() => ({
  execute: vi.fn(),
}));

vi.mock('@libsql/client/web', () => ({
  createClient: vi.fn(() => mockClient),
}));

vi.mock('../../api/_lib/env.js', () => ({
  tursoUrl: 'http://mock-turso-url',
  tursoAuthToken: 'mock-token',
}));

const auth = vi.hoisted(() => ({
  ensureAuthTables: vi.fn().mockResolvedValue(),
  requireUser: vi.fn(),
  schoolMatches: vi.fn((actual, expected) => actual === expected),
}));

vi.mock('../../api/_lib/auth.js', () => auth);
vi.mock('../../api/_lib/canonicalSubmissions.js', () => ({
  // Name -> id lookup used by inActorSchool (FLKRM-389).
  resolveSchoolId: vi.fn(async (_db, name) => ({ 'Alpha School': 'school_a', 'Beta School': 'school_b' })[name] || null),
}));

const storage = vi.hoisted(() => ({
  getObject: vi.fn(),
}));

vi.mock('../../api/_lib/storage.js', () => storage);

import handler from '../../api/student-answer-sheet.js';

function response() {
  const res = {
    statusCode: null,
    body: null,
    endedWith: null,
    headers: {},
    setHeader: vi.fn(function setHeader(k, v) { this.headers[k] = v; return this; }),
    status: vi.fn(function status(code) { this.statusCode = code; return this; }),
    json: vi.fn(function json(data) { this.body = data; return this; }),
    end: vi.fn(function end(buffer) { this.endedWith = buffer; return this; }),
  };
  return res;
}

describe('student-answer-sheet API privacy and access control', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects cross-student requests with 403 when a student tries to view another students answer sheet', async () => {
    auth.requireUser.mockResolvedValueOnce({ username: 'student_1', role: 'student', school: 'Alpha School', school_id: 'school_a' });
    const res = response();
    await handler({ method: 'GET', query: { student: 'student_2' } }, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('You can only view your own answer sheet');
    expect(mockClient.execute).not.toHaveBeenCalled();
  });

  it('rejects cross-school review requests by school admins with 403', async () => {
    auth.requireUser.mockResolvedValueOnce({ username: 'admin_a', role: 'admin', school: 'Alpha School', school_id: 'school_a' });
    mockClient.execute.mockResolvedValueOnce({
      rows: [{ school: 'Beta School', id: 'ts_99' }],
    });
    mockClient.execute.mockResolvedValueOnce({
      rows: [{ id: 'fa_1', storage_key: 'r2-secret-key-123', mime_type: 'image/jpeg', byte_size: 1024, created_at: '2026-08-01' }],
    });

    const res = response();
    await handler({ method: 'GET', query: { testId: 'test_x', testStudentId: 'ts_99' } }, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('School access denied');
    expect(storage.getObject).not.toHaveBeenCalled();
  });

  it('never exposes permanent unsigned R2 URLs when serving answer sheet pages; pipes bytes with no-store cache control', async () => {
    auth.requireUser.mockResolvedValueOnce({ username: 'student_1', role: 'student', school: 'Alpha School', school_id: 'school_a' });
    
    // Resolve all logins
    mockClient.execute.mockResolvedValueOnce({ rows: [{ login_id: 'student_1' }] });
    // Report versions matching test
    mockClient.execute.mockResolvedValueOnce({
      rows: [{
        school: 'Alpha School',
        payload_json: JSON.stringify({ term1: { subjects: [{ name: 'Chemistry' }] } }),
        test_id: 'test_chem',
        test_student_id: 'ts_1',
      }],
    });
    // Assets lookup
    mockClient.execute.mockResolvedValueOnce({
      rows: [{ id: 'fa_1', storage_key: 'r2-permanent-storage-key.jpeg', mime_type: 'image/jpeg', byte_size: 2048, created_at: '2026-08-01' }],
    });
    
    const fakeArrayBuffer = new Uint8Array([255, 216, 255]).buffer;
    storage.getObject.mockResolvedValueOnce({
      ok: true,
      headers: new Map([['content-type', 'image/jpeg']]),
      arrayBuffer: async () => fakeArrayBuffer,
    });

    const res = response();
    await handler({ method: 'GET', query: { student: 'student_1', subject: 'Chemistry', testId: 'test_chem', page: '1' } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    expect(res.endedWith.length).toBe(3);
    expect(res.endedWith[0]).toBe(255);
    // Assert zero leaked R2 storage key in response
    const resString = JSON.stringify({ body: res.body, headers: res.headers });
    expect(resString).not.toContain('r2-permanent-storage-key.jpeg');
  });
});
