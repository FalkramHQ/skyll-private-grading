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
  studentB: { username: 'student_b', role: 'student', school: 'Beta School', school_id: 'school_beta' },
  adminA: { username: 'admin_a', role: 'admin', school: 'Alpha School', school_id: 'school_alpha' },
  adminB: { username: 'admin_b', role: 'admin', school: 'Beta School', school_id: 'school_beta' },
  teacherA: { username: 'teacher_a', role: 'teacher', school: 'Alpha School', school_id: 'school_alpha' },
  skyll: { username: 'skyll_admin', role: 'skyll_admin', school: 'Skyll', school_id: 'school_platform' },
  unsupported: { username: 'guest', role: 'guest', school: 'Alpha School', school_id: 'school_alpha' },
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
    ...seedCanonicalQuestionStatements({
      questionId: 'question_b',
      submissionId: 'submission_b',
      school: 'Beta School',
      schoolId: 'school_beta',
      subject: 'Physics',
      subjectId: 'subject_physics_beta',
      examId: 'exam_b',
      setId: 'set_b',
      setQuestionId: 'esq_b',
      studentId: 'student_id_b',
      studentName: 'Bina',
      questionNumber: 'Q1',
      updatedAt: now,
    }),
    ...seedCanonicalQuestionStatements({
      questionId: 'question_unpublished',
      submissionId: 'submission_unpublished',
      school: 'Alpha School',
      schoolId: 'school_alpha',
      subject: 'Physics',
      subjectId: 'subject_physics_alpha',
      examId: 'exam_a_unpub',
      setId: 'set_a_unpub',
      setQuestionId: 'esq_a_unpub',
      studentId: 'student_id_c',
      studentName: 'Charu',
      questionNumber: 'Q1',
      status: 'ready_for_review',
      updatedAt: now,
    }),
    {
      sql: `INSERT INTO report_versions (
              id, submission_id, version, status, generated_at, published_at,
              payload_json, username, school
            ) VALUES ('report_a', 'submission_a', 1, 'published', ?, ?, '{}', 'student_a', 'Alpha School')`,
      args: [now, now],
    },
    {
      sql: `INSERT INTO report_versions (
              id, submission_id, version, status, generated_at, published_at,
              payload_json, username, school
            ) VALUES ('report_b', 'submission_b', 1, 'published', ?, ?, '{}', 'student_b', 'Beta School')`,
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

describe('recheck creation authorization', () => {
  it('allows a student to create a request for their own published report question', async () => {
    const request = await createRecheck(harness.db, actors.studentA, baseInput, options());
    expect(request).toMatchObject({
      submissionQuestionId: 'question_a',
      requestedBy: 'student_a',
      requestedByRole: 'student',
      status: 'open',
    });
    const event = (await harness.db.execute('SELECT actor_user_id, event_type, note FROM recheck_events')).rows[0];
    expect(event).toMatchObject({
      actor_user_id: 'student_a',
      event_type: 'requested_by_student',
      note: baseInput.reason,
    });
  });

  it('denies a student targeting another student submission', async () => {
    await expectContract(createRecheck(harness.db, actors.studentA, {
      ...baseInput,
      submissionId: 'submission_b',
    }, options()), 403);
    expect((await harness.db.execute('SELECT COUNT(*) AS count FROM recheck_requests')).rows[0].count).toBe(0);
  });

  it('ignores spoofed requester identity fields in the input', async () => {
    const request = await createRecheck(harness.db, actors.studentA, {
      ...baseInput,
      requestedBy: 'student_b',
      requestedByRole: 'skyll_admin',
    }, options());
    expect(request).toMatchObject({ requestedBy: 'student_a', requestedByRole: 'student' });
  });

  it('allows a school admin to create only within their school', async () => {
    const request = await createRecheck(harness.db, actors.adminA, baseInput, options());
    expect(request).toMatchObject({ school: 'Alpha School', requestedBy: 'admin_a', requestedByRole: 'admin' });
    expect((await harness.db.execute('SELECT event_type FROM recheck_events')).rows[0].event_type).toBe('requested_by_admin');

    await expectContract(createRecheck(harness.db, actors.adminA, {
      ...baseInput,
      submissionId: 'submission_b',
    }, options('cross')), 403);
  });

  it('allows a Skyll admin to create across schools', async () => {
    const request = await createRecheck(harness.db, actors.skyll, {
      ...baseInput,
      submissionId: 'submission_b',
    }, options());
    expect(request).toMatchObject({ school: 'Beta School', requestedBy: 'skyll_admin' });
  });

  it('allows teacher-role creation within school and denies unsupported roles', async () => {
    const request = await createRecheck(harness.db, actors.teacherA, baseInput, options());
    expect(request).toMatchObject({ school: 'Alpha School', requestedBy: 'teacher_a', requestedByRole: 'teacher' });
    await expectContract(createRecheck(harness.db, actors.unsupported, baseInput, options()), 403);
  });

  it('requires a published report for students (AUTH-05) and admins (AUTH-08)', async () => {
    const input = { ...baseInput, submissionId: 'submission_unpublished' };
    await expectContract(createRecheck(harness.db, actors.studentA, input, options('student')), 403);
    await expectContract(createRecheck(harness.db, actors.adminA, input, options('admin')), 404);
  });
});

describe('recheck input validation', () => {
  it.each([
    [{ ...baseInput, submissionId: '' }, 400],
    [{ ...baseInput, subject: '' }, 400],
    [{ ...baseInput, questionNumber: '' }, 400],
    [{ ...baseInput, questionNumber: 'Q99' }, 404],
    [{ ...baseInput, reason: '12345678901' }, 400],
    [{ ...baseInput, reason: 'x'.repeat(801) }, 400],
    [{ ...baseInput, reason: null }, 400],
    [{ ...baseInput, reason: { text: 'Please recheck this answer' } }, 400],
  ])('rejects malformed input %#', async (input, status) => {
    await expectContract(createRecheck(harness.db, actors.studentA, input, options()), status);
  });

  it.each(['123456789012', 'x'.repeat(800)])('accepts reason boundary length %s', async (reason) => {
    const request = await createRecheck(harness.db, actors.studentA, { ...baseInput, reason }, options());
    expect(request.reason).toBe(reason);
  });

  it('normalizes reason whitespace before enforcing and storing the contract', async () => {
    const request = await createRecheck(harness.db, actors.studentA, {
      ...baseInput,
      reason: '   Please   check\nthis answer again.   ',
    }, options());
    expect(request.reason).toBe('Please check this answer again.');
  });
});

describe('active-request duplicate semantics', () => {
  it('returns the existing request for a sequential duplicate', async () => {
    const first = await createRecheck(harness.db, actors.studentA, baseInput, options('first'));
    const error = await expectContract(
      createRecheck(harness.db, actors.studentA, baseInput, options('second')),
      409,
    );
    expect(error.details.request).toMatchObject({ id: first.id, status: 'open' });
    expect((await harness.db.execute('SELECT COUNT(*) AS count FROM recheck_requests')).rows[0].count).toBe(1);
    expect((await harness.db.execute('SELECT COUNT(*) AS count FROM recheck_events')).rows[0].count).toBe(1);
  });

  it('converts a concurrent unique-index race into one success and one 409', async () => {
    const attempts = await Promise.allSettled([
      createRecheck(harness.db, actors.studentA, baseInput, options('race_a')),
      createRecheck(harness.concurrentDb, actors.studentA, baseInput, options('race_b')),
    ]);
    const fulfilled = attempts.filter((result) => result.status === 'fulfilled');
    const rejected = attempts.filter((result) => result.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(RecheckContractError);
    expect(rejected[0].reason.status).toBe(409);
    expect((await harness.db.execute('SELECT COUNT(*) AS count FROM recheck_requests')).rows[0].count).toBe(1);
    expect((await harness.db.execute('SELECT COUNT(*) AS count FROM recheck_events')).rows[0].count).toBe(1);
  });

  it.each(['resolved', 'declined', 'cancelled'])('permits a new request after %s', async (terminal) => {
    const first = await createRecheck(harness.db, actors.studentA, baseInput, options('first'));
    await harness.db.execute({
      sql: 'UPDATE recheck_requests SET status = ? WHERE id = ?',
      args: [terminal, first.id],
    });
    const second = await createRecheck(harness.db, actors.studentA, baseInput, options('second'));
    expect(second.id).not.toBe(first.id);
    expect((await harness.db.execute('SELECT COUNT(*) AS count FROM recheck_requests')).rows[0].count).toBe(2);
  });
});

describe('recheck listing authorization', () => {
  beforeEach(async () => {
    await createRecheck(harness.db, actors.studentA, baseInput, options('alpha'));
    await createRecheck(harness.db, actors.studentB, {
      ...baseInput,
      submissionId: 'submission_b',
    }, options('beta'));
  });

  it('limits students, teachers, and school admins to their own scope', async () => {
    expect((await listRechecks(harness.db, actors.studentA)).map((request) => request.school)).toEqual(['Alpha School']);
    expect((await listRechecks(harness.db, actors.teacherA)).map((request) => request.school)).toEqual(['Alpha School']);
    expect((await listRechecks(harness.db, actors.adminB)).map((request) => request.school)).toEqual(['Beta School']);
  });

  it('allows Skyll admins to list all schools or an explicit school', async () => {
    expect(await listRechecks(harness.db, actors.skyll)).toHaveLength(2);
    expect((await listRechecks(harness.db, actors.skyll, { school: 'Alpha School' }))).toHaveLength(1);
  });

  it('rejects unsupported actors and unknown status filters', async () => {
    await expectContract(listRechecks(harness.db, actors.unsupported), 403);
    await expectContract(listRechecks(harness.db, actors.skyll, { status: 'invented' }), 400);
  });
});

describe('recheck transition authorization', () => {
  let activeRequest;

  beforeEach(async () => {
    activeRequest = await createRecheck(harness.db, actors.studentA, baseInput, options('created'));
  });

  it('AUTH-10: allows teacher-role updates within school and denies unsupported roles', async () => {
    const updated = await transitionRecheck(harness.db, actors.teacherA, activeRequest.id, { status: 'in_review' }, options('teacher'));
    expect(updated).toMatchObject({ id: activeRequest.id, status: 'in_review', takenBy: 'teacher_a' });

    await expectContract(
      transitionRecheck(harness.db, actors.unsupported, activeRequest.id, { status: 'declined' }, options('unsupported')),
      403,
    );
  });

  it('AUTH-15: denies cross-school admins from updating requests', async () => {
    await expectContract(
      transitionRecheck(harness.db, actors.adminB, activeRequest.id, { status: 'in_review' }, options('cross-school')),
      403,
    );
  });

  it('AUTH-16: denies students from updating request status', async () => {
    await expectContract(
      transitionRecheck(harness.db, actors.studentA, activeRequest.id, { status: 'in_review' }, options('student')),
      403,
    );
  });
});
