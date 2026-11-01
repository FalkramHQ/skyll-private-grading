import { describe, expect, it } from 'vitest';
import {
  buildTestItems,
  clusterBootstrapWithin1,
  formatReport,
  gateAgainstBaseline,
  gateAgainstBaselines,
  joinPaper,
  subjectOf,
  summarize,
} from '../../shared/gradingEval.js';

const rubric = {
  exam: { instructions: 'Answer all.', optional_rules: '' },
  questions: [
    { number: 'Q1', question_text: 'Define molarity.', correct_answer_summary: 'moles per litre', marking_rubric: '1 mark', marks_allocated: 1, expected_response_type: 'short_answer' },
    { number: 'Q2', question_text: 'Calculate pH.', correct_answer_summary: '3', marking_rubric: '2 marks', marks_allocated: 2, expected_response_type: 'numerical' },
    { number: 'Q3', question_text: 'Explain.', correct_answer_summary: 'x', marking_rubric: '3 marks', marks_allocated: 3, expected_response_type: 'long_answer' },
    { number: 'Q4', question_text: 'Write.', correct_answer_summary: 'y', marking_rubric: '4 marks', marks_allocated: 4, expected_response_type: 'essay' },
  ],
};
const pipeline = {
  student1: {
    name: 'not used',
    score: 6,
    questions: [
      { q: 'Q1', max: 1, ai: 1, answer: 'moles per litre' },
      { q: 'Q2', max: 2, ai: 2, answer: 'pH = 3', lowConf: true },
      { q: 'Q3', max: 3, ai: 2, answer: 'some text' },
      { q: 'Q4', max: 4, ai: 1, answer: 'essay' },
    ],
  },
};
const grades = {
  student1: {
    questions: [
      { paper_q: '1', pipeline_q: ['q1'], max: 1, awarded: 1 },
      { paper_q: '2', pipeline_q: ['Q2'], max: 2, awarded: 0 },
      { paper_q: '3', pipeline_q: ['Q3'], max: 3, awarded: 1.5 },
      { paper_q: '4a', pipeline_q: ['Q4'], max: 2, awarded: 1 },
      { paper_q: '4b', pipeline_q: ['Q4'], max: 2, awarded: 1 },
    ],
  },
};
const adjudications = [{ student: 'student1', paper_q: '2', correct_mark: 0, cause: 'KEY_ERROR', stage: 'rubric' }];

describe('subjectOf', () => {
  it('maps review slugs to subjects and honours overrides', () => {
    expect(subjectOf('chem_partnerb11')).toBe('Chemistry');
    expect(subjectOf('eng_cbse9')).toBe('English');
    expect(subjectOf('maths_ach_aj', { maths_ach_aj: 'Physics' })).toBe('Physics');
  });
});

describe('joinPaper', () => {
  it('normalises labels and marks pipeline questions claimed twice as shared', () => {
    const rows = joinPaper(grades.student1, pipeline.student1);
    expect(rows[0]).toMatchObject({ paperQ: '1', pipelineQ: ['Q1'], pipeline: 1, independent: 1, sharedUnit: false });
    expect(rows[3]).toMatchObject({ pipelineQ: ['Q4'], pipeline: 0.5, sharedUnit: true });
  });
});

describe('buildTestItems', () => {
  const { items, skipped } = buildTestItems({ test: 'r1/chem_x', subject: 'Chemistry', rubric, pipeline, grades, adjudications });

  it('keeps agreed and adjudicated questions with their ground truth', () => {
    expect(items.map((it) => [it.question.question_number, it.gt, it.gtSource])).toEqual([
      ['Q1', 1, 'agreed'],
      ['Q2', 0, 'adjudicated'],
    ]);
    expect(items[1]).toMatchObject({ adjCause: 'KEY_ERROR', pipelineStored: 2, evidence: { extraction_confidence: 'low' } });
  });

  it('leaves out unresolved and shared questions and counts why', () => {
    expect(skipped).toEqual({ under_one_mark_apart: 1, shared_unit: 2 });
  });

  it('grades against a rebuilt rubric matched by folded number, skipping changed questions', () => {
    const rubricOverride = {
      exam: { instructions: 'Rebuilt.' },
      questions: [
        { number: '1', question_text: 'Define molarity.', correct_answer_summary: 'mol/L', marking_rubric: '1 mark for mol/L', marks_allocated: 1, expected_response_type: 'short_answer', mark_step: 0.5 },
        { number: 'Q2', question_text: 'Calculate pH.', correct_answer_summary: '3', marking_rubric: '3 marks', marks_allocated: 3, expected_response_type: 'numerical' },
      ],
    };
    const rebuilt = buildTestItems({ test: 'r1/chem_x', subject: 'Chemistry', rubric, pipeline, grades, adjudications, rubricOverride });
    expect(rebuilt.items.map((it) => [it.question.question_number, it.question.answer_key_text, it.question.mark_step])).toEqual([['Q1', 'mol/L', 0.5]]);
    expect(rebuilt.skipped).toMatchObject({ rebuilt_marks_changed: 1 });
  });

  it('carries no student names', () => {
    expect(JSON.stringify(items)).not.toContain('not used');
  });
});

const item = (id, test, subject, gt, extra = {}) => ({ id, test, subject, gt, gtSource: 'agreed', pipelineStored: gt, ...extra });

describe('summarize', () => {
  const items = [
    item('a', 't1', 'Chemistry', 2),
    item('b', 't1', 'Chemistry', 1, { gtSource: 'adjudicated', adjCause: 'GRADER_LENIENT', pipelineStored: 3 }),
    item('c', 't2', 'Physics', 0),
    item('d', 't2', 'Physics', 4),
  ];

  it('reports exact, within-one, signed error, per subject and per cause', () => {
    const s = summarize(items, { a: 2, b: 2.5, c: 0.5, d: 4 });
    expect(s.exact).toBe(0.5);
    expect(s.within1).toBe(0.75);
    expect(s.meanSigned).toBeCloseTo(0.5);
    expect(s.exactAdjudicated).toEqual({ n: 1, rate: 0 });
    expect(s.bySubject.Chemistry).toMatchObject({ n: 2, exact: 0.5, within1: 0.5 });
    expect(s.bySubject.Physics).toMatchObject({ n: 2, within1: 1 });
    expect(s.marksMovedByCause.GRADER_LENIENT).toEqual({ n: 1, stored: 2, run: 1.5 });
  });

  it('scores only items that have a mark', () => {
    const s = summarize(items, new Map([['a', 2]]));
    expect(s.coverage).toEqual({ scored: 1, items: 4 });
  });
});

describe('clusterBootstrapWithin1', () => {
  it('is reproducible and brackets the point estimate', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ test: `t${i % 8}`, err: i % 5 === 0 ? 2 : 0 }));
    const a = clusterBootstrapWithin1(rows, { reps: 500 });
    expect(a).toEqual(clusterBootstrapWithin1(rows, { reps: 500 }));
    expect(a.lo).toBeLessThanOrEqual(0.8);
    expect(a.hi).toBeGreaterThanOrEqual(0.8);
  });

  it('needs at least two tests', () => {
    expect(clusterBootstrapWithin1([{ test: 't', err: 0 }])).toBeNull();
  });
});

describe('gateAgainstBaseline', () => {
  const base = { bySubject: { Chemistry: { n: 100, within1: 0.9 }, Physics: { n: 100, within1: 0.95 } } };

  it('fails a subject that drops more than the allowed points', () => {
    const cand = { bySubject: { Chemistry: { n: 100, within1: 0.875 }, Physics: { n: 100, within1: 0.96 } } };
    expect(gateAgainstBaseline(base, cand)).toEqual({ pass: false, failures: [{ subject: 'Chemistry', baseline: 0.9, candidate: 0.875, dropPoints: 2.5 }], ungated: [] });
  });

  it('reports small subjects as ungated instead of failing them', () => {
    const small = { bySubject: { History: { n: 7, within1: 0.7 } } };
    expect(gateAgainstBaseline(small, { bySubject: { History: { n: 7, within1: 0.4 } } })).toEqual({ pass: true, failures: [], ungated: ['History'] });
  });

  it('passes drops within the allowance, which defaults to 2 points', () => {
    const cand = { bySubject: { Chemistry: { n: 100, within1: 0.885 }, Physics: { n: 100, within1: 0.95 } } };
    expect(gateAgainstBaseline(base, cand).pass).toBe(true);
    expect(gateAgainstBaseline(base, cand, { maxDropPoints: 1 }).pass).toBe(false);
  });
});

describe('gateAgainstBaselines', () => {
  // Two runs of the same code: English moved 2.2 points between them.
  const baseA = { bySubject: { English: { n: 400, within1: 0.858 }, Chemistry: { n: 500, within1: 0.821 } } };
  const baseB = { bySubject: { English: { n: 400, within1: 0.836 }, Chemistry: { n: 500, within1: 0.822 } } };

  it('fails a subject only when it drops more than the limit below every baseline', () => {
    const cand = { bySubject: { English: { n: 400, within1: 0.83 }, Chemistry: { n: 500, within1: 0.79 } } };
    expect(gateAgainstBaseline(baseA, cand).failures.map((f) => f.subject)).toEqual(['English', 'Chemistry']);
    const gate = gateAgainstBaselines([baseA, baseB], cand);
    expect(gate.pass).toBe(false);
    // English is within 2 points of the lower baseline; Chemistry is not, reported against the lower one.
    expect(gate.failures).toEqual([{ subject: 'Chemistry', baseline: 0.821, candidate: 0.79, dropPoints: 3.1 }]);
  });

  it('behaves like the single-baseline gate with one baseline', () => {
    const cand = { bySubject: { English: { n: 400, within1: 0.83 }, Chemistry: { n: 500, within1: 0.82 } } };
    expect(gateAgainstBaselines([baseA], cand)).toEqual(gateAgainstBaseline(baseA, cand));
  });
});

describe('formatReport', () => {
  it('renders a table beside the baseline', () => {
    const items = [item('a', 't1', 'Chemistry', 1), item('b', 't2', 'Chemistry', 2)];
    const text = formatReport(summarize(items, { a: 1, b: 2 }), { label: 'cand', baseline: summarize(items, { a: 0, b: 2 }), baselineLabel: 'stored' });
    expect(text).toContain('| Measure | stored | cand |');
    expect(text).toContain('| Chemistry | 2 | 50.0% | 100.0%');
    expect(text).toContain('| +50.0 |');
  });
});
