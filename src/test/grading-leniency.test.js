import { describe, expect, it } from 'vitest';
import { asReviewItem } from '../../api/vl-queue.js';
import { buildGradePrompt, buildMcqBatchGradePrompt, normalizeGradeResult } from '../../apps/processing-worker/gradeResult.js';
import { auditGrade } from '../../apps/processing-worker/gradeSupervisor.js';
import {
  HARSH_ZERO_TAG,
  PARTIAL_CREDIT_ENFORCED_TAG,
  normalizeCriteria,
  parseRubricCriteria,
  subjectivePartialCreditPolicy,
} from '../../shared/harshZero.js';

describe('mcq batch grading prompt', () => {
  it('asks for one grades array covering every listed question', () => {
    const prompt = buildMcqBatchGradePrompt({
      subject: 'Mathematics',
      items: [
        {
          question: { question_number: 'Q1', question_text: '2+2?', answer_key_text: 'A', marks_total: 4 },
          rubric: { expected_response_type: 'mcq', marking_rubric: 'Full marks: 4. Negative marks: -1' },
          evidence: { attempted: true, student_answer: 'A' },
        },
        {
          question: { question_number: 'Q2', question_text: '3+1?', answer_key_text: 'B', marks_total: 4 },
          rubric: { expected_response_type: 'mcq' },
          evidence: { attempted: true, student_answer: 'C' },
        },
      ],
    });
    expect(prompt).toContain('Grade every MCQ');
    expect(prompt).toContain('"grades"');
    expect(prompt).toContain('Q1');
    expect(prompt).toContain('Q2');
    expect(prompt).toContain('scheme=+4/0/-1');
  });
});

describe('grading leniency wiring', () => {
  it('backfills harsh_zero on review items from rationale without changing marks', () => {
    const item = asReviewItem(
      {
        id: 'q1', school: 'Partner Academy E', subject: 'Physics',
        student_id: 'stu_1', test_student_id: 'test_student_1',
        student_name: 'Roshan', question_number: '4.2', test_id: 'test_1',
        submission_score: 10, submission_max_marks: 40,
      },
      {
        grade: { marks: 0, allocated: 3, status: 'incorrect', confidence: 'high' },
        gradeRationale: {
          whatWentCorrect: "The student vaguely referenced 'opposes' and 'magnetic flux'.",
          missingOrWrong: 'No dipole explanation.',
        },
        studentAnswer: { attempted: true, studentWrote: 'opposes flux' },
        expectedResponseType: 'long_answer',
      },
      new Map([['test_1', { grade: '12th', subject: 'Physics', title: 'EMI' }]]),
      new Set(['test_1']),
      new Map([['test_1:test_student_1', 4]]),
      new Map(),
      new Map(),
      new Map(),
    );

    expect(item.grade.marks).toBe(0);
    expect(item.isHarshZero).toBe(true);
    expect(item.reviewTags).toContain(HARSH_ZERO_TAG);
  });

  it('sums criteria and never adds idea credit when prose admits understanding', () => {
    const grade = normalizeGradeResult(
      {
        marks_awarded: 0,
        criteria: [
          { id: 'lenz_statement', max: 1, marks: 0, note: 'wording wrong' },
          { id: 'dipole_explanation', max: 2, marks: 0, note: 'missing' },
        ],
        confidence: 'high',
        what_went_correct: 'Student mentioned opposition and conservation of energy.',
        needs_attention: 'Dipole explanation missing.',
        grading_reasoning: 'Zeroed despite partial understanding.',
      },
      { marks_total: 3 },
      { attempted: true },
      'long_answer',
      {
        markingRubric: '1 mark for stating Lenz\'s law. 2 marks for clear explanation of dipole formation.',
      },
    );
    expect(grade.marks).toBe(0);
    expect(grade.criteriaEnforced).toBe(false);
    expect(grade.reviewReasons).not.toContain(PARTIAL_CREDIT_ENFORCED_TAG);
    expect(grade.reviewReasons).not.toContain(HARSH_ZERO_TAG);
    expect(grade.isHarshZero).toBe(false);
  });

  it('does not invent criteria enforcement for MCQ', () => {
    const grade = normalizeGradeResult(
      {
        marks_awarded: 0,
        what_went_correct: 'Student correctly identified option concept but chose wrong letter.',
      },
      { marks_total: 1 },
      { attempted: true },
      'mcq',
    );
    expect(grade.marks).toBe(0);
    expect(grade.criteria).toEqual([]);
  });

  it('applies MCQ negative marking for wrong attempts and keeps blanks at 0', () => {
    const rubric = '4 marks for correct option B; 0 marks if no option selected; -1 mark for any other option.';
    const wrong = normalizeGradeResult(
      { marks_awarded: 0, grading_reasoning: 'Wrong option.' },
      { marks_total: 4, marking_rubric: rubric },
      { attempted: true, student_answer: 'A', option_letter: 'A' },
      'mcq',
    );
    expect(wrong.marks).toBe(-1);
    expect(wrong.status).toBe('incorrect');

    const blank = normalizeGradeResult(
      { marks_awarded: 0 },
      { marks_total: 4, marking_rubric: rubric },
      { attempted: false, student_answer: '' },
      'mcq',
    );
    expect(blank.marks).toBe(0);
    expect(blank.status).toBe('not_attempted');

    const correct = normalizeGradeResult(
      { marks_awarded: 4 },
      { marks_total: 4, marking_rubric: rubric },
      { attempted: true, student_answer: 'B', option_letter: 'B' },
      'mcq',
    );
    expect(correct.marks).toBe(4);
    expect(correct.status).toBe('correct');
  });

  it('treats "deduct 1" rubrics as -1, not max-1 partial credit', () => {
    const rubric = 'Award +4 if selected option is exactly C; award 0 if no option selected; deduct 1 for any other selection.';
    const wrong = normalizeGradeResult(
      {
        marks_awarded: 3,
        grading_reasoning: 'Deduct 1 from 4 for incorrect option D.',
        what_went_correct: 'The student attempted the question and selected an option.',
        needs_attention: 'The student selected option D, which is incorrect.',
      },
      { marks_total: 4, marking_rubric: rubric },
      { attempted: true, student_answer: 'D', option_letter: 'D' },
      'mcq',
    );
    expect(wrong.marks).toBe(-1);
    expect(wrong.status).toBe('incorrect');

    const noSchemePartial = normalizeGradeResult(
      { marks_awarded: 2 },
      { marks_total: 4, marking_rubric: '1 mark for correct option' },
      { attempted: true, student_answer: 'A', option_letter: 'A' },
      'mcq',
    );
    expect(noSchemePartial.marks).toBe(0);
  });

  it('does not feed invented final_answer polish into the grade prompt', () => {
    const prompt = buildGradePrompt({
      question: { question_text: 'Convert to propanal', answer_key_text: '...' },
      rubric: { expected_response_type: 'short_answer', marking_rubric: '1 mark' },
      evidence: {
        attempted: true,
        student_answer: 'incomplete arrow',
        final_answer: 'propanal via PCC oxidation',
      },
      maxMarks: 1,
    });
    expect(prompt).not.toMatch(/Final answer evidence/i);
    expect(prompt).not.toContain('propanal via PCC');
    expect(prompt).toContain('incomplete arrow');
  });

  it('mentions negative MCQ scheme in the grade prompt when present', () => {
    const prompt = buildGradePrompt({
      question: { question_text: 'Pick option', answer_key_text: 'B' },
      rubric: {
        expected_response_type: 'mcq',
        marking_rubric: '4 marks for correct option B; 0 marks if no option selected; -1 mark for any other option.',
      },
      evidence: { attempted: true, student_answer: 'A' },
      maxMarks: 4,
    });
    expect(prompt).toContain('between -1 and 4');
    expect(prompt).toContain('MCQ MARKING SCHEME');
  });

  it('adds partial-credit policy only for subjective grade prompts', () => {
    const longPrompt = buildGradePrompt({
      question: { question_text: 'State Lenz law', answer_key_text: 'Opposes change in flux' },
      rubric: { expected_response_type: 'long_answer', marking_rubric: '1 mark for stating Lenz law. 2 marks for dipole explanation.' },
      evidence: { attempted: true, student_answer: 'opposes flux' },
      maxMarks: 3,
    });
    const mcqPrompt = buildGradePrompt({
      question: { question_text: 'Pick option', answer_key_text: 'b' },
      rubric: { expected_response_type: 'mcq', marking_rubric: '1 for correct option' },
      evidence: { attempted: true, student_answer: 'b' },
      maxMarks: 1,
    });
    expect(longPrompt).toContain(subjectivePartialCreditPolicy().slice(0, 40));
    expect(longPrompt).toContain('"criteria"');
    expect(mcqPrompt).not.toContain('PARTIAL CREDIT POLICY');
  });
});

describe('criteria helpers', () => {
  it('parses mark-for rubric lines', () => {
    const stubs = parseRubricCriteria(
      '1 mark for stating Lenz\'s law. 2 marks for clear explanation of dipole formation.',
      3,
    );
    expect(stubs).toHaveLength(2);
    expect(stubs[0].max).toBe(1);
    expect(stubs[1].max).toBe(2);
  });

  it('sums criteria and keeps a credited-zero criterion at zero', () => {
    const { criteria, sum, enforcedIds } = normalizeCriteria(
      [
        { id: 'a', max: 1, marks: 0, note: 'Student correctly mentioned opposition.' },
        { id: 'b', max: 2, marks: 0, note: 'missing dipole' },
      ],
      [
        { id: 'a', max: 1, label: 'statement' },
        { id: 'b', max: 2, label: 'dipole' },
      ],
      { whatWentCorrect: '' },
    );
    expect(criteria[0].marks).toBe(0);
    expect(criteria[1].marks).toBe(0);
    expect(sum).toBe(0);
    expect(enforcedIds).toEqual([]);
  });
});

describe('grade supervisor', () => {
  const question = {
    question_text: "State Lenz's law and explain dipole formation.",
    answer_key_text: 'Opposes change in flux; approaching/receding dipole.',
    marks_total: 3,
    expected_response_type: 'long_answer',
  };
  const rubric = {
    expected_response_type: 'long_answer',
    marking_rubric: '1 mark for stating Lenz\'s law. 2 marks for clear explanation of dipole formation.',
  };
  const evidence = {
    attempted: true,
    student_answer: 'Statement:- induced current opposes current of magnetic flux. Lenz law follow. Conservation of energy.',
  };

  it('never asks to raise a harsh zero or fill in missing criteria', () => {
    const audit = auditGrade({
      marks: 0,
      whatWentCorrect: "The student vaguely referenced 'opposes' and 'magnetic flux'.",
      criteria: [],
      attempted: true,
      isHarshZero: true,
    }, { question, evidence, responseType: 'long_answer', markingRubric: rubric.marking_rubric });
    expect(audit).toEqual({ action: 'ok', reasons: [] });
  });

  it('asks for a downward recheck when the feedback names an error on a high mark', () => {
    const audit = auditGrade({
      marks: 3,
      attempted: true,
      needsAttention: 'The dipole explanation is incorrect: the poles are reversed.',
      criteria: [],
    }, { question, evidence, responseType: 'long_answer', markingRubric: rubric.marking_rubric });
    expect(audit.action).toBe('repair_down');
    expect(audit.reasons).toContain('stated_error_high_marks');
  });
});
