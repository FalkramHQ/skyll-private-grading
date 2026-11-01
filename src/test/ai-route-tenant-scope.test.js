import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockDb = vi.hoisted(() => ({ execute: vi.fn() }));

const auth = vi.hoisted(() => ({
  database: vi.fn(() => mockDb),
  ensureAuthTables: vi.fn().mockResolvedValue(),
  requireUser: vi.fn(),
  schoolMatches: vi.fn((actual, expected) => Boolean(actual) && Boolean(expected) && actual === expected),
}));

const canonical = vi.hoisted(() => ({ resolveSchoolId: vi.fn() }));
const rateLimit = vi.hoisted(() => ({ checkRateLimit: vi.fn(async () => false) }));
const cors = vi.hoisted(() => ({ handleCors: vi.fn(() => false) }));
const tiers = vi.hoisted(() => ({
  getStudentTier: vi.fn(async () => 'free'),
  checkAiRateLimit: vi.fn(async () => ({ limited: false })),
}));

const tutorLib = vi.hoisted(() => ({
  listTutorSessions: vi.fn(),
  loadChatHistory: vi.fn(),
  runTutorTurn: vi.fn(),
}));

const readinessLib = vi.hoisted(() => ({ getReadiness: vi.fn() }));

const revisionLib = vi.hoisted(() => ({
  generateRevisionPlan: vi.fn(),
  listRevisionPlans: vi.fn(),
  saveRevisionPlan: vi.fn(),
}));

const practiceLib = vi.hoisted(() => ({
  generatePracticeTest: vi.fn(),
  getPracticeTest: vi.fn(),
  gradePracticeSubmission: vi.fn(),
  listPracticeTests: vi.fn(),
}));

const contextBuilder = vi.hoisted(() => {
  class InsufficientEvidenceError extends Error {}
  return { InsufficientEvidenceError };
});

vi.mock('../../api/_lib/auth.js', () => auth);
vi.mock('../../api/_lib/canonicalSubmissions.js', () => canonical);
vi.mock('../../api/_lib/rateLimit.js', () => rateLimit);
vi.mock('../../api/_lib/cors.js', () => cors);
vi.mock('../../api/_lib/aiRateLimitTiers.js', () => tiers);
vi.mock('../../api/_lib/tutor.js', () => tutorLib);
vi.mock('../../api/_lib/readiness.js', () => readinessLib);
vi.mock('../../api/_lib/revisionPlan.js', () => revisionLib);
vi.mock('../../api/_lib/practice.js', () => practiceLib);
vi.mock('../../api/_lib/contextBuilder.js', () => contextBuilder);

import tutor from '../../server/ai/tutor.js';
import readiness from '../../server/ai/readiness.js';
import revision from '../../server/ai/revision.js';
import practice from '../../server/ai/practice.js';

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

const adminAlpha = { username: 'admin_a', role: 'admin', school: 'Alpha School', school_id: 'school_a' };
const skyllAdmin = { username: 'sky_admin', role: 'skyll_admin', school: '', school_id: null };

describe('AI routes reject a caller-supplied schoolId outside the actor school', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tutorLib.runTutorTurn.mockResolvedValue({ messages: [] });
    readinessLib.getReadiness.mockResolvedValue({ readiness: 60 });
    revisionLib.generateRevisionPlan.mockResolvedValue({ plan: 'plan' });
    revisionLib.saveRevisionPlan.mockResolvedValue('plan_1');
    practiceLib.listPracticeTests.mockResolvedValue([]);
  });

  describe('tutor', () => {
    it('rejects a foreign schoolId for a school admin before invoking the service', async () => {
      auth.requireUser.mockResolvedValueOnce(adminAlpha);
      const res = response();
      await tutor({ method: 'POST', body: { question: 'Solve x', schoolId: 'school_b' } }, res);
      expect(res.statusCode).toBe(403);
      expect(res.body.error).toBe('School access denied');
      expect(tutorLib.runTutorTurn).not.toHaveBeenCalled();
    });

    it('passes a matching schoolId to the tutor service', async () => {
      auth.requireUser.mockResolvedValueOnce(adminAlpha);
      const res = response();
      await tutor({ method: 'POST', body: { question: 'Solve x', schoolId: 'school_a' } }, res);
      expect(res.statusCode).toBe(200);
      expect(tutorLib.runTutorTurn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ schoolId: 'school_a' }));
    });

    it('allows a skyll_admin to tutor across schools', async () => {
      auth.requireUser.mockResolvedValueOnce(skyllAdmin);
      const res = response();
      await tutor({ method: 'POST', body: { question: 'Solve x', schoolId: 'school_z' } }, res);
      expect(res.statusCode).toBe(200);
      expect(tutorLib.runTutorTurn).toHaveBeenCalled();
    });

    it('denies a staff user reading another school\'s tutor session history', async () => {
      auth.requireUser.mockResolvedValueOnce({ username: 'teacher_a', role: 'teacher', school: 'Alpha School', school_id: 'school_a' });
      tutorLib.loadChatHistory.mockResolvedValueOnce([{ role: 'student', content: 'hi' }]);
      mockDb.execute.mockResolvedValueOnce({ rows: [{ user_id: 'student_b', school_id: 'school_b' }] });
      const res = response();
      await tutor({ method: 'GET', query: { sessionId: 'sess_b' } }, res);
      expect(res.statusCode).toBe(403);
      expect(res.body.error).toBe('You do not have permission to view this chat');
    });

    it('allows a staff user reading a same-school tutor session history', async () => {
      auth.requireUser.mockResolvedValueOnce({ username: 'teacher_a', role: 'teacher', school: 'Alpha School', school_id: 'school_a' });
      tutorLib.loadChatHistory.mockResolvedValueOnce([{ role: 'student', content: 'hi' }]);
      mockDb.execute.mockResolvedValueOnce({ rows: [{ user_id: 'student_a', school_id: 'school_a' }] });
      const res = response();
      await tutor({ method: 'GET', query: { sessionId: 'sess_a' } }, res);
      expect(res.statusCode).toBe(200);
    });

    it('denies a staff user when the session school cannot be established', async () => {
      auth.requireUser.mockResolvedValueOnce({ username: 'teacher_a', role: 'teacher', school: 'Alpha School', school_id: 'school_a' });
      tutorLib.loadChatHistory.mockResolvedValueOnce([]);
      mockDb.execute.mockResolvedValueOnce({ rows: [{ user_id: 'student_b', school_id: null }] });
      const res = response();
      await tutor({ method: 'GET', query: { sessionId: 'sess_unknown' } }, res);
      expect(res.statusCode).toBe(403);
    });
  });

  describe('readiness', () => {
    it('rejects a foreign schoolId for a school admin before invoking the service', async () => {
      auth.requireUser.mockResolvedValueOnce(adminAlpha);
      const res = response();
      await readiness({ method: 'POST', body: { schoolId: 'school_b', topics: ['motion'] } }, res);
      expect(res.statusCode).toBe(403);
      expect(readinessLib.getReadiness).not.toHaveBeenCalled();
    });

    it('passes a matching schoolId to the readiness service', async () => {
      auth.requireUser.mockResolvedValueOnce(adminAlpha);
      const res = response();
      await readiness({ method: 'POST', body: { schoolId: 'school_a', topics: ['motion'] } }, res);
      expect(res.statusCode).toBe(200);
      expect(readinessLib.getReadiness).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ schoolId: 'school_a' }));
    });

    it('allows a skyll_admin to query across schools', async () => {
      auth.requireUser.mockResolvedValueOnce(skyllAdmin);
      const res = response();
      await readiness({ method: 'POST', body: { schoolId: 'school_z', topics: ['motion'] } }, res);
      expect(res.statusCode).toBe(200);
    });
  });

  describe('revision', () => {
    it('rejects a foreign schoolId for a school admin before invoking the service', async () => {
      auth.requireUser.mockResolvedValueOnce(adminAlpha);
      const res = response();
      await revision({ method: 'POST', body: { schoolId: 'school_b', subject: 'Physics' } }, res);
      expect(res.statusCode).toBe(403);
      expect(revisionLib.generateRevisionPlan).not.toHaveBeenCalled();
    });

    it('passes a matching schoolId to the revision service', async () => {
      auth.requireUser.mockResolvedValueOnce(adminAlpha);
      const res = response();
      await revision({ method: 'POST', body: { schoolId: 'school_a', subject: 'Physics' } }, res);
      expect(res.statusCode).toBe(200);
      expect(revisionLib.generateRevisionPlan).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ schoolId: 'school_a' }));
    });

    it('allows a skyll_admin to generate across schools', async () => {
      auth.requireUser.mockResolvedValueOnce(skyllAdmin);
      const res = response();
      await revision({ method: 'POST', body: { schoolId: 'school_z', subject: 'Physics' } }, res);
      expect(res.statusCode).toBe(200);
    });
  });

  describe('practice', () => {
    it('rejects a foreign schoolId in query params for a school admin', async () => {
      auth.requireUser.mockResolvedValueOnce(adminAlpha);
      const res = response();
      await practice({ method: 'GET', query: { list: '1', schoolId: 'school_b' } }, res);
      expect(res.statusCode).toBe(403);
      expect(practiceLib.listPracticeTests).not.toHaveBeenCalled();
    });

    it('passes a matching schoolId to the practice service', async () => {
      auth.requireUser.mockResolvedValueOnce(adminAlpha);
      const res = response();
      await practice({ method: 'GET', query: { list: '1', schoolId: 'school_a' } }, res);
      expect(res.statusCode).toBe(200);
      expect(practiceLib.listPracticeTests).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ schoolId: 'school_a' }));
    });

    it('allows a skyll_admin to browse across schools', async () => {
      auth.requireUser.mockResolvedValueOnce(skyllAdmin);
      const res = response();
      await practice({ method: 'GET', query: { list: '1', schoolId: 'school_z' } }, res);
      expect(res.statusCode).toBe(200);
    });
  });
});

// FLKRM-384: a non-admin session with no school must not accept a client
// schoolId. The old guard skipped the comparison whenever schoolId was empty.
describe('AI routes fail closed when the session has no school', () => {
  const schoolless = { user_id: 'u_x', username: 'admin_x', role: 'admin', school: '', school_id: null };

  beforeEach(() => {
    vi.clearAllMocks();
    canonical.resolveSchoolId.mockResolvedValue(null);
  });

  it.each([
    ['revision', () => revision, { method: 'POST', body: { schoolId: 'school_b' } }, () => revisionLib.generateRevisionPlan],
    ['readiness', () => readiness, { method: 'GET', query: { schoolId: 'school_b' } }, () => readinessLib.getReadiness],
    ['practice', () => practice, { method: 'GET', query: { list: '1', schoolId: 'school_b' } }, () => practiceLib.listPracticeTests],
  ])('%s refuses a client schoolId', async (_name, route, req, service) => {
    auth.requireUser.mockResolvedValueOnce(schoolless);
    const res = response();
    await route()({ query: {}, ...req }, res);
    expect(res.statusCode).toBe(403);
    expect(service()).not.toHaveBeenCalled();
  });
});

// FLKRM-383: a student's AI requests always resolve to their own record. A
// client studentId would otherwise resolve first and select a classmate.
describe('AI routes keep a student on their own record', () => {
  const studentA = { user_id: 'u_asha', username: 'asha', role: 'student', school: 'Alpha School', school_id: 'school_a' };
  const peer = { studentId: 'stu_peer', username: 'asha' };

  beforeEach(() => {
    vi.clearAllMocks();
    tutorLib.runTutorTurn.mockResolvedValue({ reply: 'ok' });
    readinessLib.getReadiness.mockResolvedValue({ readiness: 60 });
    revisionLib.generateRevisionPlan.mockResolvedValue({ plan: 'plan' });
    revisionLib.saveRevisionPlan.mockResolvedValue('plan_1');
    practiceLib.generatePracticeTest.mockResolvedValue({ questions: [] });
  });

  function lastArgs(fn) {
    return fn.mock.calls.at(-1)[1];
  }

  it("tutor ignores a classmate's studentId", async () => {
    auth.requireUser.mockResolvedValueOnce(studentA);
    const res = response();
    await tutor({ method: 'POST', body: { question: 'What is my growth edge?', ...peer } }, res);
    expect(res.statusCode).toBe(200);
    expect(lastArgs(tutorLib.runTutorTurn)).toMatchObject({ username: 'asha', studentId: null });
  });

  it("revision plans and saves only for the student, not a classmate's studentId", async () => {
    auth.requireUser.mockResolvedValueOnce(studentA);
    const res = response();
    await revision({ method: 'POST', body: peer }, res);
    expect(res.statusCode).toBe(200);
    expect(lastArgs(revisionLib.generateRevisionPlan)).toMatchObject({ username: 'asha', studentId: null });
    expect(lastArgs(revisionLib.saveRevisionPlan)).toMatchObject({ username: 'asha', studentId: null });
  });

  it("readiness ignores a classmate's studentId in the body or the query", async () => {
    auth.requireUser.mockResolvedValueOnce(studentA);
    await readiness({ method: 'POST', body: peer }, response());
    expect(lastArgs(readinessLib.getReadiness)).toMatchObject({ username: 'asha', studentId: null });

    auth.requireUser.mockResolvedValueOnce(studentA);
    await readiness({ method: 'GET', query: { studentId: 'stu_peer' } }, response());
    expect(lastArgs(readinessLib.getReadiness)).toMatchObject({ username: 'asha', studentId: null });
  });

  it("practice generates only for the student, not a classmate's studentId", async () => {
    auth.requireUser.mockResolvedValueOnce(studentA);
    const res = response();
    await practice({ method: 'POST', body: { action: 'generate', ...peer } }, res);
    expect(res.statusCode).toBe(201);
    expect(lastArgs(practiceLib.generatePracticeTest)).toMatchObject({ username: 'asha', studentId: null });
  });

  it('practice refuses a student a test with no owning username, by GET or grade', async () => {
    const unowned = { id: 'pt_1', username: null, studentId: 'stu_peer', status: 'ready', questions: [] };
    practiceLib.getPracticeTest.mockResolvedValue(unowned);

    auth.requireUser.mockResolvedValueOnce(studentA);
    const read = response();
    await practice({ method: 'GET', query: { id: 'pt_1' } }, read);
    expect(read.statusCode).toBe(403);

    auth.requireUser.mockResolvedValueOnce(studentA);
    const grade = response();
    await practice({ method: 'POST', body: { action: 'grade', practiceTestId: 'pt_1', answers: [] } }, grade);
    expect(grade.statusCode).toBe(403);
    expect(practiceLib.gradePracticeSubmission).not.toHaveBeenCalled();
  });

  it("practice lets a student grade their own test, pinned to the test's owner", async () => {
    practiceLib.getPracticeTest.mockResolvedValue({ id: 'pt_2', username: 'asha', studentId: 'stu_asha', status: 'ready', questions: [] });
    practiceLib.gradePracticeSubmission.mockResolvedValue({ score: 1 });
    auth.requireUser.mockResolvedValueOnce(studentA);
    const res = response();
    await practice({ method: 'POST', body: { action: 'grade', practiceTestId: 'pt_2', studentId: 'stu_peer', answers: [] } }, res);
    expect(res.statusCode).toBe(200);
    expect(lastArgs(practiceLib.gradePracticeSubmission)).toMatchObject({ username: 'asha', studentId: 'stu_asha' });
  });

  it('staff may still target a student by studentId', async () => {
    auth.requireUser.mockResolvedValueOnce(adminAlpha);
    await tutor({ method: 'POST', body: { question: 'Summarise', studentId: 'stu_peer' } }, response());
    expect(lastArgs(tutorLib.runTutorTurn)).toMatchObject({ studentId: 'stu_peer' });
  });
});
