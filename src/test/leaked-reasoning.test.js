// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../api/_lib/llmGateway.js', () => ({ callJsonModel: vi.fn() }));

import { callJsonModel } from '../../api/_lib/llmGateway.js';
import { generateQuestionFeedback } from '../../api/_lib/cohortRegrade.js';
import { normalizeGradeResult } from '../../apps/processing-worker/gradeResult.js';
import { LEAKED_REASONING_TAG, feedbackLeaksReasoning } from '../../shared/harshZero.js';
import { REVIEW_TAG_LABELS } from '../../shared/reviewFlags.js';

// From a real grade (fictional demo paper): the model's notes about its own
// output were stored as the grading reason and would reach the student report.
const LEAKED = 'Part (i) earns 1 mark for the correct probability 3/10. Part (ii) earns 0 of 2 marks because the method and answer are both wrong. Total marks awarded = 1 + 0 + 0 = 1, but the rubric total is 5; however, the system will overwrite marks_awarded with the sum of criteria marks, which is 1. Wait, the criteria sum is 1, but the parts sum is 1. However, the instruction says marks_awarded MUST equal the sum of criteria[].marks. I will set marks_awarded to 1. The final answer should be JSON only. I will output the JSON.';

const question = { marks_total: 5, expected_response_type: 'numerical' };
const evidence = { attempted: true, student_answer: '(i) 3/10 (ii) 1 - 5 = 4 (iii) 7/8', extraction_confidence: 'high' };

describe('feedbackLeaksReasoning', () => {
  it('catches the grader talking about its own output', () => {
    expect(feedbackLeaksReasoning(LEAKED)).toBe(true);
    expect(feedbackLeaksReasoning('I will output the JSON with the marks.')).toBe(true);
    expect(feedbackLeaksReasoning('Let me recheck the second criterion.')).toBe(true);
    expect(feedbackLeaksReasoning('The marks are 3/5. Wait, the method mark was missed.')).toBe(true);
    expect(feedbackLeaksReasoning('The schema requires marks_obtained per part.')).toBe(true);
  });

  it('leaves ordinary feedback alone', () => {
    for (const fine of [
      'The student correctly factorised the quadratic but reversed the signs of the roots.',
      'Write the units with the final answer: h = 51.96 m.',
      'Practise solving each factor set to zero, then check by substitution.',
      'The student used the formula correctly; the output of the calculation is 570.',
      'Part (ii) needs 1 − P(red), which gives 1/2.',
      'The student did not wait to simplify 5/10 before writing the answer.',
      '',
    ]) expect(feedbackLeaksReasoning(fine), fine).toBe(false);
  });
});

describe('normalizeGradeResult with leaked reasoning', () => {
  it('keeps the mark, replaces the leaked reason, and flags it for a teacher', () => {
    const grade = normalizeGradeResult(
      {
        marks_awarded: 1,
        what_went_correct: 'Part (i) is correct: P(blue) = 3/10.',
        needs_attention: 'Part (ii) should be 1 − 5/10 = 1/2.',
        grading_reasoning: LEAKED,
      },
      question,
      evidence,
      'numerical',
      { mode: 'flag' },
    );
    expect(grade.marks).toBe(1);
    expect(grade.reasoning).toBe('Partial credit (1/5) — answer is partially correct.');
    expect(grade.whatWentCorrect).toBe('Part (i) is correct: P(blue) = 3/10.');
    expect(grade.needsAttention).toBe('Part (ii) should be 1 − 5/10 = 1/2.');
    expect(grade.needsReview).toBe(true);
    expect(grade.reviewReasons).toContain(LEAKED_REASONING_TAG);
  });

  it('does not flag clean feedback', () => {
    const grade = normalizeGradeResult(
      { marks_awarded: 1, what_went_correct: 'Part (i) is correct.', grading_reasoning: 'Only part (i) earns its mark.' },
      question,
      evidence,
      'numerical',
      { mode: 'flag' },
    );
    expect(grade.reasoning).toBe('Only part (i) earns its mark.');
    expect(grade.reviewReasons).not.toContain(LEAKED_REASONING_TAG);
  });

  it('gives teachers a plain label for the tag', () => {
    expect(REVIEW_TAG_LABELS[LEAKED_REASONING_TAG].label).toBe('Grader notes removed');
  });
});

describe('generateQuestionFeedback with leaked reasoning', () => {
  const snapshot = { approvedMarks: 2, marksTotal: 5, questionText: 'Q8', markingRubric: '', studentAnswer: '' };

  it('falls back to the clean draft, then to a plain statement of the fixed mark', async () => {
    callJsonModel
      .mockResolvedValueOnce({ result: { what_went_correct: 'Part (i) is correct.', needs_attention: 'Part (ii) is wrong.', next_step: 'Review complements.', grading_reasoning: LEAKED }, model: 'm' })
      .mockResolvedValueOnce({ result: { what_went_correct: 'I will output the JSON now.', needs_attention: 'Part (ii) is wrong.', next_step: '', grading_reasoning: 'Let me recheck: 2 marks.' }, model: 'm' });
    const feedback = await generateQuestionFeedback(snapshot, 'english');
    expect(feedback.whatWentCorrect).toBe('Part (i) is correct.');
    expect(feedback.needsAttention).toBe('Part (ii) is wrong.');
    expect(feedback.nextStep).toBe('Review complements.');
    expect(feedback.gradingReasoning).toBe('2/5 marks, as confirmed by your teacher.');
  });
});
