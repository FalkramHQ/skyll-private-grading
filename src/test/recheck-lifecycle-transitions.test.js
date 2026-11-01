import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { transitionRecheck } from '../../api/_lib/recheckTransitionService.js';
import { RecheckContractError } from '../../api/_lib/recheckCollectionService.js';
import { canTransitionRecheck } from '../../shared/workflowLifecycle.js';
import { createRecheckTestDatabase, seedCanonicalQuestionStatements } from './helpers/recheckTestDatabase.js';

const actors = {
  student: { username: 'student_a', role: 'student', school: 'Alpha School', school_id: 'school_alpha' },
  adminA: { username: 'admin_a', role: 'admin', school: 'Alpha School', school_id: 'school_alpha' },
  adminA2: { username: 'admin_a2', role: 'admin', school: 'Alpha School', school_id: 'school_alpha' },
  adminB: { username: 'admin_b', role: 'admin', school: 'Beta School', school_id: 'school_beta' },
  skyll: { username: 'skyll_admin', role: 'skyll_admin', school: 'Skyll', school_id: 'school_platform' },
};

function options(namespace = 'transition') {
  let count = 0;
  return {
    now: () => '2026-07-24T10:00:00.000Z',
    uuid: () => `${namespace}_${++count}`,
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

async function seedRequest(db, status = 'open', id = 'recheck_a') {
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
      updatedAt: '2026-07-24T09:00:00.000Z',
    }),
    {
      sql: `INSERT INTO recheck_requests (
              id, submission_question_id, submission_id, student_id, reason,
              requested_by, requested_by_role, status, requested_at
            ) VALUES (?, 'question_a', 'submission_a', 'student_a',
              'The awarded mark should be reviewed.', 'student_a', 'student',
              ?, '2026-07-24T09:00:00.000Z')`,
      args: [id, status],
    },
  ], 'write');
}

async function requestRow(db, id = 'recheck_a') {
  return (await db.execute({
    sql: 'SELECT * FROM recheck_requests WHERE id = ?',
    args: [id],
  })).rows[0];
}

async function events(db, id = 'recheck_a') {
  return (await db.execute({
    sql: 'SELECT * FROM recheck_events WHERE recheck_request_id = ? ORDER BY created_at, id',
    args: [id],
  })).rows;
}

let harness;

beforeEach(async () => {
  harness = await createRecheckTestDatabase();
});

afterEach(async () => {
  await harness.close();
});

describe('documented recheck lifecycle transitions', () => {
  it('records open to in_review with reviewer ownership and an audit event', async () => {
    await seedRequest(harness.db);
    const request = await transitionRecheck(
      harness.db,
      actors.adminA,
      'recheck_a',
      { status: 'in_review' },
      options(),
    );

    expect(request).toMatchObject({
      status: 'in_review',
      takenBy: 'admin_a',
      takenAt: '2026-07-24T10:00:00.000Z',
    });
    expect(await events(harness.db)).toMatchObject([{
      actor_user_id: 'admin_a',
      event_type: 'status_in_review',
      before_json: '{"status":"open"}',
      after_json: '{"status":"in_review"}',
    }]);
  });

  it('allows open to declined with the documented default resolution', async () => {
    await seedRequest(harness.db);
    const request = await transitionRecheck(
      harness.db,
      actors.adminA,
      'recheck_a',
      { status: 'declined' },
      options(),
    );

    expect(request).toMatchObject({
      status: 'declined',
      resolvedBy: 'admin_a',
      resolutionNote: 'Reviewed; the original grade remains unchanged.',
    });
    expect((await events(harness.db))[0].note)
      .toBe('Reviewed; the original grade remains unchanged.');
  });

  it('allows in_review to declined with a custom resolution', async () => {
    await seedRequest(harness.db, 'in_review');
    const request = await transitionRecheck(
      harness.db,
      actors.adminA,
      'recheck_a',
      { status: 'declined', resolutionNote: 'The original marking follows the published rubric.' },
      options(),
    );
    expect(request).toMatchObject({
      status: 'declined',
      resolutionNote: 'The original marking follows the published rubric.',
    });
  });

  it.each(['open', 'in_review'])('allows explicit %s cancellation only with a note', async (status) => {
    await seedRequest(harness.db, status);
    await expectContract(transitionRecheck(
      harness.db,
      actors.adminA,
      'recheck_a',
      { status: 'cancelled' },
      options('missing'),
    ), 400);
    expect((await requestRow(harness.db)).status).toBe(status);
    expect(await events(harness.db)).toHaveLength(0);

    const request = await transitionRecheck(
      harness.db,
      actors.adminA,
      'recheck_a',
      { status: 'cancelled', resolutionNote: 'Withdrawn after an operational duplicate was confirmed.' },
      options(),
    );
    expect(request.status).toBe('cancelled');
  });

  it('reserves in_review to awaiting_regrade for reviewer evidence or mark edits', async () => {
    await seedRequest(harness.db, 'in_review');
    const error = await expectContract(transitionRecheck(
      harness.db,
      actors.adminA,
      'recheck_a',
      { status: 'awaiting_regrade' },
      options(),
    ), 400);
    expect(error.message).toContain('Cannot move');
    expect(canTransitionRecheck('in_review', 'awaiting_regrade')).toBe(true);
    expect((await requestRow(harness.db)).status).toBe('in_review');
    expect(await events(harness.db)).toHaveLength(0);
  });

  it('reserves awaiting_regrade to resolved for successful publication', async () => {
    await seedRequest(harness.db, 'awaiting_regrade');
    await expectContract(transitionRecheck(
      harness.db,
      actors.skyll,
      'recheck_a',
      { status: 'resolved', resolutionNote: 'Manually resolved.' },
      options(),
    ), 400);
    expect(canTransitionRecheck('awaiting_regrade', 'resolved')).toBe(true);
    expect((await requestRow(harness.db)).status).toBe('awaiting_regrade');
    expect(await events(harness.db)).toHaveLength(0);
  });

  it('rejects the undocumented awaiting_regrade to in_review PATCH path', async () => {
    await seedRequest(harness.db, 'awaiting_regrade');
    await expectContract(transitionRecheck(
      harness.db,
      actors.adminA,
      'recheck_a',
      { status: 'in_review' },
      options(),
    ), 400);
    expect((await requestRow(harness.db)).status).toBe('awaiting_regrade');
  });

  it.each(['resolved', 'declined', 'cancelled'])('keeps terminal state %s immutable', async (status) => {
    await seedRequest(harness.db, status);
    await expectContract(transitionRecheck(
      harness.db,
      actors.adminA,
      'recheck_a',
      { status: 'in_review' },
      options(),
    ), 400);
    expect((await requestRow(harness.db)).status).toBe(status);
    expect(await events(harness.db)).toHaveLength(0);
  });

  it('rejects repeated and unknown states without mutation or audit events', async () => {
    await seedRequest(harness.db);
    await expectContract(transitionRecheck(
      harness.db,
      actors.adminA,
      'recheck_a',
      { status: 'open' },
      options('same'),
    ), 400);
    await expectContract(transitionRecheck(
      harness.db,
      actors.adminA,
      'recheck_a',
      { status: 'invented' },
      options('unknown'),
    ), 400);
    expect((await requestRow(harness.db)).status).toBe('open');
    expect(await events(harness.db)).toHaveLength(0);
  });
});

describe('transition authorization and concurrency', () => {
  it('denies students and cross-school admins without mutation', async () => {
    await seedRequest(harness.db);
    await expectContract(transitionRecheck(
      harness.db,
      actors.student,
      'recheck_a',
      { status: 'in_review' },
      options('student'),
    ), 403);
    await expectContract(transitionRecheck(
      harness.db,
      actors.adminB,
      'recheck_a',
      { status: 'in_review' },
      options('cross-school'),
    ), 403);
    expect((await requestRow(harness.db)).status).toBe('open');
    expect(await events(harness.db)).toHaveLength(0);
  });

  it('allows a Skyll admin to transition a request across schools', async () => {
    await seedRequest(harness.db);
    const request = await transitionRecheck(
      harness.db,
      actors.skyll,
      'recheck_a',
      { status: 'in_review' },
      options(),
    );
    expect(request).toMatchObject({ status: 'in_review', takenBy: 'skyll_admin' });
  });

  it('returns not found without leaking request details', async () => {
    await expectContract(transitionRecheck(
      harness.db,
      actors.adminA,
      'missing',
      { status: 'in_review' },
      options(),
    ), 404);
  });

  it('permits only one parallel take-up and writes one audit event', async () => {
    await seedRequest(harness.db);
    const attempts = await Promise.allSettled([
      transitionRecheck(
        harness.db,
        actors.adminA,
        'recheck_a',
        { status: 'in_review' },
        options('first'),
      ),
      transitionRecheck(
        harness.concurrentDb,
        actors.adminA2,
        'recheck_a',
        { status: 'in_review' },
        options('second'),
      ),
    ]);

    expect(attempts.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const rejected = attempts.find(({ status }) => status === 'rejected');
    expect(rejected.reason).toBeInstanceOf(RecheckContractError);
    expect([400, 409]).toContain(rejected.reason.status);
    expect(await events(harness.db)).toHaveLength(1);
    expect(['admin_a', 'admin_a2']).toContain((await requestRow(harness.db)).taken_by);
  });
});
