import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  editAnswerEvidence,
  saveReviewDecision,
} from '../../api/_lib/reviewerEditService.js';
import { RecheckContractError } from '../../api/_lib/recheckCollectionService.js';
import { finishRunIfReady } from '../../api/vl-queue.js';
import { createRecheckTestDatabase, seedCanonicalQuestionStatements } from './helpers/recheckTestDatabase.js';

const actors = {
  admin: { username: 'admin_a', role: 'admin', school: 'Alpha School', school_id: 'school_alpha' },
  crossSchool: { username: 'admin_b', role: 'admin', school: 'Beta School', school_id: 'school_beta' },
};

function options(namespace = 'phase5') {
  let count = 0;
  return {
    now: () => '2026-07-24T12:00:00.000Z',
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
  }
}

async function seedQuestion(db, recheckStatus = null, { aiMarks = 1, approvedMarks = 1 } = {}) {
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
      payloadJson: '{"studentAnswer":{"studentWrote":"Original OCR"}}',
      aiMarks,
      approvedMarks,
      marksTotal: 5,
      updatedAt: '2026-07-24T11:00:00.000Z',
    }),
  ], 'write');
  if (recheckStatus) {
    await db.execute({
      sql: `INSERT INTO recheck_requests (
              id, submission_question_id, submission_id, student_id, reason,
              requested_by, requested_by_role, status, requested_at
            ) VALUES (
              'recheck_a', 'question_a', 'submission_a', 'student_a',
              'Please review the awarded mark.', 'student_a', 'student', ?,
              '2026-07-24T11:00:00.000Z'
            )`,
      args: [recheckStatus],
    });
  }
}

async function question(db) {
  return (await db.execute("SELECT * FROM submission_questions WHERE id = 'question_a'")).rows[0];
}

async function recheck(db) {
  return (await db.execute("SELECT * FROM recheck_requests WHERE id = 'recheck_a'")).rows[0];
}

async function eventTypes(db) {
  return (await db.execute('SELECT event_type FROM recheck_events ORDER BY rowid')).rows
    .map((row) => row.event_type);
}

async function seedRun(db, itemStates, requestStatus = 'awaiting_regrade') {
  await seedQuestion(db, requestStatus);
  await db.execute({
    sql: `INSERT INTO regrade_runs (
            id, scope, status, requested_by,
            requested_at, question_count, student_count, workflow_version
          ) VALUES (
            'run_a', '{"school":"Alpha School","test_id":"test_a","subject":"Physics","grade":"12th"}', 'running',
            'admin_a', '2026-07-24T11:30:00.000Z', ?, 1, 'test'
          )`,
    args: [itemStates.length],
  });
  for (let index = 0; index < itemStates.length; index += 1) {
    const item = itemStates[index];
    await db.execute({
      sql: `INSERT INTO regrade_items (
              id, run_id, submission_id, submission_question_id, revision,
              state, input_snapshot_json, output_json
            ) VALUES (?, 'run_a', 'submission_a', 'question_a', 1, ?, '{}', ?)`,
      args: [
        `item_${index + 1}`,
        item.state,
        item.published
          ? JSON.stringify({ feedback: {}, reportVersionId: `report_${index + 1}` })
          : JSON.stringify({ feedback: {} }),
      ],
    });
  }
  return (await db.execute("SELECT * FROM regrade_runs WHERE id = 'run_a'")).rows[0];
}

function finishOptions(namespace = 'finish') {
  return {
    ...options(namespace),
    refreshTeacherModules: async () => ({ school: 'Alpha School' }),
  };
}

let harness;

beforeEach(async () => {
  harness = await createRecheckTestDatabase();
});

afterEach(async () => {
  await harness.close();
});

describe('reviewer evidence and mark edits', () => {
  it('moves an in-review request to awaiting_regrade after changed OCR evidence', async () => {
    await seedQuestion(harness.db, 'in_review');
    const result = await editAnswerEvidence(
      harness.db,
      actors.admin,
      'question_a',
      { studentWrote: 'Corrected OCR' },
      options(),
    );

    expect(result).toMatchObject({ changed: true, reviewRevision: 1 });
    expect((await question(harness.db)).review_revision).toBe(1);
    expect((await recheck(harness.db)).status).toBe('awaiting_regrade');
    expect(await eventTypes(harness.db)).toEqual(['awaiting_regrade']);
    expect((await harness.db.execute('SELECT event_type FROM question_review_events')).rows[0].event_type)
      .toBe('ocr_edited');
  });

  it('records take-up before awaiting_regrade when changed evidence arrives on open', async () => {
    await seedQuestion(harness.db, 'open');
    await editAnswerEvidence(
      harness.db,
      actors.admin,
      'question_a',
      { studentWrote: 'Corrected OCR' },
      options(),
    );
    expect(await eventTypes(harness.db)).toEqual(['status_in_review', 'awaiting_regrade']);
    expect(await recheck(harness.db)).toMatchObject({
      status: 'awaiting_regrade',
      taken_by: 'admin_a',
    });
  });

  it('does not increment revision or transition for identical OCR evidence', async () => {
    await seedQuestion(harness.db, 'in_review');
    const result = await editAnswerEvidence(
      harness.db,
      actors.admin,
      'question_a',
      { studentWrote: 'Original OCR' },
      options(),
    );
    expect(result.changed).toBe(false);
    expect((await question(harness.db)).review_revision).toBe(0);
    expect((await recheck(harness.db)).status).toBe('in_review');
    expect(await eventTypes(harness.db)).toEqual([]);
    expect((await harness.db.execute('SELECT COUNT(*) AS count FROM question_review_events')).rows[0].count)
      .toBe(0);
  });

  it('moves an in-review request after changed marks but not after the same marks', async () => {
    await seedQuestion(harness.db, 'in_review');
    const unchanged = await saveReviewDecision(
      harness.db,
      actors.admin,
      'question_a',
      { overrideMarks: 1 },
      options('same'),
    );
    expect(unchanged).toMatchObject({ changed: false, reviewRevision: 0 });
    expect((await recheck(harness.db)).status).toBe('in_review');

    const changed = await saveReviewDecision(
      harness.db,
      actors.admin,
      'question_a',
      { overrideMarks: 3 },
      options('changed'),
    );
    expect(changed).toMatchObject({ changed: true, marks: 3, reviewRevision: 1 });
    expect((await recheck(harness.db)).status).toBe('awaiting_regrade');
    expect(await eventTypes(harness.db)).toEqual(['awaiting_regrade']);
  });

  it('records a 0 entered on a held question that has no mark yet', async () => {
    await seedQuestion(harness.db, null, { aiMarks: null, approvedMarks: null });
    const result = await saveReviewDecision(
      harness.db,
      actors.admin,
      'question_a',
      { status: 'approved', overrideMarks: 0 },
      options('held'),
    );
    expect(result).toMatchObject({ changed: true, marks: 0, reviewRevision: 1 });
    const row = await question(harness.db);
    expect(row.approved_marks).toBe(0);
    expect(row.review_revision).toBe(1);
  });

  it.each([-1, -2, 6, 'not-a-number'])('rejects invalid corrected marks %s without mutation', async (value) => {
    await seedQuestion(harness.db, 'in_review');
    await expectContract(saveReviewDecision(
      harness.db,
      actors.admin,
      'question_a',
      { overrideMarks: value },
      options(),
    ), 400);
    expect((await question(harness.db)).review_revision).toBe(0);
    expect((await recheck(harness.db)).status).toBe('in_review');
  });

  it('allows negative corrected marks when the MCQ rubric has negative marking', async () => {
    const rubric = JSON.stringify({
      expected_response_type: 'mcq',
      marking_rubric: '4 marks for correct option B; 0 marks if no option selected; -1 mark for any other option.',
    });
    const payload = JSON.stringify({
      expectedResponseType: 'mcq',
      markingRubric: '4 marks for correct option B; 0 marks if no option selected; -1 mark for any other option.',
      studentAnswer: { studentWrote: 'A', attempted: true },
    });
    await harness.db.batch([
      ...seedCanonicalQuestionStatements({
        questionId: 'question_mcq',
        submissionId: 'submission_mcq',
        school: 'Alpha School',
        schoolId: 'school_alpha',
        subject: 'Physics',
        subjectId: 'subject_physics_alpha',
        examId: 'exam_mcq',
        setId: 'set_mcq',
        setQuestionId: 'esq_mcq',
        studentId: 'student_a',
        studentName: 'Asha',
        questionNumber: 'Q1',
        payloadJson: payload,
        aiMarks: 0,
        approvedMarks: 0,
        marksTotal: 4,
        updatedAt: '2026-07-24T11:00:00.000Z',
      }),
      { sql: 'UPDATE exam_set_questions SET rubric_json = ? WHERE id = ?', args: [rubric, 'esq_mcq'] },
    ], 'write');

    const result = await saveReviewDecision(
      harness.db,
      actors.admin,
      'question_mcq',
      { overrideMarks: -1, status: 'approved' },
      options('neg'),
    );
    expect(result.changed).toBe(true);
    const row = (await harness.db.execute("SELECT approved_marks FROM question_reviews WHERE submission_question_id = 'question_mcq'")).rows[0];
    expect(Number(row.approved_marks)).toBe(-1);
  });

  it.each([null, 'awaiting_regrade', 'resolved'])(
    'does not create a recheck transition for request state %s',
    async (status) => {
      await seedQuestion(harness.db, status);
      await editAnswerEvidence(
        harness.db,
        actors.admin,
        'question_a',
        { studentWrote: 'Corrected OCR' },
        options(),
      );
      if (status) expect((await recheck(harness.db)).status).toBe(status);
      expect(await eventTypes(harness.db)).toEqual([]);
    },
  );

  it('enforces school authorization before editing', async () => {
    await seedQuestion(harness.db, 'in_review');
    await expectContract(editAnswerEvidence(
      harness.db,
      actors.crossSchool,
      'question_a',
      { studentWrote: 'Tampered OCR' },
      options(),
    ), 403);
    expect((await question(harness.db)).review_revision).toBe(0);
  });
});

describe('regrade publication and resolution', () => {
  it.each(['queued', 'processing'])('does not resolve while an item is %s', async (state) => {
    const run = await seedRun(harness.db, [{ state, published: false }]);
    const result = await finishRunIfReady(harness.db, run, finishOptions());
    expect(result.status).toBe('running');
    expect((await recheck(harness.db)).status).toBe('awaiting_regrade');
    expect(await eventTypes(harness.db)).toEqual([]);
  });

  it('keeps a failed or partial run awaiting regrade', async () => {
    const run = await seedRun(harness.db, [{ state: 'failed', published: false }]);
    const result = await finishRunIfReady(harness.db, run, finishOptions());
    expect(result.status).toBe('partial');
    expect((await recheck(harness.db)).status).toBe('awaiting_regrade');
  });

  it('never resolves a run already marked failed', async () => {
    const run = await seedRun(harness.db, [{ state: 'completed', published: true }]);
    run.status = 'failed';
    await harness.db.execute("UPDATE regrade_runs SET status = 'failed' WHERE id = 'run_a'");
    const result = await finishRunIfReady(harness.db, run, finishOptions());
    expect(result.status).toBe('failed');
    expect((await recheck(harness.db)).status).toBe('awaiting_regrade');
    expect(await eventTypes(harness.db)).toEqual([]);
  });

  it('does not resolve a completed item without report-publication evidence', async () => {
    const run = await seedRun(harness.db, [{ state: 'completed', published: false }]);
    const result = await finishRunIfReady(harness.db, run, finishOptions());
    expect(result.status).toBe('partial');
    expect((await recheck(harness.db)).status).toBe('awaiting_regrade');
  });

  it('resolves only after every completed item has a published report version', async () => {
    const run = await seedRun(harness.db, [{ state: 'completed', published: true }]);
    const result = await finishRunIfReady(harness.db, run, finishOptions());
    expect(result.status).toBe('published');
    expect(await recheck(harness.db)).toMatchObject({
      status: 'resolved',
      resolved_by: 'skyll_processing_worker',
      resolved_at: '2026-07-24T12:00:00.000Z',
    });
    expect(await eventTypes(harness.db)).toEqual(['resolved_after_regrade']);
  });

  it('does not resolve when teacher projections fail to refresh', async () => {
    const run = await seedRun(harness.db, [{ state: 'completed', published: true }]);
    const result = await finishRunIfReady(harness.db, run, {
      ...options(),
      refreshTeacherModules: async () => {
        throw new Error('projection refresh failed');
      },
    });
    expect(result.status).toBe('partial');
    expect((await recheck(harness.db)).status).toBe('awaiting_regrade');
  });

  it('does not resolve open or in-review requests during publication', async () => {
    const run = await seedRun(harness.db, [{ state: 'completed', published: true }], 'open');
    const result = await finishRunIfReady(harness.db, run, finishOptions());
    expect(result.status).toBe('published');
    expect((await recheck(harness.db)).status).toBe('open');
    expect(await eventTypes(harness.db)).toEqual([]);
  });

  it('makes repeated or concurrent finish calls produce one resolution event', async () => {
    const run = await seedRun(harness.db, [{ state: 'completed', published: true }]);
    await Promise.all([
      finishRunIfReady(harness.db, run, finishOptions('first')),
      finishRunIfReady(harness.concurrentDb, run, finishOptions('second')),
    ]);
    await finishRunIfReady(harness.db, run, finishOptions('repeat'));
    expect((await recheck(harness.db)).status).toBe('resolved');
    expect(await eventTypes(harness.db)).toEqual(['resolved_after_regrade']);
  });
});
