import { describe, expect, it } from 'vitest';
import {
  cohortFilterLocation,
  cohortMatchesFilters,
  cohortOverrideHasUnresolved,
  cohortStatusLabels,
  cohortWithinDateFilter,
  compareCohortsByExamDate,
  parseCohortFilters,
} from '../../shared/reviewWorkQueue.js';

describe('cohort status labels', () => {
  it('derives non-exclusive labels from pending and changed counts', () => {
    expect(cohortStatusLabels({ pending: 5, changedQuestions: 0 })).toEqual(['needs-review']);
    expect(cohortStatusLabels({ pending: 0, changedQuestions: 3 })).toEqual(['regrade-pending']);
    expect(cohortStatusLabels({ pending: 5, changedQuestions: 3 })).toEqual(['needs-review', 'regrade-pending']);
    expect(cohortStatusLabels({ pending: 0, changedQuestions: 0 })).toEqual(['completed']);
  });

  it('reports completed when a reviewer marked the cohort done despite pending work', () => {
    const marked = { pending: 5, changedQuestions: 2, completionOverride: { markedBy: 't' } };
    expect(cohortStatusLabels(marked)).toEqual(['completed']);
    expect(cohortStatusLabels({ ...marked, completionOverride: null })).toEqual(['needs-review', 'regrade-pending']);
  });
});

describe('cohort override resolution', () => {
  it('flags an override only when unresolved work is being overridden', () => {
    expect(cohortOverrideHasUnresolved({ pending: 4, completionOverride: { markedBy: 't' } })).toBe(true);
    expect(cohortOverrideHasUnresolved({ changedQuestions: 1, completionOverride: { markedBy: 't' } })).toBe(true);
    expect(cohortOverrideHasUnresolved({ pending: 0, changedQuestions: 0, completionOverride: { markedBy: 't' } })).toBe(false);
    expect(cohortOverrideHasUnresolved({ pending: 4 })).toBe(false);
  });

  it('routes a marked cohort into the completed filter and hides it from needs-review', () => {
    const cohort = { school: 'Partner Academy B', pending: 4, completionOverride: { markedBy: 't' } };
    expect(cohortMatchesFilters(cohort, { status: 'completed' })).toBe(true);
    expect(cohortMatchesFilters(cohort, { status: 'needs-review' })).toBe(false);
  });
});

describe('cohort filter matching', () => {
  const cohort = { school: 'Partner Academy B', grade: '11th', subject: 'Chemistry', pending: 4, changedQuestions: 0 };

  it('matches on facets and status', () => {
    expect(cohortMatchesFilters(cohort, {})).toBe(true);
    expect(cohortMatchesFilters(cohort, { school: 'Partner Academy B', grade: '11th' })).toBe(true);
    expect(cohortMatchesFilters(cohort, { grade: '12th' })).toBe(false);
    expect(cohortMatchesFilters(cohort, { status: 'needs-review' })).toBe(true);
    expect(cohortMatchesFilters(cohort, { status: 'completed' })).toBe(false);
    expect(cohortMatchesFilters(cohort, { status: 'all' })).toBe(true);
  });
});

describe('cohort filter URL round-trip', () => {
  it('serializes only non-default selections and parses them back', () => {
    expect(cohortFilterLocation({})).toBe('');
    expect(cohortFilterLocation({ status: 'all', showCompleted: false })).toBe('');
    const query = cohortFilterLocation({ school: 'Partner Academy B', grade: '11th', status: 'regrade-pending', showCompleted: true });
    expect(parseCohortFilters(`?${query}`)).toEqual({
      school: 'Partner Academy B', grade: '11th', subject: '', status: 'regrade-pending', date: 'all', showCompleted: true,
    });
  });

  it('ignores unknown status values', () => {
    expect(parseCohortFilters('?fStatus=bogus').status).toBe('all');
  });

  it('round-trips the date window and ignores unknown presets', () => {
    expect(cohortFilterLocation({ date: 'all' })).toBe('');
    expect(cohortFilterLocation({ date: '30d' })).toBe('fDate=30d');
    expect(parseCohortFilters('?fDate=7d').date).toBe('7d');
    expect(parseCohortFilters('?fDate=forever').date).toBe('all');
    expect(parseCohortFilters('').date).toBe('all');
  });
});

describe('cohort date filtering', () => {
  const now = Date.parse('2026-03-10T00:00:00Z');
  const daysAgo = (n) => new Date(now - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  it('compares exam date against the window, not submission time', () => {
    expect(cohortWithinDateFilter({ examDate: daysAgo(3) }, '7d', now)).toBe(true);
    expect(cohortWithinDateFilter({ examDate: daysAgo(10) }, '7d', now)).toBe(false);
    expect(cohortWithinDateFilter({ examDate: daysAgo(10) }, '30d', now)).toBe(true);
    expect(cohortWithinDateFilter({ examDate: daysAgo(200) }, '90d', now)).toBe(false);
  });

  it('treats "all" as unfiltered and excludes undated exams only from a window', () => {
    expect(cohortWithinDateFilter({ examDate: '' }, 'all', now)).toBe(true);
    expect(cohortWithinDateFilter({}, '30d', now)).toBe(false);
  });

  it('composes with the other cohort filters', () => {
    const cohort = { school: 'Partner Academy B', grade: '11th', subject: 'Chemistry', pending: 4, examDate: daysAgo(2) };
    expect(cohortMatchesFilters(cohort, { date: '7d', now })).toBe(true);
    expect(cohortMatchesFilters(cohort, { date: '7d', school: 'Partner Academy B', status: 'needs-review', now })).toBe(true);
    expect(cohortMatchesFilters(cohort, { date: '7d', grade: '12th', now })).toBe(false);
    expect(cohortMatchesFilters(cohort, { date: '7d' })).toBe(false);
  });
});

describe('cohort ordering by exam date', () => {
  it('orders newest first and keeps alphabetical order as the tiebreak', () => {
    const rows = [
      { school: 'Beta', grade: '11th', examName: 'Older', examDate: '2026-01-01' },
      { school: 'Alpha', grade: '12th', examName: 'Newest', examDate: '2026-03-01' },
      { school: 'Alpha', grade: '11th', examName: 'Older', examDate: '2026-01-01' },
      { school: 'Gamma', grade: '10th', examName: 'Undated', examDate: '' },
    ];
    expect([...rows].sort(compareCohortsByExamDate).map((c) => c.examName === 'Undated' ? 'Undated' : `${c.school}/${c.grade}`))
      .toEqual(['Alpha/12th', 'Alpha/11th', 'Beta/11th', 'Undated']);
  });

  it('sorts undated cohorts last even against the oldest dated cohort', () => {
    const rows = [
      { school: 'A', examDate: '' },
      { school: 'B', examDate: '2020-01-01' },
    ];
    expect([...rows].sort(compareCohortsByExamDate).map((c) => c.school)).toEqual(['B', 'A']);
  });
});
