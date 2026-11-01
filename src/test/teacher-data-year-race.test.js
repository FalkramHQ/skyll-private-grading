import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the DB layer so we can control when each year's fetch resolves.
const getTeacherDashboard = vi.fn();
vi.mock('../lib/db', () => ({
  getTeacherDashboard: (...args) => getTeacherDashboard(...args),
}));

// Fresh module state per test so the shared cache + request counter reset.
let teacherDataModule;
beforeEach(async () => {
  vi.resetModules();
  teacherDataModule = await import('../data/studentData');
});

describe('loadTeacherData year race', () => {
  it('does not let a stale year response overwrite the cache written by a newer year', async () => {
    // Year 2025 request resolves FIRST in time but we want 2026 to be newer.
    // Simulate: fetch for '2025' starts, then '2026' starts and resolves first,
    // then '2025' resolves. The stale '2025' must NOT clobber the cache.
    let resolve2025;
    getTeacherDashboard.mockImplementation(({ year }) => {
      if (year === '2025') {
        return new Promise((resolve) => { resolve2025 = resolve; });
      }
      // 2026 resolves immediately.
      return Promise.resolve({
        report: { name: 'R2026' },
        studentReports: [],
        exams: [],
        academic_years: [],
      });
    });

    const p2025 = teacherDataModule.loadTeacherData('teacher01', { year: '2025' });
    const p2026 = teacherDataModule.loadTeacherData('teacher01', { year: '2026' });

    // '2026' finishes first and writes the cache.
    await p2026;
    expect(teacherDataModule.teacherData._year).toBe('2026');

    // Now the stale '2025' resolves afterwards.
    resolve2025({
      report: { name: 'R2025' },
      studentReports: [],
      exams: [],
      academic_years: [],
    });
    const result2025 = await p2025;

    // The stale request must not clobber the cache; it returns the newest data.
    expect(teacherDataModule.teacherData._year).toBe('2026');
    expect(teacherDataModule.teacherData.name).toBe('R2026');
    expect(result2025._year).toBe('2026');
  });

  it('returns cached data on repeated calls for the same year without refetching', async () => {
    getTeacherDashboard.mockImplementation(({ year }) =>
      Promise.resolve({
        report: { name: `R-${year}` },
        studentReports: [],
        exams: [],
        academic_years: [],
      }),
    );

    await teacherDataModule.loadTeacherData('teacher01', { year: '2025' });
    const callsAfterFirst = getTeacherDashboard.mock.calls.length;

    const cached = await teacherDataModule.loadTeacherData('teacher01', { year: '2025' });
    expect(getTeacherDashboard.mock.calls.length).toBe(callsAfterFirst);
    expect(cached._year).toBe('2025');
    expect(cached.name).toBe('R-2025');
  });
});
