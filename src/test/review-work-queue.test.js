import { describe, expect, it } from 'vitest';
import { initialReviewTarget, parseReviewLocation, reviewItemMatchesFilter, reviewLocation } from '../../shared/reviewWorkQueue';

const item = { studentId: 'student_1', questionNumber: 'Q4', reviewStatus: 'approved', isFlagged: true, needsRegrade: true, reviewRevision: 2, regradedRevision: 1, grade: { confidence: 'low' } };

describe('review work queue contracts', () => {
  it('recognises every priority lane without conflating published and pending work', () => {
    expect(reviewItemMatchesFilter(item, 'flagged')).toBe(true);
    expect(reviewItemMatchesFilter(item, 'edited-awaiting-regrade')).toBe(true);
    expect(reviewItemMatchesFilter(item, 'low-confidence')).toBe(true);
    expect(reviewItemMatchesFilter(item, 'complete')).toBe(false);
    expect(reviewItemMatchesFilter(item, 'rechecks', [{ review_student_id: 'student_1', question_number: '4', status: 'open' }])).toBe(true);
    expect(reviewItemMatchesFilter({ ...item, isHarshZero: true }, 'harsh-zeros')).toBe(true);
    expect(reviewItemMatchesFilter({ ...item, reviewTags: ['harsh_zero'] }, 'harsh-zeros')).toBe(true);
    expect(reviewItemMatchesFilter(item, 'harsh-zeros')).toBe(false);
  });

  it.each(['open', 'in_review', 'awaiting_regrade'])(
    'keeps %s requests in the reviewer recheck lane',
    (status) => {
      expect(reviewItemMatchesFilter(item, 'rechecks', [{
        review_student_id: 'student_1',
        question_number: 'Q4',
        status,
      }])).toBe(true);
    },
  );

  it('separates active student, teacher, and awaiting-regrade requests', () => {
    const studentRequest = { review_student_id: 'student_1', question_number: '4', status: 'open', requestedByRole: 'student' };
    const teacherRequest = { review_student_id: 'student_1', question_number: '4', status: 'in_review', requestedByRole: 'admin' };
    const awaitingRequest = { review_student_id: 'student_1', question_number: '4', status: 'awaiting_regrade', requestedByRole: 'student' };

    expect(reviewItemMatchesFilter(item, 'student-rechecks', [studentRequest])).toBe(true);
    expect(reviewItemMatchesFilter(item, 'teacher-rechecks', [studentRequest])).toBe(false);
    expect(reviewItemMatchesFilter(item, 'teacher-rechecks', [teacherRequest])).toBe(true);
    expect(reviewItemMatchesFilter(item, 'awaiting-regrade', [teacherRequest])).toBe(false);
    expect(reviewItemMatchesFilter(item, 'awaiting-regrade', [awaitingRequest])).toBe(true);
  });

  it.each(['resolved', 'declined', 'cancelled'])(
    'removes terminal %s requests from the active reviewer lane',
    (status) => {
      expect(reviewItemMatchesFilter(item, 'rechecks', [{
        review_student_id: 'student_1',
        question_number: 'Q4',
        status,
      }])).toBe(false);
    },
  );

  it('round-trips a shareable reviewer location and rejects unsupported filters', () => {
    const query = reviewLocation({ cohort: 'test:abc', student: 'student_1', question: 'Q4', filter: 'student-rechecks', search: 'equilibrium' });
    expect(parseReviewLocation(`?${query}`)).toEqual({ cohort: 'test:abc', student: 'student_1', question: 'Q4', filter: 'student-rechecks', search: 'equilibrium' });
    expect(parseReviewLocation('?filter=untrusted').filter).toBe('pending');
  });

  it('resolves a shared review location once without making later navigation depend on it', () => {
    const items = [
      { ...item, id: 'q3', questionNumber: 'Q3' },
      { ...item, id: 'q4', questionNumber: 'Q4' },
      { ...item, id: 'q5', questionNumber: 'Q5' },
    ];
    expect(initialReviewTarget(items, { student: 'student_1', question: 'Q4' }, 'all')).toEqual({
      studentId: 'student_1', index: 1,
    });
  });

  it('correctly classifies completed items and excludes them from action-required lanes', () => {
    const completeItem = { studentId: 'student_1', questionNumber: 'Q1', reviewStatus: 'approved', isFlagged: false, needsRegrade: false, reviewRevision: 1, regradedRevision: 1, grade: { confidence: 'high' } };
    expect(reviewItemMatchesFilter(completeItem, 'complete')).toBe(true);
    expect(reviewItemMatchesFilter(completeItem, 'flagged')).toBe(false);
    expect(reviewItemMatchesFilter(completeItem, 'low-confidence')).toBe(false);
  });

  it('returns appropriate empty target when review items array is empty or zero items match filter', () => {
    expect(initialReviewTarget([], { student: 'student_1', question: 'Q1' }, 'all')).toEqual({
      studentId: null, index: 0,
    });
  });
});

