import { describe, expect, it } from 'vitest';
import { assessmentScore, subjectsForAssessment, withPercentage } from '../lib/teacherAssessment';

describe('teacherAssessment scoring', () => {
  const report = {
    term1: {
      subjects: [
        { name: 'Physics', score: 15, total: 20 },
        { name: 'English', score: 10, total: 20 },
      ],
    },
  };

  it('sums all subjects when scoped by test id', () => {
    expect(withPercentage(assessmentScore(report, { testId: 'test_1' }))).toEqual({
      score: 25,
      total: 40,
      pct: 63,
    });
  });

  it('filters by subject when no test id is provided', () => {
    expect(subjectsForAssessment(report, { subject: 'Physics' })).toHaveLength(1);
    expect(withPercentage(assessmentScore(report, { subject: 'Physics' }))).toEqual({
      score: 15,
      total: 20,
      pct: 75,
    });
  });
});
