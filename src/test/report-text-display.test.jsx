import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import MathText from '../components/MathText';
import { formatLongDate } from '../lib/formatDate';
import { toStudentFacingText } from '../lib/studentFacingText';
import { falseFullCreditClaims, guardSubjectClaims, marksByQuestion, scoreDimensionsFromMarks } from '../../shared/reportClaims.js';
import { initialModulesFallback } from '../../apps/processing-worker/workerUtils.js';

// Demo Student Four's paper after review (fictional demo school).
const QUESTIONS = [
  { number: 'Q1', topic: 'Quadratic equations', marks_obtained: 1, marks_total: 2 },
  { number: 'Q2', topic: 'Arithmetic progressions', marks_obtained: 3, marks_total: 3 },
  { number: 'Q3', topic: 'Coordinate geometry', marks_obtained: 1, marks_total: 3 },
  { number: 'Q4', topic: 'Arithmetic progressions', marks_obtained: 1, marks_total: 4 },
  { number: 'Q5', topic: 'Quadratic equations', marks_obtained: 1, marks_total: 4 },
  { number: 'Q6', topic: 'Heights and distances', marks_obtained: 1, marks_total: 5 },
  { number: 'Q7', topic: 'Trigonometry', marks_obtained: 2, marks_total: 4 },
  { number: 'Q8', topic: 'Probability', marks_obtained: 2, marks_total: 5 },
];

describe('student-facing feedback wording', () => {
  it('turns "the student" into "you" without leaving "the You"', () => {
    expect(toStudentFacingText('The final mark for x = -2 is not earned because the student incorrectly gives x = 2 instead of x = -2.'))
      .toBe('The final mark for x = -2 is not earned because you incorrectly give x = 2 instead of x = -2.');
    expect(toStudentFacingText('The student did not use the formula.')).toBe('You did not use the formula.');
    expect(toStudentFacingText("The student's working is clear.")).toBe('Your working is clear.');
    expect(toStudentFacingText('The student answer reaches 570.')).toBe('Your answer reaches 570.');
    expect(toStudentFacingText('Student wrote the roots only.')).toBe('You wrote the roots only.');
  });

  it('keeps sentences whole instead of cutting a mark split out of the middle', () => {
    const text = 'The student earned 1 mark for correctly stating a = 3 and d = 5. No marks were awarded for the sum formula because the student did not use the formula.';
    const shown = toStudentFacingText(text);
    expect(shown).toBe('You earned 1 mark for correctly stating a = 3 and d = 5. No marks were awarded for the sum formula because you did not use the formula.');
    expect(shown).not.toMatch(/You earned No/);
  });

  it('drops sentences that are only rubric bookkeeping', () => {
    expect(toStudentFacingText('Award 1 mark for the formula. The method is right.')).toBe('The method is right.');
    expect(toStudentFacingText('Mark split: 1 + 1. The roots have the wrong signs.')).toBe('The roots have the wrong signs.');
  });
});

describe('report dates', () => {
  it('shows a stored timestamp as a date, never the raw string', () => {
    expect(formatLongDate('2026-10-25T11:32:14.881Z')).toBe('25 October 2026');
    expect(formatLongDate('2026-10-25')).toBe('25 October 2026');
    expect(formatLongDate('not a date')).toBe('');
    expect(formatLongDate('')).toBe('');
  });
});

describe('maths environments in answers', () => {
  afterEach(cleanup);

  it('renders a bare \\begin{aligned} block as one formula', () => {
    const { container } = render(
      <MathText block stripJargon={false} text={'\\begin{aligned} AB &= \\sqrt{(-4+2)^2 + (11+3)^2} \\\\ &= \\sqrt{200} \\end{aligned}'} />,
    );
    // One formula, and no raw LaTeX in what is shown (KaTeX keeps the source
    // only in its hidden annotation).
    expect(container.querySelectorAll('.katex')).toHaveLength(1);
    const visible = [...container.querySelectorAll('.katex-html')].map((el) => el.textContent).join(' ');
    expect(visible).toMatch(/AB/);
    expect(visible).not.toMatch(/\\begin|\\end|&=/);
  });
});

describe('report summary claims', () => {
  const marks = marksByQuestion(QUESTIONS);

  it('finds a full-credit claim on a question that lost marks', () => {
    expect(falseFullCreditClaims('Accurate execution, as shown by full credit in Q2 and Q5.', marks)).toEqual(['Q5']);
    expect(falseFullCreditClaims('Full marks on Q2 show the AP formula is secure.', marks)).toEqual([]);
    expect(falseFullCreditClaims('Partial credit in Q1 and Q3.', marks)).toEqual([]);
  });

  it('replaces a false claim with the marks-based summary and keeps true ones', () => {
    const fallback = initialModulesFallback(QUESTIONS).subject;
    const subject = {
      overall_insights: 'Q2 was answered correctly.',
      strengths: ['Arithmetic progressions'],
      learning_profile: {
        core_strength: 'Accurate execution, as shown by full credit in Q2 and Q5.',
        pattern_recognition: 'Partial credit in Q1, Q3, Q7 and Q8.',
      },
    };
    const guarded = guardSubjectClaims(subject, fallback, marks);
    expect(guarded.learning_profile.core_strength).toBe(fallback.learning_profile.core_strength);
    expect(guarded.learning_profile.core_strength).not.toMatch(/Q5/);
    expect(guarded.learning_profile.pattern_recognition).toBe(subject.learning_profile.pattern_recognition);
    expect(guarded.overall_insights).toBe('Q2 was answered correctly.');
  });
});

describe('Learner DNA scores', () => {
  it('scores each dimension 0-100 from the marks it cites, not the model', () => {
    const marks = marksByQuestion(QUESTIONS);
    const dims = scoreDimensionsFromMarks([
      { id: 'maker', state: 'secure', score: 4, evidence_question_ids: ['Q2', 'Q5'] },
      { id: 'pathfinder', state: 'needs_practice', score: 1, evidence_question_ids: ['Q4', 'Q8'] },
      { id: 'architect', state: 'developing', score: 3, evidence_question_ids: [] },
    ], marks);
    expect(dims[0]).toMatchObject({ score: 57, state: 'developing' });
    expect(dims[1]).toMatchObject({ score: 33, state: 'needs_practice' });
    expect(dims[2]).toMatchObject({ score: null, state: 'not_observed' });
  });
});
