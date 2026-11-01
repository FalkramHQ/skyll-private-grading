import { describe, expect, it } from 'vitest';
import { asReviewItem } from '../../api/vl-queue.js';

describe('review answer-sheet linkage', () => {
  it('uses the test-specific student ID for intake asset pages', () => {
    const item = asReviewItem(
      {
        id: 'question_1', school: 'Partner Academy A\'s Academy', subject: 'Mathematics',
        student_id: 'roster_aditya', test_student_id: 'test_student_aditya',
        student_name: 'Aditya Rao', question_number: 'Q1', test_id: 'test_1',
        submission_score: 17, submission_max_marks: 25,
      },
      { question: { question_text: 'Question', marks_obtained: 1, marks_total: 1, status: 'correct' } },
      new Map([['test_1', '12th']]), new Set(['test_1']),
      new Map([['test_1:test_student_aditya', 5]]), new Map(), new Map(), new Map(),
    );

    expect(item.studentId).toBe('roster_aditya');
    expect(item.testStudentId).toBe('test_student_aditya');
    expect(item.pageCount).toBe(5);
    expect(item.submissionScore).toBe(17);
    expect(item.submissionMaxMarks).toBe(25);
  });
});
