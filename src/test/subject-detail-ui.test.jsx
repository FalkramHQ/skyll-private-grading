import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const mockReportView = {
  name: 'Aarav Shah',
  username: 'aarav_123',
  examInfo: { name: 'Midterm 2026' },
  subjects: [
    {
      id: 'mathematics',
      name: 'Mathematics',
      icon: '📐',
      score: 44,
      total: 50,
      pct: 88,
      questions: [
        { number: '1', summary: 'Solve 2x = 4', marks_obtained: 2, marks_total: 2, status: 'correct', topic: 'Algebra' },
        { number: '2', summary: 'Area of circle', marks_obtained: 0, marks_total: 5, status: 'wrong', topic: 'Geometry' },
      ],
    }
  ],
};

vi.mock('../data/studentData', () => ({
  getCurrentExamData: vi.fn(() => ({
    name: 'Midterm 2026',
    schoolId: 'school_1',
    isPlatformSchool: true
  })),
  loadStudentData: vi.fn(() => ({
    id: 'student_1',
    name: 'Aarav Shah',
    username: 'aarav_123'
  })),
}));

vi.mock('../lib/reportViewModel', () => ({
  createStudentReportView: vi.fn(() => mockReportView),
}));

vi.mock('../lib/recheckUi', () => ({
  canRequestRecheckForReport: vi.fn(() => false),
  mergeRecheckResponse: vi.fn(),
}));

import SubjectDetail from '../pages/SubjectDetail.jsx';

describe('SubjectDetail', () => {
  afterEach(() => vi.clearAllMocks());

  it('omits the aggregate Marks per Question chart while retaining detailed marks', async () => {
    render(
      <MemoryRouter initialEntries={['/subject/mathematics']}>
        <Routes>
          <Route path="/subject/:subjectId" element={<SubjectDetail />} />
        </Routes>
      </MemoryRouter>
    );

    // It should contain the "Question by question" detailed view
    expect(await screen.findByText(/Question-by-question/i)).toBeInTheDocument();

    // Default filter is 'all' — every question should be visible
    expect(screen.getByText('0/5')).toBeInTheDocument();
    expect(screen.getByText('2/2')).toBeInTheDocument();

    // Switch to wrong-only filter
    const wrongButton = screen.getByRole('button', { name: '✗' });
    fireEvent.click(wrongButton);
    expect(screen.getByText('0/5')).toBeInTheDocument();
    expect(screen.queryByText('2/2')).not.toBeInTheDocument();

    // Switch back to 'All'
    const allButton = screen.getByRole('button', { name: 'All' });
    fireEvent.click(allButton);
    expect(screen.getByText('2/2')).toBeInTheDocument();
    expect(screen.getByText('0/5')).toBeInTheDocument();

    // The old QuestionBarChart and its "Marks per question" title should be absent
    expect(screen.queryByText(/Marks per question/i)).not.toBeInTheDocument();
  });
});
