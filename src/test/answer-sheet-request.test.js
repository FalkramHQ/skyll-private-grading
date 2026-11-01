import { describe, expect, it } from 'vitest';
import { answerSheetUrl, reviewAnswerSheetUrl } from '../lib/answerSheetRequest';

describe('answer sheet request URL', () => {
  it('includes the selected student for a teacher view', () => {
    expect(answerSheetUrl({ subject: 'Chemistry', page: 2, studentUsername: 'partnerb_abcd12' }))
      .toBe('/api/student-answer-sheet?subject=Chemistry&page=2&student=partnerb_abcd12');
  });

  it('does not add an empty student parameter for a student viewing their own work', () => {
    expect(answerSheetUrl({ subject: 'Chemistry' }))
      .toBe('/api/student-answer-sheet?subject=Chemistry');
  });

  it('keeps the selected assessment when a learner has reports for more than one test', () => {
    expect(answerSheetUrl({ subject: 'Mathematics', studentUsername: 'achieve01', testId: 'test_123' }))
      .toBe('/api/student-answer-sheet?subject=Mathematics&student=achieve01&testId=test_123');
  });

  it('uses the shared answer-sheet endpoint for canonical review pages', () => {
    expect(reviewAnswerSheetUrl({ testId: 'test_123', testStudentId: 'test_student_456', subject: 'Accounts', page: 2 }))
      .toBe('/api/student-answer-sheet?testId=test_123&testStudentId=test_student_456&subject=Accounts&page=2');
  });
});

import { findIntakeAnswerSheetAsset, indexIntakeAnswerSheetAssets, pageNumberFromStorageKey } from '../../api/_lib/answerSheetAssets';

describe('intake answer-sheet assets', () => {
  it('reads the page number emitted by the intake uploader', () => {
    expect(pageNumberFromStorageKey('Student-page-1784711779028-2.jpg')).toBe(2);
  });

  it('numbers pages by scan batch, then page number, not upload order (pages upload in parallel; old apps restarted the counter)', () => {
    const indexed = indexIntakeAnswerSheetAssets([
      { id: 'page-2', storage_key: 'Student-page-100-2.jpg' },
      { id: 'old-page-1', storage_key: 'Student-page-90-1.jpg' },
      { id: 'new-page-1', storage_key: 'Student-page-110-1.jpg' },
      { id: 'batch-100-page-1', storage_key: 'Student-page-100-1.jpg' },
    ]);
    expect(indexed.map((asset) => [asset.page, asset.id])).toEqual([
      [1, 'old-page-1'],
      [2, 'batch-100-page-1'],
      [3, 'page-2'],
      [4, 'new-page-1'],
    ]);
  });

  it('resolves a numbered page from the canonical intake asset list', () => {
    const asset = findIntakeAnswerSheetAsset([
      { id: 'page-1', storage_key: 'Student-page-100-1.jpg' },
      { id: 'page-2', storage_key: 'Student-page-101-2.jpg' },
    ], 2);
    expect(asset?.id).toBe('page-2');
  });

  it('falls back to scan order only for legacy assets without page suffixes', () => {
    const asset = findIntakeAnswerSheetAsset([
      { id: 'legacy-1', storage_key: 'legacy-one.jpg' },
      { id: 'legacy-2', storage_key: 'legacy-two.jpg' },
    ], 2);
    expect(asset?.id).toBe('legacy-2');
  });
});
