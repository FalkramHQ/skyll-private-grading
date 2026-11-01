import { describe, expect, test } from 'vitest';
import { studentPaperStatus, incompleteStudentPapersSql } from '../paperCompleteness.js';

describe('student paper completeness', () => {
  test('legacy papers with no expected count still complete on the first uploaded page', () => {
    expect(studentPaperStatus({ uploadedCount: 1 })).toBe('uploaded');
    expect(studentPaperStatus({ uploadedCount: 0 })).toBe('expected');
  });

  test('declared page counts stay incomplete until every page has landed', () => {
    expect(studentPaperStatus({ expectedPageCount: 5, uploadedCount: 2 })).toBe('expected');
    expect(studentPaperStatus({ expectedPageCount: 5, uploadedCount: 5 })).toBe('uploaded');
    expect(studentPaperStatus({ expectedPageCount: 3, uploadedCount: 4 })).toBe('expected');
  });

  test('processing SQL requires expected and uploaded counts to match exactly', () => {
    expect(incompleteStudentPapersSql()).toMatch(/expected_page_count/);
    expect(incompleteStudentPapersSql()).toMatch(/!= ts\.expected_page_count/);
  });
});
