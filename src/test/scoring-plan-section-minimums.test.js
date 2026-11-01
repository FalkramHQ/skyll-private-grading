import { describe, expect, it } from 'vitest';
import { applyScoringPlan, normalizeScoringPlan } from '../../apps/processing-worker/scoringPlan.js';
import { checkRubricGate, effectiveTotal } from '../../shared/rubricGate.js';
import { normalizeScoringPlan as normalizeBuiltPlan, validateRubricPackage } from '../../workers/mistral-ocr/src/ocrProtocol.js';

// Partner Academy D, 10th ICSE Semi Prelim English Literature (24 Oct 2026):
// "Section A is compulsory. Attempt one question from each of Sections B, C and D
// and one other question from any section." Q1 is Section A; B = Q2–Q3,
// C = Q4–Q5, D = Q6–Q7. Every question carries 16 marks; the paper is out of 80.
const units = (...numbers) => numbers.map((number) => ({ id: number, question_numbers: [number] }));
const partnerdBuilderPlan = {
  groups: [
    { id: 'section_b', choose: 1, units: units('Q2', 'Q3') },
    { id: 'section_c', choose: 1, units: units('Q4', 'Q5') },
    { id: 'section_d', choose: 1, units: units('Q6', 'Q7') },
    { id: 'additional_choice', choose: 1, units: units('Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7') },
  ],
};
const partnerdExplicitPlan = {
  groups: [{
    id: 'sections_b_c_d',
    choose: 4,
    units: units('Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7'),
    at_least: [
      { id: 'section_b', choose: 1, question_numbers: ['Q2', 'Q3'] },
      { id: 'section_c', choose: 1, question_numbers: ['Q4', 'Q5'] },
      { id: 'section_d', choose: 1, question_numbers: ['Q6', 'Q7'] },
    ],
  }],
};
const partnerdRubricQuestions = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7'].map((number) => ({ number, marks_allocated: 16 }));
const graded = (marks) => ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7'].map((number) => ({
  number,
  marks_total: 16,
  marks_obtained: marks[number] ?? 0,
  attempted: number in marks,
}));
const counted = (result) => result.questions.filter((question) => question.counts_toward_score).map((question) => question.number);

describe('"one from each section and one more" choice rules', () => {
  it.each([
    ['as the builder emitted it (overlapping groups)', partnerdBuilderPlan],
    ['as one group with at_least minimums', partnerdExplicitPlan],
  ])('scores the PartnerD English Literature answers out of 80 %s', (_, plan) => {
    // Answered Q1, both Section B questions, Q5 and Q7: all five count.
    const result = applyScoringPlan(graded({ Q1: 11, Q2: 12, Q3: 12, Q5: 12, Q7: 11 }), plan);

    expect(result.score).toBe(58);
    expect(result.total).toBe(80);
    expect(counted(result)).toEqual(['Q1', 'Q2', 'Q3', 'Q5', 'Q7']);
  });

  it('meets every section minimum before taking the best of the rest', () => {
    // Unconstrained best-four would be Q2, Q3, Q4, Q5 and leave Section D out.
    const result = applyScoringPlan(graded({ Q1: 10, Q2: 15, Q3: 14, Q4: 13, Q5: 12, Q6: 3, Q7: 1 }), partnerdBuilderPlan);

    expect(counted(result)).toEqual(['Q1', 'Q2', 'Q3', 'Q4', 'Q6']);
    expect(result.score).toBe(55);
    expect(result.total).toBe(80);
  });

  it('still charges a skipped section against the total', () => {
    const result = applyScoringPlan(graded({ Q1: 10, Q2: 10, Q3: 10, Q4: 10, Q5: 10 }), partnerdBuilderPlan);

    expect(result.total).toBe(80);
    expect(result.score).toBe(40);
    expect(counted(result)).toHaveLength(5);
  });

  it('folds the overlapping groups into one group with section minimums', () => {
    const plan = normalizeScoringPlan(partnerdBuilderPlan);

    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]).toMatchObject({ id: 'additional_choice', choose: 4 });
    expect(plan.groups[0].at_least.map((minimum) => [minimum.id, minimum.choose])).toEqual([['section_b', 1], ['section_c', 1], ['section_d', 1]]);
    expect(normalizeBuiltPlan(partnerdBuilderPlan).groups).toEqual([expect.objectContaining({ choose: 4, at_least: expect.any(Array) })]);
  });

  it('totals the paper at 80, with no gate error', () => {
    for (const plan of [partnerdBuilderPlan, partnerdExplicitPlan]) {
      expect(effectiveTotal(partnerdRubricQuestions, plan)).toBe(80);
      const gate = checkRubricGate({ exam: { scoring_plan: plan }, quality: { declaredTotalMarks: 80 }, questions: partnerdRubricQuestions });
      expect(gate.errors.map((e) => e.code)).not.toContain('TOTAL_MISMATCH');
      expect(gate.errors.map((e) => e.code)).not.toContain('CHOICE_GROUPS_OVERLAP');
    }
  });

  it('stores the explicit form when the builder emits overlapping groups', () => {
    const rubric = validateRubricPackage({
      exam: { total_marks: 80, scoring_plan: partnerdBuilderPlan },
      questions: partnerdRubricQuestions.map((question) => ({
        ...question,
        question_text: 'Answer the question.',
        correct_answer_summary: 'x',
        marking_rubric: '16 marks for a complete answer',
        expected_response_type: 'long_answer',
      })),
    }, { gate: true });

    expect(rubric.quality.effectiveTotalMarks).toBe(80);
    expect(rubric.exam.scoring_plan.groups).toHaveLength(1);
  });

  it('flags groups that overlap without nesting', () => {
    const plan = { groups: [
      { id: 'left', choose: 1, units: units('Q2', 'Q3', 'Q4') },
      { id: 'right', choose: 1, units: units('Q4', 'Q5', 'Q6') },
    ] };
    const gate = checkRubricGate({ exam: { scoring_plan: plan }, questions: partnerdRubricQuestions });

    expect(gate.errors.map((e) => e.code)).toContain('CHOICE_GROUPS_OVERLAP');
  });
});

describe('non-overlapping section groups are unchanged', () => {
  // A typical "any two of Section B, any one of Section C" paper.
  const plan = { groups: [
    { id: 'section_b', choose: 2, units: units('Q2', 'Q3', 'Q4') },
    { id: 'section_c', choose: 1, units: units('Q5', 'Q6') },
  ] };
  const questions = [
    { number: 'Q1', marks_allocated: 10 },
    ...['Q2', 'Q3', 'Q4'].map((number) => ({ number, marks_allocated: 5 })),
    ...['Q5', 'Q6'].map((number) => ({ number, marks_allocated: 10 })),
  ].map((question) => ({ ...question, expected_response_type: 'numerical' }));

  it('scores each section on its own', () => {
    const result = applyScoringPlan([
      { number: 'Q1', marks_obtained: 8, marks_total: 10, attempted: true },
      { number: 'Q2', marks_obtained: 2, marks_total: 5, attempted: true },
      { number: 'Q3', marks_obtained: 4, marks_total: 5, attempted: true },
      { number: 'Q4', marks_obtained: 5, marks_total: 5, attempted: true },
      { number: 'Q5', marks_obtained: 6, marks_total: 10, attempted: true },
      { number: 'Q6', marks_obtained: 0, marks_total: 10, attempted: false },
    ], plan);

    expect(counted(result)).toEqual(['Q1', 'Q3', 'Q4', 'Q5']);
    expect(result.score).toBe(23);
    expect(result.total).toBe(30);
    expect(normalizeScoringPlan(plan).groups.map((group) => [group.id, group.choose, group.at_least])).toEqual([['section_b', 2, []], ['section_c', 1, []]]);
  });

  it('totals and gates as before', () => {
    expect(effectiveTotal(questions, plan)).toBe(30);
    expect(checkRubricGate({ exam: { scoring_plan: plan }, quality: { declaredTotalMarks: 30 }, questions }).errors).toEqual([]);
  });
});
