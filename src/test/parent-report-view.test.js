// The parent view must read the payload the worker actually publishes
// (schema v2: term1.subjects, exams[], v2 learner DNA) as well as v1.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../api/_lib/auth.js', () => ({ database: () => null, ensureAuthTables: async () => {}, requireUser: async () => null }));
const { toParentView } = await import('../../server/parent/report.js');

describe('toParentView', () => {
  it('reads a schema v2 payload', () => {
    const view = toParentView({
      schema_version: 2,
      student: { name: 'Sneha Gupta', class: '9', school: 'Demo School' },
      exams: [{ id: 't1', name: 'Mid-term Maths', date: '2026-10-14' }],
      term1: { subjects: [{ name: 'Maths', score: 14, total: 20, strengths: ['Coordinates'], misconceptions: ['Stops after factorising'], recommendations: [{ topic: 'Polynomials', action: 'Set p(x) = 0 after factorising', priority: 'important' }] }] },
      learner_dna: { primary_mode: { mode_id: 'architect', description: 'Builds answers step by step' }, next_move: { title: 'Finish the method', action: 'Write the last step every time' } },
    });
    expect(view).toMatchObject({ studentName: 'Sneha Gupta', className: '9', examTitle: 'Mid-term Maths', examDate: '2026-10-14', overallScore: 14, overallMax: 20 });
    expect(view.subjects).toEqual([{ name: 'Maths', score: 14, maxMarks: 20, percentage: 70, grade: '', strengths: ['Coordinates'], improvements: ['Stops after factorising'], practice: [{ topic: 'Polynomials', action: 'Set p(x) = 0 after factorising' }] }]);
    expect(view.learnerDna).toEqual({ patterns: [], learningStyle: 'Builds answers step by step', nextMove: { title: 'Finish the method', action: 'Write the last step every time' } });
  });

  it('still reads a v1 payload', () => {
    const view = toParentView({ student_name: 'Arjun', subjects: [{ subject: 'Science', score: 30, max_marks: 40, percentage: 75 }], overall: { score: 30, max_marks: 40, grade: 'B' }, learner_dna: { patterns: ['Visual'] } });
    expect(view).toMatchObject({ studentName: 'Arjun', overallScore: 30, overallMax: 40, overallGrade: 'B' });
    expect(view.subjects[0]).toMatchObject({ name: 'Science', maxMarks: 40, percentage: 75 });
    expect(view.learnerDna.patterns).toEqual(['Visual']);
  });
});
