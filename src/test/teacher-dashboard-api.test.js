import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockDb = vi.hoisted(() => ({
  execute: vi.fn(),
}));

const auth = vi.hoisted(() => ({
  database: vi.fn(() => mockDb),
  ensureAuthTables: vi.fn().mockResolvedValue(),
  requireUser: vi.fn(),
  schoolMatches: vi.fn((actual, expected) => actual === expected),
}));

const canonical = vi.hoisted(() => ({
  resolveSchoolId: vi.fn(),
}));

vi.mock('../../api/_lib/auth.js', () => auth);
vi.mock('../../api/_lib/canonicalSubmissions.js', () => canonical);

import handler from '../../api/teacher-dashboard.js';

function response() {
  const res = {
    statusCode: null,
    body: null,
    headers: {},
    setHeader: vi.fn(function setHeader(k, v) { this.headers[k] = v; return this; }),
    status: vi.fn(function status(code) { this.statusCode = code; return this; }),
    json: vi.fn(function json(data) { this.body = data; return this; }),
  };
  return res;
}

describe('teacher-dashboard API HTTP authorization and scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canonical.resolveSchoolId.mockImplementation(async (_db, name) => {
      if (name === 'Alpha School') return 'school_a';
      if (name === 'Beta School') return 'school_b';
      return null;
    });
  });

  it('rejects unsupported HTTP methods with 405', async () => {
    const res = response();
    await handler({ method: 'POST', query: {} }, res);
    expect(res.statusCode).toBe(405);
  });

  it('stops immediately when authentication fails with 401', async () => {
    auth.requireUser.mockImplementationOnce(async (_req, res, _roles) => {
      res.status(401).json({ error: 'Authentication required' });
      return null;
    });
    const res = response();
    await handler({ method: 'GET', query: {} }, res);
    expect(res.statusCode).toBe(401);
    expect(mockDb.execute).not.toHaveBeenCalled();
  });

  it('enforces school tenancy for school admins by scoping queries to their exact school ID', async () => {
    auth.requireUser.mockResolvedValueOnce({ username: 'admin_a', role: 'admin', school: 'Alpha School', school_id: 'school_a' });
    
    mockDb.execute.mockImplementation(async ({ sql, args }) => {
      if (sql.includes('FROM academic_years')) return { rows: [{ id: 'ay_1', label: '2025-26', is_current: 1 }] };
      if (sql.includes('FROM exams')) {
        expect(args[0]).toBe('school_a'); // Enforce strict tenant ID check
        expect(sql).toContain('EXISTS');
        expect(sql).toContain('FROM submissions s');
        return { rows: [{ id: 'exam_1', source_test_id: 'test_1', name: 'Physics Test', grade: '11th', subject: 'Physics' }] };
      }
      if (sql.includes('FROM submissions')) {
        expect(args[0]).toBe('school_a');
        return { rows: [{ id: 'sub_1', exam_id: 'exam_1', student_id: 'st_1', score: 45, max_marks: 50, student_name: 'Asha' }] };
      }
      if (sql.includes('FROM cohort_report_cache')) return { rows: [] };
      if (sql.includes('INSERT INTO cohort_report_cache')) return { rows: [] };
      if (sql.includes('FROM user_credentials')) return { rows: [] };
      return { rows: [] };
    });

    const res = response();
    await handler({ method: 'GET', query: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.report.school).toBe('Alpha School');
    expect(res.body.report.cohort_report.overview.average_performance).toBe('90%');
    expect(res.body.exams).toHaveLength(1);
    expect(res.body.exams[0].id).toBe('exam_1');
  });

  it("scopes by the session's school_id, never by resolving the display name (FLKRM-385)", async () => {
    // The display name would resolve to school_a; the pinned id says school_b.
    auth.requireUser.mockResolvedValueOnce({ username: 'admin_b', role: 'admin', school: 'Alpha School', school_id: 'school_b' });
    const scoped = [];
    mockDb.execute.mockImplementation(async ({ sql, args }) => {
      if (/FROM (academic_years|exams|submissions)/.test(sql)) scoped.push(args[0]);
      return { rows: [] };
    });
    await handler({ method: 'GET', query: {} }, response());
    expect(canonical.resolveSchoolId).not.toHaveBeenCalled();
    expect(scoped.length).toBeGreaterThan(0);
    expect(new Set(scoped)).toEqual(new Set(['school_b']));
  });

  it('refuses a session with no school_id instead of resolving the name', async () => {
    auth.requireUser.mockResolvedValueOnce({ username: 'admin_a', role: 'admin', school: 'Alpha School' });
    const res = response();
    await handler({ method: 'GET', query: {} }, res);
    expect(res.statusCode).toBe(404);
    expect(mockDb.execute).not.toHaveBeenCalled();
  });

  it('loads per-exam student cards without scanning report payload_json', async () => {
    auth.requireUser.mockResolvedValueOnce({ username: 'admin_a', role: 'admin', school: 'Alpha School', school_id: 'school_a' });

    mockDb.execute.mockImplementation(async ({ sql, args }) => {
      if (sql.includes('FROM academic_years')) return { rows: [{ id: 'ay_1', label: '2025-26', is_current: 1 }] };
      if (sql.includes('FROM exams')) {
        expect(sql).toContain('COALESCE(e.source_test_id, e.id) = ?');
        expect(args).toContain('test_1');
        return { rows: [{ id: 'exam_1', source_test_id: 'test_1', name: 'Physics Test', grade: '11th', subject: 'Physics' }] };
      }
      if (sql.includes('FROM submissions s') && sql.includes('student_name')) {
        return { rows: [{ id: 'sub_1', exam_id: 'exam_1', student_id: 'st_1', score: 45, max_marks: 50, student_name: 'Asha' }] };
      }
      if (sql.includes('FROM report_versions rv')) {
        expect(sql).not.toContain('payload_json');
        expect(sql).not.toContain('LIKE');
        expect(args).toEqual(['school_a', 'test_1']);
        return {
          rows: [{
            submission_id: 'sub_1',
            username: 'asha',
            score: 45,
            max_marks: 50,
            student_name: 'Asha',
            student_class: '11th',
            subject_name: 'Physics',
            test_id: 'test_1',
          }],
        };
      }
      if (sql.includes('FROM cohort_report_cache')) return { rows: [] };
      if (sql.includes('INSERT INTO cohort_report_cache')) return { rows: [] };
      if (sql.includes('FROM user_credentials')) return { rows: [] };
      if (sql.includes('FROM submission_questions_v2')) return { rows: [] };
      return { rows: [] };
    });

    const res = response();
    await handler({ method: 'GET', query: { exam_id: 'test_1' } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.studentReports).toEqual([
      expect.objectContaining({
        username: 'asha',
        test_id: 'test_1',
        student: { name: 'Asha', class: '11th' },
        term1: { subjects: [{ name: 'Physics', score: 45, total: 50 }] },
      }),
    ]);
  });
});
