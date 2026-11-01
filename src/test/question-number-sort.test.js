import { describe, expect, it } from 'vitest';
import { compareQuestionNumbers, parseQuestionNumber, sortByQuestionNumber } from '../../shared/questionNumberSort.js';

describe('questionNumberSort', () => {
  it('orders PartnerD 10th SB English paper numbers correctly', () => {
    const shuffled = [
      'Q2.A5', 'Q1B(iii)', 'Q5B', 'Q2.A4(i)', 'Q1A(ii)', 'Q10', 'Q2.A1',
      'Q1A(i)', 'Q5A', 'Q2.A4(ii)', 'Q1B(i)', 'Q2.A2', 'Q1B(ii)', 'Q2.A3',
      'Q3.A2', 'Q4', 'Q3.A1', 'Q3.A3',
    ];
    expect(sortByQuestionNumber(shuffled)).toEqual([
      'Q1A(i)', 'Q1A(ii)', 'Q1B(i)', 'Q1B(ii)', 'Q1B(iii)',
      'Q2.A1', 'Q2.A2', 'Q2.A3', 'Q2.A4(i)', 'Q2.A4(ii)', 'Q2.A5',
      'Q3.A1', 'Q3.A2', 'Q3.A3',
      'Q4', 'Q5A', 'Q5B', 'Q10',
    ]);
  });

  it('parses letter + part + roman subsections', () => {
    expect(parseQuestionNumber('Q2.A4(i)')).toEqual({ q: 2, sec: 65, part: 4, sub: 1 });
    expect(parseQuestionNumber('Q1A(ii)')).toEqual({ q: 1, sec: 65, part: 0, sub: 2 });
    expect(parseQuestionNumber('Q5B')).toEqual({ q: 5, sec: 66, part: 0, sub: 0 });
  });

  it('compares objects by questionNumber field', () => {
    const items = [{ questionNumber: 'Q2.A5' }, { questionNumber: 'Q2.A1' }, { questionNumber: 'Q1B(i)' }];
    expect(items.sort(compareQuestionNumbers).map((i) => i.questionNumber)).toEqual(['Q1B(i)', 'Q2.A1', 'Q2.A5']);
  });
});
