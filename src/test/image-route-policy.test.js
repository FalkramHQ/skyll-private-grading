import { describe, expect, it } from 'vitest';
import { isCanonicalAnswerSheetRequest } from '../../api/_lib/imageRoutePolicy.js';
import { routeKind } from '../../api/images/[...route].js';

describe('image route policy', () => {
  it('keeps canonical test answer sheets off the legacy image route', () => {
    expect(isCanonicalAnswerSheetRequest({ testId: 'test_123' })).toBe(true);
    expect(isCanonicalAnswerSheetRequest({ testStudentId: 'test_student_456' })).toBe(true);
  });

  it('permits historic review records to use the legacy image route', () => {
    expect(isCanonicalAnswerSheetRequest({ studentId: 'legacy_student', page: '2' })).toBe(false);
  });

  it('resolves reference links when Vercel omits the catch-all query parameter', () => {
    expect(routeKind({ query: {}, url: '/api/images/reference?testId=test_123&kind=question_paper' })).toBe('reference');
  });

  it('uses Vercel catch-all parameters when they are available', () => {
    expect(routeKind({ query: { route: ['answer-sheet'] }, url: '/api/images/reference' })).toBe('answer-sheet');
  });
});
