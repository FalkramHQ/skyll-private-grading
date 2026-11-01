import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  editAnswerEvidence,
  saveReviewDecision,
} from '../../api/_lib/reviewerEditService.js';
import { RecheckContractError } from '../../api/_lib/recheckCollectionService.js';
import { createRecheckTestDatabase, seedCanonicalQuestionStatements } from './helpers/recheckTestDatabase.js';

const actors = {
  teacherAlpha: { username: 'teacher_alpha_intense', role: 'teacher', school: 'Alpha High', school_id: 'school_alpha' },
  teacherBeta: { username: 'teacher_beta_intense', role: 'teacher', school: 'Beta Academy', school_id: 'school_beta' },
  platformAdmin: { username: 'admin_root', role: 'skyll_admin', school: 'Platform', school_id: 'school_platform' },
};

function options(namespace = 'intense_test') {
  let count = 0;
  return {
    now: () => `2026-08-06T10:00:00.${String(count++).padStart(3, '0')}Z`,
    uuid: () => `${namespace}_${count}_${Math.random().toString(36).substring(2, 8)}`,
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

let harness;

beforeEach(async () => {
  harness = await createRecheckTestDatabase();
  const insertQueries = [];
  for (let i = 1; i <= 10; i++) {
    insertQueries.push(...seedCanonicalQuestionStatements({
      questionId: `q_alpha_${i}`,
      submissionId: 'sub_alpha_1',
      school: 'Alpha High',
      schoolId: 'school_alpha',
      subject: 'Physics',
      subjectId: 'subject_physics_alpha',
      examId: 'exam_alpha',
      setId: 'set_alpha',
      setQuestionId: `esq_alpha_${i}`,
      studentId: 'student_a1',
      studentName: 'Alice Alpha',
      questionNumber: `Q${i}`,
      payloadJson: `{"studentAnswer":{"studentWrote":"Alpha answer ${i}"}}`,
      aiMarks: 2,
      approvedMarks: 2,
      marksTotal: 5,
      updatedAt: '2026-08-06T09:00:00.000Z',
    }));
    insertQueries.push(...seedCanonicalQuestionStatements({
      questionId: `q_beta_${i}`,
      submissionId: 'sub_beta_1',
      school: 'Beta Academy',
      schoolId: 'school_beta',
      subject: 'Physics',
      subjectId: 'subject_physics_beta',
      examId: 'exam_beta',
      setId: 'set_beta',
      setQuestionId: `esq_beta_${i}`,
      studentId: 'student_b1',
      studentName: 'Bob Beta',
      questionNumber: `Q${i}`,
      payloadJson: `{"studentAnswer":{"studentWrote":"Beta answer ${i}"}}`,
      aiMarks: 3,
      approvedMarks: 3,
      marksTotal: 5,
      updatedAt: '2026-08-06T09:00:00.000Z',
    }));
  }
  await harness.db.batch(insertQueries, 'write');
});

afterEach(async () => {
  await harness.close();
});

describe('Intense API & Security Stress Testing: Teacher Review System', () => {
  it('Monotonic Revision Advancement & Dual-Write Parity Under Rapid Sequential Overrides', async () => {
    const qid = 'q_alpha_1';
    const markSequence = [3, 4, 1, 5, 2];
    let expectedRevision = 1;

    for (const score of markSequence) {
      const res = await saveReviewDecision(
        harness.db,
        actors.teacherAlpha,
        qid,
        { overrideMarks: score, status: 'approved', comment: `Sequential override to ${score}` },
        options(),
      );
      expect(res.changed).toBe(true);
      expect(res.marks).toBe(score);
      expect(res.reviewRevision).toBe(expectedRevision++);
    }

    // Verify canonical table exact state
    const canonical = (await harness.db.execute({ sql: 'SELECT * FROM submission_questions WHERE id = ?', args: [qid] })).rows[0];
    expect(Number(canonical.approved_marks)).toBe(2); // Final mark sequence value
    expect(Number(canonical.review_revision)).toBe(5);

    // Verify mirror question_reviews table state parity
    const reviewRecord = (await harness.db.execute({ sql: 'SELECT * FROM question_reviews WHERE submission_question_id = ?', args: [qid] })).rows[0];
    expect(Number(reviewRecord.approved_marks)).toBe(2);
    expect(reviewRecord.reviewer_id).toBe('teacher_alpha_intense');
    expect(reviewRecord.reason).toBe('Sequential override to 2');
  });

  it('Boundary Value Validation: handles zero scores and maximum ceiling scores accurately', async () => {
    // Override to absolute zero
    const resZero = await saveReviewDecision(
      harness.db,
      actors.teacherAlpha,
      'q_alpha_2',
      { overrideMarks: 0, status: 'approved' },
      options(),
    );
    expect(resZero.marks).toBe(0);
    const qZero = (await harness.db.execute({ sql: 'SELECT * FROM submission_questions WHERE id = ?', args: ['q_alpha_2'] })).rows[0];
    expect(Number(qZero.approved_marks)).toBe(0);

    // Override to maximum ceiling marks (5)
    const resMax = await saveReviewDecision(
      harness.db,
      actors.teacherAlpha,
      'q_alpha_2',
      { overrideMarks: 5, status: 'approved' },
      options(),
    );
    expect(resMax.marks).toBe(5);
    const qMax = (await harness.db.execute({ sql: 'SELECT * FROM submission_questions WHERE id = ?', args: ['q_alpha_2'] })).rows[0];
    expect(Number(qMax.approved_marks)).toBe(5);
  });

  it('Intensive Cross-School Penetration Defense: completely forbids multi-question unauthorized batch mutations', async () => {
    // Teacher Alpha attempts to mutate all 10 Beta Academy questions
    const attackPromises = [];
    for (let i = 1; i <= 10; i++) {
      attackPromises.push(
        expectContract(
          saveReviewDecision(harness.db, actors.teacherAlpha, `q_beta_${i}`, { overrideMarks: 0, status: 'approved' }, options()),
          403
        )
      );
      attackPromises.push(
        expectContract(
          editAnswerEvidence(harness.db, actors.teacherAlpha, `q_beta_${i}`, { studentWrote: 'Tampering' }, options()),
          403
        )
      );
    }
    await Promise.all(attackPromises);

    // Ensure zero drift in Beta Academy database records
    const betaQuestions = (await harness.db.execute({ sql: 'SELECT * FROM submission_questions WHERE school = ?', args: ['Beta Academy'] })).rows;
    expect(betaQuestions).toHaveLength(10);
    for (const q of betaQuestions) {
      expect(Number(q.approved_marks)).toBe(3); // Unmodified original marks
      expect(Number(q.review_revision)).toBe(0); // Unmodified revision
    }
  });

  it('Concurrent Batch Grading Session Simulation: processes 10 consecutive teacher reviews and verifies aggregate database consistency', async () => {
    // Simulate teacher grading an entire submission sheet
    for (let i = 1; i <= 10; i++) {
      await saveReviewDecision(
        harness.db,
        actors.teacherAlpha,
        `q_alpha_${i}`,
        { overrideMarks: 4, status: 'approved', comment: `Batch graded item ${i}` },
        options(),
      );
    }

    const reviewedCount = (await harness.db.execute({
      sql: `SELECT COUNT(*) as count FROM question_reviews WHERE reviewer_id = 'teacher_alpha_intense' AND state = 'approved'`
    })).rows[0].count;
    expect(Number(reviewedCount)).toBe(10);
  });

  it('Platform Admin Override Capability: skyll_admin role successfully supervises and reviews across multiple schools', async () => {
    const resAlpha = await saveReviewDecision(
      harness.db,
      actors.platformAdmin,
      'q_alpha_3',
      { overrideMarks: 5, status: 'approved', comment: 'Admin review Alpha' },
      options(),
    );
    expect(resAlpha.changed).toBe(true);

    const resBeta = await saveReviewDecision(
      harness.db,
      actors.platformAdmin,
      'q_beta_3',
      { overrideMarks: 5, status: 'approved', comment: 'Admin review Beta' },
      options(),
    );
    expect(resBeta.changed).toBe(true);
  });
});
