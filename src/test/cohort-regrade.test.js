import { describe, expect, it } from 'vitest';
import { applyFeedbackToQuestion, applyFeedbackToReport, buildQuestionSnapshot } from '../../api/_lib/cohortRegrade.js';

const snapshot = {
  questionId: 'question_1',
  submissionId: 'submission_1',
  questionNumber: 'Q2',
  approvedMarks: 1,
  marksTotal: 2,
  attempted: true,
  studentAnswer: 'The student wrote one correct step.',
  payload: {
    studentAnswer: { attempted: true, studentWrote: 'The student wrote one correct step.' },
    grade: { marks: 0, allocated: 2, status: 'incorrect' },
  },
};

const feedback = {
  whatWentCorrect: 'The first calculation is correct.',
  needsAttention: 'The final unit is missing.',
  nextStep: 'Write the final value with units.',
  gradingReasoning: 'One of two required parts is correct.',
  model: 'test-model',
};

describe('cohort regrade projections', () => {
  it('preserves reviewer-approved marks while replacing stale rationale', () => {
    const next = applyFeedbackToQuestion(snapshot, feedback, 'run_1', 2);
    expect(next.grade).toMatchObject({ marks: 1, allocated: 2, status: 'partial' });
    expect(next.gradeRationale).toMatchObject({ missingOrWrong: feedback.needsAttention, nextStep: feedback.nextStep });
    expect(next.regrade).toMatchObject({ runId: 'run_1', revision: 2 });
  });

  it('updates only the matching report question and recalculates the subject score', () => {
    const report = {
      term1: {
        subjects: [{
          name: 'Accounts',
          score: 0,
          total: 3,
          questions: [
            { number: 'Q1', marks_obtained: 1, marks_total: 1, counts_toward_score: true },
            { number: 'Q2', marks_obtained: 0, marks_total: 2, counts_toward_score: true },
          ],
        }],
      },
    };
    const next = applyFeedbackToReport(report, { subject: 'Accounts', question_number: 'Q2' }, snapshot, feedback);
    const subject = next.term1.subjects[0];
    expect(subject.score).toBe(2);
    expect(subject.questions[1]).toMatchObject({ marks_obtained: 1, status: 'partial', next_step: feedback.nextStep });
    expect(report.term1.subjects[0].questions[1].marks_obtained).toBe(0);
  });

  it('uses accepted visual evidence when OCR is only an image placeholder', () => {
    const row = {
      id: 'question_1',
      submission_id: 'submission_1',
      question_number: 'Q3',
      subject: 'Chemistry',
      student_name: 'Aditi',
      marks_total: 2,
      ai_marks: 0,
      payload_json: JSON.stringify({
        studentAnswer: { studentWrote: '[image placeholders]' },
        visualReview: { usable: true, visualAnswer: 'The student drew the correct octahedral diagram.' },
      }),
    };
    const next = buildQuestionSnapshot(row, { approved_marks: 2 });
    expect(next.studentAnswer).toBe('The student drew the correct octahedral diagram.');
    expect(next.evidenceSource).toBe('accepted_visual_evidence');
  });
});
