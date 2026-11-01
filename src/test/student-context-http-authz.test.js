import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockDb = vi.hoisted(() => ({ execute: vi.fn() }));

const auth = vi.hoisted(() => ({
  database: vi.fn(() => mockDb),
  ensureAuthTables: vi.fn().mockResolvedValue(),
  requireUser: vi.fn(),
  schoolMatches: vi.fn((actual, expected) => actual === expected),
}));

const learnerDna = vi.hoisted(() => ({ generateLongitudinalDna: vi.fn(() => null) }));

vi.mock('../../api/_lib/auth.js', () => auth);
vi.mock('../../api/_lib/canonicalSubmissions.js', () => ({
  // Name -> id lookup used by inActorSchool (FLKRM-389).
  resolveSchoolId: vi.fn(async (_db, name) => ({ 'Alpha School': 'school_a', 'Beta School': 'school_b' })[name] || null),
}));
vi.mock('../../api/_lib/learnerDnaRefresh.js', () => learnerDna);

import handler from '../../api/student-context.js';

function response() {
  const res = {
    statusCode: null,
    body: null,
    setHeader: vi.fn(function setHeader(k, v) { this.headers = this.headers || {}; this.headers[k] = v; return this; }),
    status: vi.fn(function status(code) { this.statusCode = code; return this; }),
    json: vi.fn(function json(data) { this.body = data; return this; }),
  };
  return res;
}

function seededDb(schoolName) {
  mockDb.execute.mockImplementation(async ({ sql, args }) => {
    if (sql.includes('FROM user_credentials uc1')) return { rows: [{ login_id: args[0] }] };
    if (sql.includes('FROM report_versions') && sql.includes('username IN')) {
      return {
        rows: [{
          username: 'student_a',
          school: schoolName,
          submission_id: 'sub_1',
          published_at: '2026-01-01T00:00:00.000Z',
          payload_json: JSON.stringify({
            exams: [{ id: 'exam_1', name: 'Physics Test', date: '2026-01-01' }],
            term1: { overall_insights: { strongest_area: 'Motion', focus_needed: [], pattern: '' }, subjects: [{ name: 'Physics', score: 45, max: 50 }] },
            student: { name: 'Asha', class: '11th', school: schoolName },
          }),
        }],
      };
    }
    if (sql.includes('learner_dna')) return { rows: [] };
    if (sql.includes('FROM submissions')) return { rows: [] };
    return { rows: [] };
  });
}

describe('student-context release gate', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  function reportSql() {
    return mockDb.execute.mock.calls.map(([call]) => call.sql).find((sql) => sql.includes('FROM report_versions') && sql.includes('username IN'));
  }

  it('shows a student only exams a teacher has released', async () => {
    seededDb('Alpha School');
    auth.requireUser.mockResolvedValueOnce({ username: 'student_a', role: 'student', school: 'Alpha School', school_id: 'school_a' });
    await handler({ method: 'GET', query: {} }, response());
    expect(reportSql()).toContain('released_exam.released_at IS NOT NULL');
  });

  it('shows a teacher every graded exam', async () => {
    seededDb('Alpha School');
    auth.requireUser.mockResolvedValueOnce({ username: 'teacher_a', role: 'teacher', school: 'Alpha School', school_id: 'school_a' });
    await handler({ method: 'GET', query: { username: 'student_a' } }, response());
    expect(reportSql()).not.toContain('released_at');
  });
});

describe('student-context HTTP handler authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects non-GET methods with 405', async () => {
    const res = response();
    await handler({ method: 'POST', query: {} }, res);
    expect(res.statusCode).toBe(405);
  });

  it('stops when authentication fails with 401', async () => {
    auth.requireUser.mockImplementationOnce(async (_req, res) => {
      res.status(401).json({ error: 'Sign in required' });
      return null;
    });
    const res = response();
    await handler({ method: 'GET', query: {} }, res);
    expect(res.statusCode).toBe(401);
    expect(mockDb.execute).not.toHaveBeenCalled();
  });

  it('denies a student requesting another student report with 403', async () => {
    seededDb('Alpha School');
    auth.requireUser.mockResolvedValueOnce({ username: 'student_b', role: 'student', school: 'Alpha School', school_id: 'school_a' });
    const res = response();
    await handler({ method: 'GET', query: { username: 'student_a' } }, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('You do not have permission to view this report');
  });

  it('denies a cross-school staff member before returning protected report data', async () => {
    seededDb('Beta School');
    auth.requireUser.mockResolvedValueOnce({ username: 'admin_a', role: 'admin', school: 'Alpha School', school_id: 'school_a' });
    const res = response();
    await handler({ method: 'GET', query: { username: 'student_a' } }, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('School access denied');
  });

  it('serves the report to the owning student', async () => {
    seededDb('Alpha School');
    auth.requireUser.mockResolvedValueOnce({ username: 'student_a', role: 'student', school: 'Alpha School', school_id: 'school_a' });
    const res = response();
    await handler({ method: 'GET', query: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.report).toBeTruthy();
    expect(res.body.report.report_status).toBe('published');
  });

  it('allows a skyll_admin to read across schools', async () => {
    seededDb('Beta School');
    auth.requireUser.mockResolvedValueOnce({ username: 'sky_admin', role: 'skyll_admin', school: '' });
    const res = response();
    await handler({ method: 'GET', query: { username: 'student_a' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.report).toBeTruthy();
  });

  it("merges only the caller's school's reports for a login with reports in two schools (FLKRM-384)", async () => {
    const row = (school, exam, subject, at) => ({
      username: 'student_a', school, submission_id: `sub_${exam}`, published_at: at,
      payload_json: JSON.stringify({
        exams: [{ id: exam, name: `${exam} paper`, date: at }],
        term1: { overall_insights: { strongest_area: subject, focus_needed: [], pattern: '' }, subjects: [{ name: subject, score: 40, max: 50 }] },
        student: { name: 'Asha', class: '11th', school },
      }),
    });
    mockDb.execute.mockImplementation(async ({ sql, args }) => {
      if (sql.includes('FROM user_credentials uc1')) return { rows: [{ login_id: args[0] }] };
      if (sql.includes('FROM report_versions') && sql.includes('username IN')) {
        // Newest first: the Alpha row is newest, so the old single-row check passed.
        return { rows: [row('Alpha School', 'alpha_exam', 'Physics', '2026-02-01'), row('Beta School', 'beta_exam', 'Chemistry', '2026-01-01')] };
      }
      return { rows: [] };
    });

    auth.requireUser.mockResolvedValueOnce({ username: 'admin_a', role: 'admin', school: 'Alpha School', school_id: 'school_a' });
    const alpha = response();
    await handler({ method: 'GET', query: { username: 'student_a' } }, alpha);
    expect(alpha.statusCode).toBe(200);
    expect(JSON.stringify(alpha.body)).toContain('alpha_exam');
    expect(JSON.stringify(alpha.body)).not.toContain('beta_exam');

    auth.requireUser.mockResolvedValueOnce({ username: 'admin_c', role: 'admin', school: 'Gamma School' });
    const gamma = response();
    await handler({ method: 'GET', query: { username: 'student_a' } }, gamma);
    expect(gamma.statusCode).toBe(403);
  });

  it('returns 404 when the student has no published report', async () => {
    mockDb.execute.mockImplementation(async () => ({ rows: [] }));
    auth.requireUser.mockResolvedValueOnce({ username: 'admin_a', role: 'admin', school: 'Alpha School', school_id: 'school_a' });
    const res = response();
    await handler({ method: 'GET', query: { username: 'student_missing' } }, res);
    expect(res.statusCode).toBe(404);
  });

  it('never merges another student who shares the name and class', async () => {
    const calls = [];
    mockDb.execute.mockImplementation(async ({ sql, args }) => {
      calls.push(sql);
      if (sql.includes('FROM user_credentials uc1')) return { rows: [{ login_id: args[0] }] };
      if (sql.includes('UNION') && sql.includes('student_user_links sul')) return { rows: [{ id: 'stu_asha_1' }] };
      if (sql.includes('FROM report_versions') && sql.includes('username IN')) {
        // Only rows for this student's own login or canonical id are returned.
        expect(args).toEqual(['student_a', 'stu_asha_1']);
        return {
          rows: [{
            username: 'student_a', school: 'Alpha School', student_id: 'stu_asha_1', submission_id: 'sub_1', published_at: '2026-01-01',
            payload_json: JSON.stringify({
              exams: [{ id: 'exam_1', name: 'Physics Test', date: '2026-01-01' }],
              term1: { subjects: [{ name: 'Physics', score: 45, max: 50 }] },
              student: { name: 'Asha', class: '11th', school: 'Alpha School' },
            }),
          }],
        };
      }
      return { rows: [] };
    });
    auth.requireUser.mockResolvedValueOnce({ username: 'student_a', role: 'student', school: 'Alpha School', school_id: 'school_a' });
    const res = response();
    await handler({ method: 'GET', query: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.report.term1.subjects.map((subject) => subject.name)).toEqual(['Physics']);
    expect(calls.some((sql) => /payload_json LIKE/i.test(sql))).toBe(false);
  });

  it("ranks the student's own exam, scoped by school id, newest exam per subject", async () => {
    let rankArgs = null;
    mockDb.execute.mockImplementation(async ({ sql, args }) => {
      if (sql.includes('FROM user_credentials uc1')) return { rows: [{ login_id: args[0] }] };
      if (sql.includes('UNION') && sql.includes('student_user_links sul')) return { rows: [{ id: 'stu_asha_1' }] };
      if (sql.includes('FROM report_versions') && sql.includes('username IN')) {
        return {
          rows: [{
            username: 'student_a', school: 'Alpha School', student_id: 'stu_asha_1', submission_id: 'sub_1', published_at: '2026-01-01',
            payload_json: JSON.stringify({ exams: [{ id: 'exam_2' }], term1: { subjects: [{ name: 'Physics' }] }, student: { name: 'Asha', school: 'Alpha School' } }),
          }],
        };
      }
      if (sql.includes('RANK() OVER')) {
        rankArgs = args;
        expect(sql).toContain('e.school_id = ?');
        return {
          rows: [
            { student_id: 'stu_asha_1', exam_name: 'Unit 2', subject_name: 'Physics', rank_in_exam: 2, total: 40 },
            { student_id: 'stu_asha_1', exam_name: 'Unit 1', subject_name: 'Physics', rank_in_exam: 30, total: 40 },
          ],
        };
      }
      return { rows: [] };
    });
    auth.requireUser.mockResolvedValueOnce({ username: 'student_a', role: 'student', school: 'Alpha School', school_id: 'school_a' });
    const res = response();
    await handler({ method: 'GET', query: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(rankArgs[0]).toBe('school_a');
    expect(res.body.classRanks.Physics).toMatchObject({ rank: 2, total: 40, percentile: 98, top: 'top_10' });
  });
});
