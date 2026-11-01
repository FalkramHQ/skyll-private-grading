import { describe, it, expect, vi, beforeEach } from 'vitest';

const getStudentContext = vi.fn();
vi.mock('../lib/db', () => ({
  getStudentContext: (...args) => getStudentContext(...args),
  getTeacherDashboard: vi.fn(),
}));

let studentDataModule;
beforeEach(async () => {
  vi.resetModules();
  studentDataModule = await import('../data/studentData');
});

describe('loadStudentData request race', () => {
  it('does not let a stale student response overwrite a newer username', async () => {
    let resolveFirst;
    getStudentContext.mockImplementation((username) => {
      if (username === 'old') {
        return new Promise((resolve) => { resolveFirst = resolve; });
      }
      return Promise.resolve({ report: { name: 'New student' }, classRanks: [] });
    });

    const first = studentDataModule.loadStudentData('old');
    const second = studentDataModule.loadStudentData('new');
    await second;
    expect(studentDataModule.studentData.name).toBe('New student');

    resolveFirst({ report: { name: 'Old student' }, classRanks: [] });
    await first;
    expect(studentDataModule.studentData.name).toBe('New student');
  });
});
