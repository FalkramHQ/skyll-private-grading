// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { topicGapsFromRows } from '../../api/teacher-dashboard.js';

// The demo maths test after review (fictional demo school): one row per
// student answer, with the question's rubric topic and marks.
const rows = [
  ['Q1', 'Quadratic Equations', 2, [2, 2, 2, 1, 1]],
  ['Q5', 'Quadratic Equations', 4, [4, 3, 1, 1, 0]],
  ['Q6', 'Some Applications of Trigonometry', 5, [4, 1, 3, 1, 1]],
  ['Q8', 'Probability', 5, [5, 4, 2, 2, 3]],
  ['Q9', '', 2, [1]],
].flatMap(([question_number, topic, max_marks, marks]) => marks.map((mark) => ({ question_number, topic, max_marks, marks: mark })));

describe('teacher dashboard topic gaps', () => {
  it('averages the reviewed marks per topic, weakest first', () => {
    const gaps = topicGapsFromRows(rows);
    expect(gaps.map((gap) => [gap.title, gap.avg])).toEqual([
      ['Some Applications of Trigonometry', 40],
      ['Quadratic Equations', 57],
      ['Probability', 64],
    ]);
    expect(gaps[1].description).toBe('Questions Q1, Q5.');
  });

  it('skips questions with no topic and returns nothing for no rows', () => {
    expect(topicGapsFromRows(rows).some((gap) => !gap.title)).toBe(false);
    expect(topicGapsFromRows([])).toEqual([]);
  });

  it('labels a stored "Q4" once, never "QQ4"', () => {
    const gaps = topicGapsFromRows([{ question_number: 'Q4', topic: 'AP', max_marks: 4, marks: 1 }]);
    expect(gaps[0].description).toBe('Questions Q4.');
  });
});
