import { describe, expect, it } from 'vitest';
import { mergeReviewCohorts, reviewCohortKey } from '../pages/VlReviewDashboard';

describe('review cohort grouping', () => {
  it('collapses per-student legacy test IDs into one visible cohort', () => {
    const first = { school: 'PartnerG', subject: 'Science', gradeLevel: '10th', testId: 'legacy_test_alice', isCanonicalTest: false };
    const second = { ...first, testId: 'legacy_test_bob' };

    expect(reviewCohortKey(first)).toBe(reviewCohortKey(second));
  });

  it('keeps distinct canonical tests separate even when their labels match', () => {
    const first = { school: 'Partner Academy C', subject: 'Accounts', gradeLevel: '12th', testId: 'test_one', isCanonicalTest: true };
    const second = { ...first, testId: 'test_two' };

    expect(reviewCohortKey(first)).not.toBe(reviewCohortKey(second));
  });

  it('merges historic summary rows before they become duplicate React keys', () => {
    const first = { id: 'legacy:Partner Academy B|Chemistry|11th', school: 'Partner Academy B', totalQuestions: 12, totalStudents: 1, pending: 10, approved: 2, flagged: 3, changedQuestions: 2, changedStudents: 1, recheckCount: 0 };
    const second = { ...first, totalQuestions: 15, pending: 11, approved: 4, flagged: 1, changedQuestions: 1, changedStudents: 1 };

    expect(mergeReviewCohorts([first, second])).toEqual([expect.objectContaining({
      id: first.id,
      totalQuestions: 27,
      totalStudents: 2,
      pending: 21,
      approved: 6,
      flagged: 4,
      changedQuestions: 3,
      changedStudents: 2,
      reviewPercent: 22,
    })]);
  });

  it('handles an empty cohort list', () => {
    expect(mergeReviewCohorts([])).toEqual([]);
    expect(mergeReviewCohorts(undefined)).toEqual([]);
  });

  it('handles a single cohort (single student)', () => {
    const single = { id: 'legacy:PartnerG|Science|10th', school: 'PartnerG', totalQuestions: 5, totalStudents: 1, pending: 2, approved: 3, flagged: 0, changedQuestions: 0, changedStudents: 0, recheckCount: 0 };
    expect(mergeReviewCohorts([single])).toEqual([expect.objectContaining({
      id: single.id,
      totalQuestions: 5,
      reviewPercent: 60,
    })]);
  });

  it('handles exact duplicate cohorts by aggregating them', () => {
    const dup = { id: 'duplicate', school: 'Test', totalQuestions: 10, totalStudents: 2, pending: 10, approved: 0, flagged: 0, changedQuestions: 0, changedStudents: 0, recheckCount: 0 };
    expect(mergeReviewCohorts([dup, dup])).toEqual([expect.objectContaining({
      id: 'duplicate',
      totalQuestions: 20,
      totalStudents: 4,
      pending: 20,
      reviewPercent: 0,
    })]);
  });
});
