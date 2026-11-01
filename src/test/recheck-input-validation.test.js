import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createRecheck,
  listRechecks,
  RecheckContractError,
} from '../../api/_lib/recheckCollectionService.js';
import { transitionRecheck } from '../../api/_lib/recheckTransitionService.js';
import { createRecheckTestDatabase, seedCanonicalQuestionStatements } from './helpers/recheckTestDatabase.js';

const actors = {
  studentA: { username: 'student_a', role: 'student', school: 'Alpha School', school_id: 'school_alpha' },
  adminA: { username: 'admin_a', role: 'admin', school: 'Alpha School', school_id: 'school_alpha' },
};

const baseInput = {
  submissionId: 'submission_a',
  subject: 'Physics',
  questionNumber: 'Q1',
  reason: 'The final working appears to support another mark.',
};

function ids(namespace) {
  let count = 0;
  return () => `${namespace}_${++count}`;
}

function options(namespace = 'case') {
  return {
    now: () => '2026-07-24T08:00:00.000Z',
    uuid: ids(namespace),
  };
}

async function expectContract(promise, status) {
  try {
    await promise;
    throw new Error(`Expected RecheckContractError ${status}`);
  } catch (error) {
    expect(error).toBeInstanceOf(RecheckContractError);
    expect(error.status).toBe(status);
    return error;
  }
}

async function seedWorld(db) {
  const now = '2026-07-24T07:00:00.000Z';
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
      studentId: 'student_id_a',
      studentName: 'Asha',
      questionNumber: 'Q1',
      updatedAt: now,
    }),
    {
      sql: `INSERT INTO report_versions (
              id, submission_id, version, status, generated_at, published_at,
              payload_json, username, school
            ) VALUES ('report_a', 'submission_a', 1, 'published', ?, ?, '{}', 'student_a', 'Alpha School')`,
      args: [now, now],
    },
  ], 'write');
}

let harness;

beforeEach(async () => {
  harness = await createRecheckTestDatabase();
  await seedWorld(harness.db);
});

afterEach(async () => {
  await harness.close();
});

describe('recheck duplicate request validation (VAL-10 & VAL-11)', () => {
  it('VAL-10: returns existing request with 409 for sequential duplicate active request', async () => {
    const first = await createRecheck(harness.db, actors.studentA, baseInput, options('first'));
    expect(first.status).toBe('open');

    const error = await expectContract(
      createRecheck(harness.db, actors.studentA, baseInput, options('second')),
      409,
    );
    expect(error.message).toContain('A recheck is already active for this question');
    expect(error.details.request).toMatchObject({ id: first.id, status: 'open' });

    const requestsCount = (await harness.db.execute('SELECT COUNT(*) AS count FROM recheck_requests')).rows[0].count;
    const eventsCount = (await harness.db.execute('SELECT COUNT(*) AS count FROM recheck_events')).rows[0].count;
    expect(requestsCount).toBe(1);
    expect(eventsCount).toBe(1);
  });

  it('VAL-11: converts concurrent unique-index creation race into exactly one success and one 409 without 500 error', async () => {
    const attempts = await Promise.allSettled([
      createRecheck(harness.db, actors.studentA, baseInput, options('race_a')),
      createRecheck(harness.concurrentDb, actors.studentA, baseInput, options('race_b')),
    ]);

    const fulfilled = attempts.filter((r) => r.status === 'fulfilled');
    const rejected = attempts.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    expect(rejected[0].reason).toBeInstanceOf(RecheckContractError);
    expect(rejected[0].reason.status).toBe(409);
    expect(rejected[0].reason.message).toContain('A recheck is already active for this question');

    const activeRows = await harness.db.execute("SELECT COUNT(*) AS count FROM recheck_requests WHERE status = 'open'");
    expect(activeRows.rows[0].count).toBe(1);
  });
});

describe('recheck filter and state transition input validation (VAL-13, VAL-14, VAL-15)', () => {
  it('VAL-13: rejects unknown list status parameter with 400 rather than returning empty 200', async () => {
    await createRecheck(harness.db, actors.studentA, baseInput, options('init'));

    const error = await expectContract(
      listRechecks(harness.db, actors.adminA, { status: 'invented_state' }),
      400,
    );
    expect(error.message).toContain('Unsupported recheck status');

    // Verify valid status filters still work
    const activeResults = await listRechecks(harness.db, actors.adminA, { status: 'active' });
    expect(activeResults).toHaveLength(1);

    const allResults = await listRechecks(harness.db, actors.adminA, { status: 'all' });
    expect(allResults).toHaveLength(1);
  });

  it('VAL-14: rejects unknown or invalid transition status with 400 and no DB mutation', async () => {
    const req = await createRecheck(harness.db, actors.studentA, baseInput, options('init'));

    await expectContract(
      transitionRecheck(harness.db, actors.adminA, req.id, { status: 'nonexistent_status' }, options('invalid_transition')),
      400,
    );

    const check = (await harness.db.execute({ sql: 'SELECT status FROM recheck_requests WHERE id = ?', args: [req.id] })).rows[0];
    expect(check.status).toBe('open');
  });

  it('VAL-15: rejects terminal transitions when resolution note is missing (except default declined note)', async () => {
    const req = await createRecheck(harness.db, actors.studentA, baseInput, options('init'));

    await expectContract(
      transitionRecheck(harness.db, actors.adminA, req.id, { status: 'cancelled', resolutionNote: '' }, options('cancel_missing_note')),
      400,
    );

    const check = (await harness.db.execute({ sql: 'SELECT status FROM recheck_requests WHERE id = ?', args: [req.id] })).rows[0];
    expect(check.status).toBe('open');

    // Declined without note should use default note and succeed
    const declined = await transitionRecheck(harness.db, actors.adminA, req.id, { status: 'declined', resolutionNote: '' }, options('declined_default'));
    expect(declined.status).toBe('declined');
    expect(declined.resolutionNote).toBe('Reviewed; the original grade remains unchanged.');
  });
});
