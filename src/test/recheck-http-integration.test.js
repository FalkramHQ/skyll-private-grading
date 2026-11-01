import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRecheckHttpHandler } from '../../api/rechecks/[[...route]].js';
import { createRecheckTestDatabase, seedCanonicalQuestionStatements } from './helpers/recheckTestDatabase.js';

const student = { username: 'student_a', role: 'student', school: 'Alpha School', school_id: 'school_alpha' };
const admin = { username: 'admin_a', role: 'admin', school: 'Alpha School', school_id: 'school_alpha' };

function response() {
  return {
    statusCode: 200,
    body: null,
    setHeader() {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

async function seed(db) {
  const now = '2026-07-24T09:00:00.000Z';
  await db.batch([
    ...seedCanonicalQuestionStatements({
      questionId: 'question_a',
      submissionId: 'submission_a',
      school: 'Alpha School',
      schoolId: 'school_alpha',
      subject: 'Physics',
      subjectId: 'subject_physics_alpha',
      examId: 'exam_a',
      setId: 'set_a',
      setQuestionId: 'esq_a',
      studentId: 'student_a',
      studentName: 'Asha',
      questionNumber: 'Q1',
      updatedAt: now,
    }),
    {
      sql: `INSERT INTO report_versions (
              id, submission_id, version, status, generated_at, published_at,
              payload_json, username, school
            ) VALUES (
              'report_a', 'submission_a', 1, 'published', ?, ?, '{}',
              'student_a', 'Alpha School'
            )`,
      args: [now, now],
    },
  ], 'write');
}

const validBody = {
  submissionId: 'submission_a',
  subject: 'Physics',
  questionNumber: 'Q1',
  reason: 'The final working supports another mark.',
};

let harness;

beforeEach(async () => {
  harness = await createRecheckTestDatabase();
  await seed(harness.db);
});

afterEach(async () => {
  await harness.close();
});

describe('recheck Vercel HTTP adapter', () => {
  it('stops after authentication returns no actor', async () => {
    const res = response();
    const authenticate = vi.fn(async (_req, target) => {
      target.status(401).json({ error: 'Authentication required' });
      return null;
    });
    const handler = createRecheckHttpHandler({
      db: harness.db,
      ensureTables: vi.fn(),
      authenticate,
    });

    await handler({ method: 'GET', query: {} }, res);
    expect(res).toMatchObject({ statusCode: 401, body: { error: 'Authentication required' } });
    expect((await harness.db.execute('SELECT COUNT(*) AS count FROM recheck_requests')).rows[0].count)
      .toBe(0);
  });

  it('creates and lists a student request through HTTP request/response shapes', async () => {
    const handler = createRecheckHttpHandler({
      db: harness.db,
      ensureTables: vi.fn(),
      authenticate: async () => student,
    });
    const createRes = response();
    await handler({ method: 'POST', query: {}, body: validBody }, createRes);
    expect(createRes.statusCode).toBe(201);
    expect(createRes.body.request).toMatchObject({ status: 'open', requestedBy: 'student_a' });

    const listRes = response();
    await handler({ method: 'GET', query: { status: 'active' } }, listRes);
    expect(listRes.statusCode).toBe(200);
    expect(listRes.body.requests).toHaveLength(1);
  });

  it('returns the existing request with HTTP 409 for a duplicate', async () => {
    const handler = createRecheckHttpHandler({
      db: harness.db,
      ensureTables: vi.fn(),
      authenticate: async () => student,
    });
    await handler({ method: 'POST', query: {}, body: validBody }, response());
    const duplicate = response();
    await handler({ method: 'POST', query: {}, body: validBody }, duplicate);
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.body).toMatchObject({
      error: 'A recheck is already active for this question',
      request: { status: 'open', submissionQuestionId: 'question_a' },
    });
  });

  it('maps validation and unsupported methods to their HTTP contract', async () => {
    const handler = createRecheckHttpHandler({
      db: harness.db,
      ensureTables: vi.fn(),
      authenticate: async () => student,
    });
    const invalid = response();
    await handler({ method: 'POST', query: {}, body: { ...validBody, reason: 'short' } }, invalid);
    expect(invalid.statusCode).toBe(400);

    const unsupported = response();
    await handler({ method: 'DELETE', query: {}, body: {} }, unsupported);
    expect(unsupported.statusCode).toBe(405);
  });

  it('takes up a request through the PATCH route as a same-school admin', async () => {
    const studentHandler = createRecheckHttpHandler({
      db: harness.db,
      ensureTables: vi.fn(),
      authenticate: async () => student,
    });
    const created = response();
    await studentHandler({ method: 'POST', query: {}, body: validBody }, created);

    const adminHandler = createRecheckHttpHandler({
      db: harness.db,
      ensureTables: vi.fn(),
      authenticate: async () => admin,
    });
    const updated = response();
    await adminHandler({
      method: 'PATCH',
      query: { route: [created.body.request.id] },
      body: { status: 'in_review' },
    }, updated);
    expect(updated.statusCode).toBe(200);
    expect(updated.body.request).toMatchObject({ status: 'in_review', takenBy: 'admin_a' });
  });

  it('rejects a student PATCHing a request at the HTTP layer before any mutation', async () => {
    const studentHandler = createRecheckHttpHandler({
      db: harness.db,
      ensureTables: vi.fn(),
      authenticate: async () => student,
    });
    const created = response();
    await studentHandler({ method: 'POST', query: {}, body: validBody }, created);

    const updateHandler = createRecheckHttpHandler({
      db: harness.db,
      ensureTables: vi.fn(),
      authenticate: async () => student,
    });
    const updated = response();
    await updateHandler({
      method: 'PATCH',
      query: { route: [created.body.request.id] },
      body: { status: 'in_review' },
    }, updated);
    expect(updated.statusCode).toBe(403);
    const row = (await harness.db.execute("SELECT status FROM recheck_requests WHERE id = ?", [created.body.request.id])).rows[0];
    expect(row.status).toBe('open');
  });

  it('rejects an actor whose role is outside the recheck contract at the HTTP layer', async () => {
    const handler = createRecheckHttpHandler({
      db: harness.db,
      ensureTables: vi.fn(),
      authenticate: async () => ({ username: 'scanner_a', role: 'scanner', school: 'Alpha School', school_id: 'school_alpha' }),
    });
    const res = response();
    await handler({ method: 'GET', query: {} }, res);
    expect(res.statusCode).toBe(403);
    expect((await harness.db.execute('SELECT COUNT(*) AS count FROM recheck_requests')).rows[0].count)
      .toBe(0);
  });
});
