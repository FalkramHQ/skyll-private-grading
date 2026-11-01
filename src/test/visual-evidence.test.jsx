import { describe, expect, it } from 'vitest';
import { formatEvidenceLocation } from '../pages/VlReviewDashboard';

describe('visual review evidence', () => {
  it('converts structured rescue provenance into reviewer-safe text', () => {
    expect(formatEvidenceLocation({
      student_page: 'page-4.jpg',
      student_answer: { i: 'line 17-i', ii: 'line 17-ii' },
    })).toBe('student page: page-4.jpg; student answer: i: line 17-i; ii: line 17-ii');
  });

  it('handles empty or missing student_answer safely by dropping them', () => {
    expect(formatEvidenceLocation({
      student_page: 'page-2.jpg',
      student_answer: null,
    })).toBe('student page: page-2.jpg');
    
    expect(formatEvidenceLocation({
      student_page: 'page-3.jpg',
      student_answer: {},
    })).toBe('student page: page-3.jpg');
  });

  it('handles string-based student_answer', () => {
    expect(formatEvidenceLocation({
      student_page: 'page-1.jpg',
      student_answer: 'top half',
    })).toBe('student page: page-1.jpg; student answer: top half');
  });

  it('handles missing student_page safely by dropping it', () => {
    expect(formatEvidenceLocation({
      student_answer: 'middle',
    })).toBe('student answer: middle');
  });
});
