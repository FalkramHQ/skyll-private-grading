import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  editAnswerEvidence,
  saveReviewDecision,
} from '../../api/_lib/reviewerEditService.js';
import { RecheckContractError } from '../../api/_lib/recheckCollectionService.js';
import { createRecheckTestDatabase, seedCanonicalQuestionStatements } from './helpers/recheckTestDatabase.js';

const actors = {
  teacherAlpha: { username: 'teacher_alpha', role: 'teacher', school: 'Alpha School', school_id: 'school_alpha' },
  teacherBeta: { username: 'teacher_beta', role: 'teacher', school: 'Beta School', school_id: 'school_beta' },
  student: { username: 'student_a', role: 'student', school: 'Alpha School', school_id: 'school_alpha' },
  guest: { username: 'guest_user', role: 'guest', school: 'Alpha School', school_id: 'school_alpha' },
};

function options(namespace = 'teacher_test') {
  let count = 0;
  return {
    now: () => '2026-08-05T12:00:00.000Z',
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

async function seedQuestion(db) {
  await db.batch([
    ...seedCanonicalQuestionStatements({
      questionId: 'question_alpha',
      submissionId: 'submission_alpha',
      school: 'Alpha School',
      schoolId: 'school_alpha',
      subject: 'Chemistry',
      subjectId: 'subject_chem_alpha',
      examId: 'exam_alpha',
      setId: 'set_alpha',
      setQuestionId: 'esq_alpha',
      studentId: 'student_alpha',
      studentName: 'Siddharth',
      questionNumber: 'Q1',
      payloadJson: '{"studentAnswer":{"studentWrote":"Original OCR answer"}}',
      aiMarks: 2,
      approvedMarks: 2,
      marksTotal: 5,
      updatedAt: '2026-08-05T11:00:00.000Z',
    }),
  ], 'write');
}

async function question(db, id = 'question_alpha') {
  return (await db.execute({ sql: 'SELECT * FROM submission_questions WHERE id = ?', args: [id] })).rows[0];
}

let harness;

beforeEach(async () => {
  harness = await createRecheckTestDatabase();
  await seedQuestion(harness.db);
});

afterEach(async () => {
  await harness.close();
});

describe('Teacher review dashboard role access parity and school scoping', () => {
  it('allows a teacher to edit OCR answer evidence within their assigned school', async () => {
    const result = await editAnswerEvidence(
      harness.db,
      actors.teacherAlpha,
      'question_alpha',
      { studentWrote: 'Teacher corrected OCR answer' },
      options(),
    );

    expect(result).toMatchObject({ changed: true, reviewRevision: 1 });
    const updated = await question(harness.db);
    expect(updated.review_revision).toBe(1);
    expect(JSON.parse(updated.payload_json).studentAnswer.studentWrote).toBe('Teacher corrected OCR answer');
  });

  it('allows a teacher to save review decisions (override marks and approve) within their assigned school', async () => {
    const result = await saveReviewDecision(
      harness.db,
      actors.teacherAlpha,
      'question_alpha',
      { overrideMarks: 4, status: 'approved', comment: 'Teacher override justification' },
      options(),
    );

    expect(result).toMatchObject({ changed: true, marks: 4, reviewRevision: 1 });
    const updated = await question(harness.db);
    expect(Number(updated.approved_marks)).toBe(4);
    
    const reviewDecision = (await harness.db.execute({
      sql: "SELECT * FROM question_reviews WHERE submission_question_id = 'question_alpha'",
    })).rows[0];
    expect(reviewDecision).toMatchObject({
      state: 'approved',
      approved_marks: 4,
      reviewer_id: 'teacher_alpha',
      reason: 'Teacher override justification',
    });
  });

  it('denies teachers access when trying to edit OCR evidence or override marks in another school (tenancy isolation)', async () => {
    await expectContract(
      editAnswerEvidence(
        harness.db,
        actors.teacherBeta,
        'question_alpha',
        { studentWrote: 'Unauthorized cross-school edit' },
        options(),
      ),
      403,
    );

    await expectContract(
      saveReviewDecision(
        harness.db,
        actors.teacherBeta,
        'question_alpha',
        { overrideMarks: 5, status: 'approved' },
        options(),
      ),
      403,
    );
  });

  it('rejects unsupported roles (student, guest) from performing review actions', async () => {
    await expectContract(
      editAnswerEvidence(
        harness.db,
        actors.student,
        'question_alpha',
        { studentWrote: 'Student attempt' },
        options(),
      ),
      403,
    );

    await expectContract(
      saveReviewDecision(
        harness.db,
        actors.guest,
        'question_alpha',
        { overrideMarks: 5 },
        options(),
      ),
      403,
    );
  });
});
