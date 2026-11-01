import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { getReportBackUrl, getSubjectReportUrl } from '../lib/reportNavigation';

vi.mock('../data/studentData', () => ({
  getCurrentExamData: vi.fn(() => ({ id: 'term2' })),
  loadStudentData: vi.fn(),
}));

vi.mock('../lib/reportViewModel', () => ({
  createStudentReportView: vi.fn(() => ({
    name: 'Student One',
    class: '12th',
    school: 'Test School',
    examInfo: { name: 'Term 2' },
    subjects: [],
  })),
}));

vi.mock('../components/MathText', () => ({ default: () => null }));
vi.mock('../components/AnswerSheetGallery', () => ({ default: () => null }));

import Report from '../pages/Report';

function CurrentLocation() {
  const location = useLocation();
  return <div data-testid="current-location">{location.pathname}{location.search}</div>;
}

describe('student report back navigation', () => {
  it('returns admin and teacher viewers to the selected student DNA page', () => {
    const params = new URLSearchParams({
      student: 'student 01',
      exam: 'term2',
      tab: 'students',
      subject: 'Chemistry',
      cls: '12th',
    });

    expect(getReportBackUrl(params)).toBe(
      '/student/student%2001?tab=students&subject=Chemistry&cls=12th&exam=term2',
    );
  });

  it('returns a student viewer to their dashboard', () => {
    const params = new URLSearchParams({ exam: 'term2' });

    expect(getReportBackUrl(params)).toBe('/dashboard?exam=term2');
  });

  it('preserves staff context when moving between subject reports', () => {
    const params = new URLSearchParams({
      student: 'student01', exam: 'term2', tab: 'students', subject: 'Chemistry', cls: '12th', examFilter: 'published',
    });

    expect(getSubjectReportUrl('Mathematics/12', params)).toBe(
      '/subject/Mathematics%2F12?student=student01&exam=term2&tab=students&subject=Chemistry&cls=12th&examFilter=published',
    );
  });

  it('wires the report Back button to the student DNA route for an admin viewer', () => {
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => 'admin') });

    render(
      <MemoryRouter initialEntries={['/report?student=student01&exam=term2&tab=students&subject=Chemistry&cls=12th']}>
        <Routes>
          <Route path="/report" element={<Report />} />
          <Route path="/student/:username" element={<CurrentLocation />} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Back to Dashboard' }));

    expect(screen.getByTestId('current-location')).toHaveTextContent(
      '/student/student01?tab=students&subject=Chemistry&cls=12th&exam=term2',
    );
  });
});
