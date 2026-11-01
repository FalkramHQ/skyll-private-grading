// Sub-answers are matched to sub-questions by content. On the PartnerD ICSE History
// & Civics semi-prelim (Oct 2026) Q8 and Q9 print their parts as (a), (c), (b);
// a student who labelled answers by position lost marks for a correct answer.
import { describe, expect, it } from 'vitest';
import { buildGradePrompt, partOrderPolicy } from '../../apps/processing-worker/gradeResult.js';

const q9 = 'Read the excerpt given below and answer the questions that follow:\n'
  + '(a) Name the march being discussed above. Which movement did this march lead to? In which year was that movement launched? [3]\n'
  + '(c) The movement which began with this march made a considerable impact. Analyse this statement by mentioning any three impacts. [3]\n'
  + '(b) Mention any four clauses of the Gandhi Irwin Pact. [4]';

describe('partOrderPolicy', () => {
  it('names the printed order when parts are out of order', () => {
    const policy = partOrderPolicy(q9);
    expect(policy).toMatch(/by its content, not only by its label/);
    expect(policy).toContain('out of order ((a), (c), (b))');
  });

  it('still asks for content matching when parts are in order', () => {
    const policy = partOrderPolicy('(a) What is X? [2] (b) Why does it happen? [2]');
    expect(policy).toMatch(/by its content/);
    expect(policy).not.toMatch(/out of order/);
  });

  it('adds nothing to a question without lettered parts, or with one', () => {
    expect(partOrderPolicy('What is global warming?')).toBe('');
    expect(partOrderPolicy('Choose the correct option (a) one (a) two')).toBe('');
  });
});

describe('the grade prompt', () => {
  it('carries the part-order guidance for written answers only', () => {
    const evidence = { attempted: true, student_answer: '(a) Dandi March, Civil Disobedience, 1930. (b) impacts ... (c) clauses ...' };
    const written = buildGradePrompt({ question: { question_text: q9 }, rubric: { expected_response_type: 'long_answer', marking_rubric: '' }, evidence, maxMarks: 10 });
    expect(written).toContain('out of order ((a), (c), (b))');
    const mcq = buildGradePrompt({ question: { question_text: q9 }, rubric: { expected_response_type: 'mcq', marking_rubric: '' }, evidence, maxMarks: 1 });
    expect(mcq).not.toContain('out of order');
  });

  it('leaves out the guidance for an MCQ block graded item by item', () => {
    const block = '1. Who led the march? (a) Nehru (b) Gandhi (c) Patel (d) Bose\n2. In which year? (a) 1920 (b) 1930 (c) 1942 (d) 1947';
    const evidence = { attempted: true, student_answer: '1. (b) 2. (b)' };
    const prompt = buildGradePrompt({ question: { question_text: block }, rubric: { expected_response_type: 'short_answer', source_response_type: 'mcq', marking_rubric: '1 mark for each correct option.' }, evidence, maxMarks: 2 });
    expect(prompt).not.toMatch(/by its content, not only by its label/);
  });
});
