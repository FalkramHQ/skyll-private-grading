// Mark ladders in a rubric are the marks one point can earn, not points to add.
// From the PartnerD ICSE History & Civics semi-prelim (Oct 2026), where the rungs
// were summed: a Q3 the grader totalled at 6/10 was stored as 10/10.
import { describe, expect, it } from 'vitest';
import { parseRubricCriteria } from '../../shared/harshZero.js';
import { auditConsistency, extractClaimedMarks, gradeWithSupervision } from '../../apps/processing-worker/gradeSupervisor.js';

const sum = (stubs) => stubs.reduce((acc, c) => acc + c.max, 0);
const Q3 = '(a) 3 marks for any three correct differences; 2 marks for two correct differences; 1 mark for one correct difference.\n'
  + '(b) 1 mark for Chairman/Vice President; 2 marks for correct composition (250 members, 238 states, 12 nominated).\n'
  + '(c) 4 marks for any four correct legislative powers; 3 marks for three; 2 marks for two; 1 mark for one.';

describe('parseRubricCriteria with mark ladders', () => {
  it('keeps only the top rung of each ladder, so the criteria add up to the question', () => {
    const stubs = parseRubricCriteria(Q3, 10);
    expect(sum(stubs)).toBe(10);
    expect(stubs.map((c) => c.max)).toEqual([3, 1, 2, 4]);
  });

  it('keeps a lower line that is a different point, and later parts that are worth less', () => {
    const q6 = '(a) 2 marks for correct meaning; 1 mark for Lord Wellesley.\n(b) 2 marks for correct meaning; 1 mark for reason of resentment.\n(c) 4 marks for any four correct changes; 3 marks for three; 2 marks for two; 1 mark for one.';
    expect(parseRubricCriteria(q6, 10).map((c) => c.max)).toEqual([2, 1, 2, 1, 4]);
    const q8 = '(a) 1 mark for Lord Curzon; 2 marks for any two reasons.\n(b) 4 marks for any four points of significance; 3 marks for three; 2 marks for two; 1 mark for one.\n(c) 3 marks for any three objectives; 2 marks for two; 1 mark for one.';
    expect(parseRubricCriteria(q8, 10).map((c) => c.max)).toEqual([1, 2, 4, 3]);
  });

  it('gives two parts that share a label their own ids', () => {
    const ids = parseRubricCriteria('(a) 2 marks for correct meaning; 1 mark for Lord Wellesley.\n(b) 2 marks for correct meaning.', 5).map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('reads quality ladders the same way', () => {
    expect(parseRubricCriteria('2 marks for any two correct benefits; 1 mark for only one correct benefit or vague wording.', 2).map((c) => c.max)).toEqual([2]);
    expect(sum(parseRubricCriteria('5 marks for a well-formatted formal letter; 4 marks for a good letter with minor format errors; 3 marks for a letter with major format errors; 2 marks for a letter lacking format; 1 mark for a very poor attempt.', 5))).toBe(5);
  });

  it('leaves rubrics that already add up alone', () => {
    expect(parseRubricCriteria('2 marks for definition; 1 mark for one example.', 3).map((c) => c.max)).toEqual([2, 1]);
    expect(parseRubricCriteria('1 mark for each correct option; 16 marks total.', 16).map((c) => c.max)).toEqual([16]);
  });
});

describe('the grader\'s stated total', () => {
  it('is the final figure, not the first number in a sum', () => {
    expect(extractClaimedMarks('Part (a): 2 marks. Total = 2 + 2 + 2 = 6 out of 10.', 10)).toBe(6);
    expect(extractClaimedMarks('Total = 2 + 2 + 2', 10)).toBe(6);
    expect(extractClaimedMarks('Total marks awarded: 4 out of 10')).toBe(4);
  });

  it('sends a mark above the stated total to the re-mark', () => {
    expect(auditConsistency({ marks: 10, reasoning: 'Total = 2 + 2 + 2 = 6 out of 10.' }, { max: 10 })).toEqual(['prose_mark_mismatch_down:6<10']);
  });

  it('re-marks such a grade and keeps a re-mark that agrees', async () => {
    const question = { question_text: Q3, marks_total: 10, expected_response_type: 'long_answer' };
    const rubric = { expected_response_type: 'long_answer', marking_rubric: Q3 };
    let calls = 0;
    const callJson = async () => {
      calls += 1;
      if (calls === 1) {
        return { value: { marks_awarded: 10, criteria: [{ id: 'any_three_correct_differences', max: 3, marks: 3 }, { id: 'chairman_vice_president', max: 1, marks: 1 }, { id: 'correct_composition_250_members_238_states_12_nominated', max: 2, marks: 2 }, { id: 'any_four_correct_legislative_powers', max: 4, marks: 4 }], grading_reasoning: 'Total = 2 + 2 + 2 = 6 out of 10.' } };
      }
      return { value: { marks_awarded: 6, criteria: [{ id: 'any_three_correct_differences', max: 3, marks: 2 }, { id: 'chairman_vice_president', max: 1, marks: 0 }, { id: 'correct_composition_250_members_238_states_12_nominated', max: 2, marks: 2 }, { id: 'any_four_correct_legislative_powers', max: 4, marks: 2 }], grading_reasoning: 'Total 6 out of 10.' } };
    };
    const result = await gradeWithSupervision({ question, rubric, evidence: { attempted: true, student_answer: 'x' }, callJson });
    expect(calls).toBe(2);
    expect(result.grade.marks).toBe(6);
    expect(result.supervisor.action).toBe('reconciled');
  });
});
