// A choice rule written by whole question ("any four of Q4–Q9") covers each
// question's parts. Shaped like PartnerD's ICSE Physics papers (22 Oct 2026), whose
// rubrics totalled 100 and 101 instead of the printed 80 because the rule named
// Q4–Q9 and the rubric stored Q4.1, Q4.2…
import { describe, expect, it } from 'vitest';
import { parentQuestionNumber, unitQuestionNumbers } from '../../shared/choiceUnits.js';
import { checkRubricGate, effectiveTotal, normalizeQuestionNumber } from '../../shared/rubricGate.js';
import { applyScoringPlan } from '../../apps/processing-worker/scoringPlan.js';

// Section A: Q1–Q3 compulsory, 40 marks. Section B: any four of Q4–Q9, each 10 marks in parts.
const questions = [
  { number: 'Q1.1', marks_allocated: 20 }, { number: 'Q2.1', marks_allocated: 10 }, { number: 'Q3', marks_allocated: 10 },
  ...[4, 5, 6, 7, 8, 9].flatMap((n) => [{ number: `Q${n}.1`, marks_allocated: 4 }, { number: `Q${n}.2`, marks_allocated: 3 }, { number: `Q${n}(iii)`, marks_allocated: 3 }]),
];
const plan = { groups: [{ id: 'section_b', choose: 4, units: [4, 5, 6, 7, 8, 9].map((n) => ({ id: `Q${n}`, question_numbers: [`Q${n}`] })), selection_policy: 'best_score' }] };

describe('choice units', () => {
  it('finds a part\'s whole question, and never confuses Q4 with Q41', () => {
    expect(['Q4.1', 'Q4(a)', '4a', 'Q4 (ii)', 'Q41', 'Q4'].map(parentQuestionNumber)).toEqual(['4', '4', '4', '4', null, null]);
    const numbers = ['Q4.1', 'Q4.2', 'Q41', 'Q40'];
    expect(unitQuestionNumbers('Q4', numbers, normalizeQuestionNumber)).toEqual(['Q4.1', 'Q4.2']);
    expect(unitQuestionNumbers('Q4', ['Q4', 'Q4.1'], normalizeQuestionNumber)).toEqual(['Q4']);
    expect(unitQuestionNumbers('Q4.1', numbers, normalizeQuestionNumber)).toEqual(['Q4.1']);
    expect(unitQuestionNumbers('Q12', numbers, normalizeQuestionNumber)).toEqual([]);
  });

  it('gives the gate the printed total and no unknown-question errors', () => {
    expect(effectiveTotal(questions, plan)).toBe(80);
    const { errors } = checkRubricGate({ exam: { total_marks: 80, scoring_plan: plan }, questions: questions.map((q) => ({ ...q, marking_rubric: `${q.marks_allocated} marks for the correct answer.`, expected_response_type: 'short_answer' })) });
    expect(errors.filter((e) => ['CHOICE_GROUP_UNKNOWN_QUESTION', 'TOTAL_MISMATCH'].includes(e.code))).toEqual([]);
  });

  it('still reports a choice rule naming a question that does not exist', () => {
    const bad = { groups: [{ id: 'b', choose: 1, units: [{ id: 'Q12', question_numbers: ['Q12'] }, { id: 'Q4', question_numbers: ['Q4'] }] }] };
    const { errors } = checkRubricGate({ exam: { scoring_plan: bad }, questions: questions.map((q) => ({ ...q, marking_rubric: `${q.marks_allocated} marks for it.` })) });
    expect(errors.filter((e) => e.code === 'CHOICE_GROUP_UNKNOWN_QUESTION').map((e) => e.message)).toEqual(['Choice group "b" names Q12, which is not a question in this rubric.']);
  });

  it('scores the best four whole questions, all parts together', () => {
    const marks = { 4: [4, 3, 3], 5: [0, 0, 1], 6: [4, 2, 0], 7: [3, 3, 3], 8: [1, 0, 0], 9: [4, 3, 2] };
    const scored = applyScoringPlan(questions.map((q) => {
      const parent = parentQuestionNumber(q.number);
      const part = marks[parent] ? marks[parent][q.number.endsWith('.1') ? 0 : q.number.endsWith('.2') ? 1 : 2] : q.marks_allocated;
      return { number: q.number, marks_total: q.marks_allocated, marks_obtained: part };
    }), plan);
    expect(scored.total).toBe(80);
    // Section A 40, plus Q4 (10), Q9 (9), Q7 (9), Q6 (6).
    expect(scored.score).toBe(40 + 10 + 9 + 9 + 6);
    expect(scored.questions.filter((q) => q.number.startsWith('Q5')).every((q) => !q.counts_toward_score)).toBe(true);
  });
});
