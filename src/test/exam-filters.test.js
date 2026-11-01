import { describe, expect, it } from 'vitest';
import { buildExamEntries, filterAndSortExamEntries, readExamFilterState, writeExamFilterState } from '../lib/examFilters';

const exams = [
  { id: 'old', name: 'Autumn', date: '2025-10-01', academic_year: '2025-26', exam_type: 'term' },
  { id: 'new', name: 'Spring', date: '2026-03-01', academic_year: '2025-26', exam_type: 'final' },
];

describe('exam report filters', () => {
  it('normalizes published exam metadata onto subject entries', () => {
    const entries = buildExamEntries(exams, (id) => ({ subjects: [{ id: `${id}-math`, name: 'Mathematics', pct: id === 'new' ? 90 : 70 }] }), { class: '12th' });
    expect(entries[0]._exam).toMatchObject({ id: 'old', name: 'Autumn', academicYear: '2025-26', subject: 'Mathematics', grade: '12th' });
    expect(entries[0]._examName).toBe('Autumn');
    expect(entries[1]._examName).toBe('Spring');
  });

  it('combines multiple valid filter fields correctly', () => {
    const entries = buildExamEntries(exams, (id) => ({ subjects: [{ id, name: 'Mathematics', pct: id === 'new' ? 90 : 70 }] }), { class: '12th' });
    const result = filterAndSortExamEntries(entries, { subject: 'Mathematics', type: 'final', year: '2025-26' }, 'oldest');
    expect(result.map((entry) => entry._exam.id)).toEqual(['new']);
  });

  it('returns all entries when the filter is empty', () => {
    const entries = buildExamEntries(exams, (id) => ({ subjects: [{ id, name: 'Mathematics', pct: id === 'new' ? 90 : 70 }] }), { class: '12th' });
    const result = filterAndSortExamEntries(entries, {}, 'performance');
    expect(result.map((entry) => entry._exam.id)).toEqual(['new', 'old']);
  });

  it('ignores unknown or unsupported filter fields', () => {
    const entries = buildExamEntries(exams, (id) => ({ subjects: [{ id, name: 'Mathematics', pct: id === 'new' ? 90 : 70 }] }), { class: '12th' });
    // 'unknownField' should not affect the result
    const result = filterAndSortExamEntries(entries, { unknownField: 'does-not-exist' });
    expect(result.map((entry) => entry._exam.id)).toEqual(['new', 'old']);
  });

  it('round-trips URL state and ignores invalid sort values', () => {
    const state = readExamFilterState(new URLSearchParams('examYear=2025-26&examSort=invalid'));
    expect(state).toMatchObject({ year: '2025-26', sort: 'newest' });
    const params = writeExamFilterState(new URLSearchParams(), { ...state, subject: 'Mathematics' });
    expect(params.get('examSubject')).toBe('Mathematics');
  });
});
