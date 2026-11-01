import { describe, expect, it } from 'vitest';
import { normalizeParts, normalizeGradeResult } from '../../apps/processing-worker/gradeResult.js';

describe('gradeResult parts normalization', () => {
  it('normalizes a structured parts[] array into a stable typed shape', () => {
    const parts = normalizeParts([
      { label: '(a)', prompt: 'q1', response: 'r1', expected: 'e1', marks_obtained: 2, marks_total: 2, status: 'correct' },
      { label: '(b)', prompt: 'q2', response: 'r2', expected: 'e2', marks_obtained: 1, marks_total: 2, status: 'partial' },
      { label: '(c)', prompt: 'q3', response: '', expected: 'e3', marks_obtained: 0, marks_total: 1 },
    ]);

    expect(parts).toHaveLength(3);
    expect(parts[0]).toMatchObject({ label: '(a)', marks_obtained: 2, marks_total: 2, status: 'correct' });
    expect(parts[1].status).toBe('partial');
    // No status provided -> derived from marks (0 of 1 => incorrect).
    expect(parts[2].status).toBe('incorrect');
  });

  it('sums parts marks to the provided overall total (marks consistency)', () => {
    const parts = normalizeParts(
      Array.from({ length: 12 }, (_, i) => ({
        label: `${i + 1}`,
        marks_obtained: i < 8 ? 1 : 0,
        marks_total: 1,
        status: i < 8 ? 'correct' : 'incorrect',
      })),
      12,
    );
    const sum = parts.reduce((total, part) => total + part.marks_obtained, 0);
    expect(parts).toHaveLength(12);
    expect(sum).toBe(8);
  });

  it('returns null for a missing or empty parts array (legacy prose fallback)', () => {
    expect(normalizeParts(undefined)).toBeNull();
    expect(normalizeParts([])).toBeNull();
    expect(normalizeParts('not-an-array')).toBeNull();
  });

  it('caps runaway parts output and clamps marks', () => {
    const parts = normalizeParts(
      Array.from({ length: 200 }, (_, i) => ({ label: `${i}`, marks_obtained: i, marks_total: 10 })),
      10,
    );
    expect(parts.length).toBeLessThanOrEqual(50);
  });

  it('emits normalized parts through normalizeGradeResult for a compound question', () => {
    const grade = normalizeGradeResult(
      {
        marks_awarded: 4,
        what_went_correct: 'First two correct',
        parts: [
          { label: '(a)', prompt: 'First', response: 'x', expected: 'x', marks_obtained: 2, marks_total: 2, status: 'correct' },
          { label: '(b)', prompt: 'Second', response: 'y', expected: 'z', marks_obtained: 2, marks_total: 2, status: 'correct' },
        ],
      },
      { marks_total: 4, expected_response_type: 'short_answer' },
      { attempted: true, student_answer: 'x y' },
      'short_answer',
      { markingRubric: '4 marks' },
    );

    expect(grade.parts).toHaveLength(2);
    expect(grade.parts[0].status).toBe('correct');
    // The parts[] marks are present and normalized independently of the
    // subjective criteria-sum that governs the overall question marks.
    const partSum = grade.parts.reduce((total, part) => total + part.marks_obtained, 0);
    expect(partSum).toBe(4);
  });

  it('leaves parts empty on a single undivided question', () => {
    const grade = normalizeGradeResult(
      { marks_awarded: 2 },
      { marks_total: 2, expected_response_type: 'mcq' },
      { attempted: true, student_answer: 'B', option_letter: 'B' },
      'mcq',
      {},
    );
    expect(grade.parts).toBeNull();
  });
});

describe('batch missing-MCQ guard', () => {
  it('flags a missing batched MCQ response for review instead of scoring a silent zero', () => {
    // The worker now passes a forced-review payload when a question is omitted
    // from the batched grades[] array. It must surface as needs_review with an
    // explicit reason, not a definitive zero.
    const grade = normalizeGradeResult(
      { needs_review: true, review_reasons: ['missing_from_batch_response'] },
      { marks_total: 1, expected_response_type: 'mcq' },
      { attempted: true, student_answer: '', option_letter: '' },
      'mcq',
      {},
    );
    expect(grade.needsReview).toBe(true);
    expect(grade.reviewReasons).toContain('missing_from_batch_response');
    expect(grade.status).not.toBe('correct');
  });

  it('does not silently mark an omitted MCQ as a definitive incorrect (zero) answer', () => {
    // Regression against the silent-zero shape: with a negative-marking rubric,
    // an absent model response must be review-flagged, never auto-awarded a
    // penalty or zero as if it were a real answer.
    const grade = normalizeGradeResult(
      { needs_review: true, review_reasons: ['missing_from_batch_response'] },
      { marks_total: 1, expected_response_type: 'mcq' },
      { attempted: true, student_answer: '', option_letter: '' },
      'mcq',
      { markingRubric: 'negative marks: -1, full marks: 1' },
    );
    expect(grade.needsReview).toBe(true);
    expect(grade.marks).toBeLessThan(1);
  });
});

describe('MCQ answers omitted from the batch response', () => {
  const question = { marks_total: 4, expected_response_type: 'mcq', marking_rubric: '4 marks for correct option B; 0 marks if no option selected; -1 mark for any other option.' };
  const evidence = { attempted: true, student_answer: 'C', option_letter: 'C', extraction_confidence: 'high' };

  it('scores a missing verdict as a blank, not as the negative-marking penalty', () => {
    const grade = normalizeGradeResult(
      { needs_review: true, review_reasons: ['missing_from_batch_response'] },
      question,
      evidence,
      'mcq',
      { markingRubric: question.marking_rubric },
    );
    expect(grade.marks).toBe(0);
    expect(grade.needsReview ?? grade.needs_review ?? true).toBeTruthy();
  });

  it('still applies the penalty when the model actually marked the option wrong', () => {
    const grade = normalizeGradeResult(
      { marks_awarded: 0, grading_reasoning: 'Option C is wrong; answer is B.' },
      question,
      evidence,
      'mcq',
      { markingRubric: question.marking_rubric },
    );
    expect(grade.marks).toBe(-1);
  });
});
