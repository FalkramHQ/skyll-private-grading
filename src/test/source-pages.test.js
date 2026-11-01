import { describe, expect, it } from 'vitest';
import { withSourcePages } from '../../apps/processing-worker/sourcePages.js';

const answer = (number, studentAnswer, extra = {}) => ({
  question: { number },
  attempted: Boolean(studentAnswer),
  studentAnswer,
  sourcePages: [0],
  ...extra,
});

describe('withSourcePages', () => {
  const pages = [
    'Q.No. 1 i) c> centigrade ii) d> Distance',
    '2 i) The atomic mass unit is mole',
    '3 i) Compound microscope is used to observe tiny objects',
  ];

  it('replaces the model page with the 1-based page where the answer text was found', () => {
    const [q1, q2, q3] = withSourcePages([
      answer('Q1ii', 'd> Distance'),
      answer('Q2i', 'The atomic mass unit is mole'),
      answer('Q3i', 'Compound microscope is used to observe'),
    ], pages);
    expect(q1.sourcePages).toEqual([1]);
    expect(q2.sourcePages).toEqual([2]);
    expect(q3.sourcePages).toEqual([3]);
  });

  it('stores nothing for blank, unmatched or not-attempted answers, never a neighbour guess', () => {
    const [blank, unmatched, leftover] = withSourcePages([
      answer('Q1i', ''),
      answer('Q1v', 'handwriting the OCR never captured'),
      answer('Q2ii', 'The atomic mass unit is mole', { attempted: false }),
    ], pages);
    expect(blank.sourcePages).toEqual([]);
    expect(unmatched.sourcePages).toEqual([]);
    expect(leftover.sourcePages).toEqual([]);
  });

  it('keeps every other answer field untouched', () => {
    const input = answer('Q1ii', 'd> Distance', { confidence: 'high', needsVisualRescue: true });
    expect(withSourcePages([input], pages)[0]).toEqual({ ...input, sourcePages: [1] });
  });

  it('clears pages when the sheet has no OCR at all', () => {
    expect(withSourcePages([answer('Q1ii', 'd> Distance')], [])[0].sourcePages).toEqual([]);
  });
});
