import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { vi, describe, expect, it } from 'vitest';

vi.mock('../data/studentData', () => ({
  loadStudentData: vi.fn().mockResolvedValue({ username: 'student01' }),
  loadTeacherData: vi.fn(),
}));

vi.mock('../pages/Dashboard', () => ({
  default: ({ teacherView, backUrl }) => (
    <div data-testid="student-dashboard">
      {teacherView ? 'teacher view' : 'student view'} | {backUrl}
    </div>
  ),
}));

import { StudentReportPage } from '../App';

describe('teacher student-report route', () => {
  it('opens the full student dashboard instead of the printable report', async () => {
    render(
      <MemoryRouter initialEntries={['/student/student01?tab=students&subject=Chemistry&cls=12th']}>
        <Routes>
          <Route path="/student/:username" element={<StudentReportPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('student-dashboard')).toHaveTextContent(
      'teacher view | /dashboard?tab=students&subject=Chemistry&cls=12th',
    );
  });
});
