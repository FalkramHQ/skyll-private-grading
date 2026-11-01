// A block of MCQs stored as one "mcq" question is graded one mark per item.
// PartnerD's ICSE Physics Q1 (15 MCQs, "1 mark for each correct option") scored 0/15
// for every student, including one with 12 right (22 Oct 2026).
import { describe, expect, it } from 'vitest';
import { checkRubricGate, gradingResponseType } from '../../shared/rubricGate.js';
import { gradeWithSupervision } from '../../apps/processing-worker/gradeSupervisor.js';
import { parseRubricCriteria } from '../../shared/harshZero.js';

const block = {
  question: { question_text: 'Choose the correct option for each of the following. (1) … (15) … [15]', answer_key_text: '1-(d), 2-(b), 3-(d) …', marks_total: 15, expected_response_type: 'mcq' },
  rubric: { expected_response_type: 'mcq', marking_rubric: '1 mark for each correct option; 15 marks total.' },
  evidence: { attempted: true, student_answer: '1 d 2 b 3 d 4 a 5 c 6 d 7 b 8 a 9 d 10 d 11 c 12 d 13 a 14 b 15 a' },
};

describe('multi-item MCQ blocks', () => {
  it('are graded as short answers; a single MCQ stays all-or-nothing', () => {
    expect(gradingResponseType('mcq', { marks: 15, markingRubric: '1 mark for each correct option; 15 marks total.' })).toBe('short_answer');
    expect(gradingResponseType('mcq', { marks: 1, markingRubric: '1 mark for the correct option.' })).toBe('mcq');
    expect(gradingResponseType('mcq', { marks: 2, markingRubric: '2 marks for the correct option.' })).toBe('mcq');
    expect(gradingResponseType('short_answer', { marks: 4, markingRubric: '1 mark for each point.' })).toBe('short_answer');
  });

  it('keeps per-item credit (12 of 15) instead of scoring 0', async () => {
    const prompts = [];
    const callJson = async (prompt) => {
      prompts.push(prompt);
      return { value: { marks_awarded: 12, criteria: [{ id: 'items', max: 15, marks: 12, note: '12 of 15 options correct.' }], what_went_correct: '12 options match the key.' } };
    };
    const result = await gradeWithSupervision({ ...block, subject: 'Physics', callJson });
    expect(result.grade.marks).toBe(12);
    expect(prompts[0]).not.toMatch(/MCQ scoring is binary/);
  });

  it('warns the reviewer that the block is scored per item', () => {
    const { errors, warnings } = checkRubricGate({ exam: { total_marks: 15 }, questions: [{ number: 'Q1', marks_allocated: 15, expected_response_type: 'mcq', question_text: block.question.question_text, correct_answer_summary: block.question.answer_key_text, marking_rubric: block.rubric.marking_rubric }] });
    expect(warnings.map((w) => w.code)).toContain('MCQ_BLOCK_PER_ITEM');
    expect(errors.filter((e) => e.question === 'Q1')).toEqual([]);
  });
});

describe('per-item rubric bands', () => {
  it('are worth what the fixed bands leave of the question, not their face value', () => {
    expect(parseRubricCriteria('1 mark for each correct option; 15 marks total.', 15)).toEqual([{ id: 'each_correct_option', max: 15, label: 'each correct option' }]);
    expect(parseRubricCriteria('2 marks for the diagram; 1 mark for each correct label.', 5).map((c) => c.max)).toEqual([2, 3]);
    expect(parseRubricCriteria('1 mark for definition; 2 marks for diagram.', 3).map((c) => c.max)).toEqual([1, 2]);
    expect(parseRubricCriteria('1 mark for each correct option.', 1).map((c) => c.max)).toEqual([1]);
  });

  it('let a grade of 12 per-item marks stand (the grader returned the real per-item criterion)', async () => {
    const prompts = [];
    const callJson = async (prompt) => {
      prompts.push(prompt);
      return { value: { marks_awarded: 12, criteria: [{ id: 'each_correct_option', max: 15, marks: 12, note: '12 of 15 options correct; item 1, 7 and 12 wrong.' }], what_went_correct: '12 of 15 items correct.' } };
    };
    const result = await gradeWithSupervision({ ...block, subject: 'Physics', callJson });
    expect(prompts[0]).toContain('"max":15');
    expect(result.grade.marks).toBe(12);
  });
});
