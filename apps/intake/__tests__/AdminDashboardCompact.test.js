// Phone-layout tests for the AdminDashboard compact section selector.
// On narrow (phone) widths the horizontal tab strip is replaced by a compact
// menu that shows the active section and opens a picker with all five sections.
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Dimensions } from 'react-native';
import { AdminDashboard } from '../src/RoleDashboards';

describe('AdminDashboard Compact Section Menu (phone)', () => {
  const mockInitialData = {
    academic_years: [
      { id: 'ay2026', label: '2025-2026', is_current: true }
    ],
    exams: [
      { id: 'exam1', source_test_id: 'test1', name: 'Maths Exam', subject: 'Maths', grade: '9th', exam_type: 'mcq', exam_date: '2026-08-01', academic_year: '2025-2026' }
    ]
  };

  const mockLoadedExamData = {
    academic_years: mockInitialData.academic_years,
    exams: mockInitialData.exams,
    report: {
      cohort_reports: {
        test1: {
          overview: { evaluated_students: 2, average_score: 75, average_total: 100, average_percentage: 75 },
          segmentation: { quadrant_a: ['Aditi Sharma'], quadrant_b: [], quadrant_c: [], quadrant_d: ['Rahul Verma'] },
          systemic_strengths: ['1 learner strong'],
          systemic_gaps: ['1 learner needs support'],
          exam_hotspots: [{ id: 'Q1', title: 'Calculus concept', failure_rate: '50%', why: 'Struggled', implication: 'Revisit' }],
          interventions: [{ type: 'immediate', title: 'Triage gaps', action: 'Focused session' }]
        }
      }
    },
    studentReports: [
      { username: 'aditi', public_username: 'aditi_s', student: { name: 'Aditi Sharma', class: '9th' }, test_id: 'test1', term1: { subjects: [{ name: 'Mathematics', score: 90, total: 100 }] } }
    ]
  };

  let mockLoadExamData;
  let mockLogout;
  let mockBack;
  let mockOpenStudent;
  let mockRefresh;

  beforeEach(() => {
    mockLoadExamData = jest.fn().mockResolvedValue(mockLoadedExamData);
    mockLogout = jest.fn();
    mockBack = jest.fn();
    mockOpenStudent = jest.fn();
    mockRefresh = jest.fn();
    // Simulate a phone-sized window so the compact menu is used.
    Dimensions.set({ window: { width: 375, height: 812, scale: 2, fontScale: 1 } });
  });

  const renderDashboard = async () => {
    await act(async () => {
      render(
        <AdminDashboard
          data={mockInitialData}
          school="Test School"
          onLogout={mockLogout}
          onBack={mockBack}
          onOpenStudent={mockOpenStudent}
          refreshing={false}
          onRefresh={mockRefresh}
          onLoadExamData={mockLoadExamData}
        />
      );
    });
    await waitFor(() => {
      expect(screen.getByText('Evaluated Students')).toBeTruthy();
    });
  };

  test('shows a compact trigger with the active section in closed state', async () => {
    await renderDashboard();

    // The compact trigger is present and shows the active (Overview) section.
    expect(screen.getByTestId('section-menu-trigger')).toBeTruthy();
    expect(screen.getAllByText('Overview').length).toBeGreaterThan(0);

    // There is no horizontally scrolling tab strip on phone.
    expect(screen.queryByTestId('section-menu-item-overview')).toBeNull();
  });

  test('opens the menu revealing all five sections and marks selection, then closes on selection', async () => {
    await renderDashboard();

    // Open the menu.
    await act(async () => {
      fireEvent.press(screen.getByTestId('section-menu-trigger'));
    });

    // All five sections are reachable without horizontal scrolling.
    for (const label of ['Overview', 'Segments', 'Hotspots', 'Action Plan', 'Reports']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }

    // Active section is marked.
    expect(screen.getByTestId('section-menu-item-overview')).toBeTruthy();

    // Select Hotspots — menu closes and content switches.
    await act(async () => {
      fireEvent.press(screen.getByTestId('section-menu-item-hotspots'));
    });

    await waitFor(() => {
      expect(screen.getByText('Calculus concept')).toBeTruthy();
    });

    // Menu has closed.
    expect(screen.queryByTestId('section-menu-item-hotspots')).toBeNull();

    // Trigger now shows the new active section.
    expect(screen.getAllByText('Hotspots').length).toBeGreaterThan(0);
  });

  test('switching sections does not reset filters', async () => {
    await renderDashboard();

    // Select a grade filter (9th) so the mark can be observed on the chip.
    await act(async () => {
      fireEvent.press(screen.getByTestId('filter-chip-grade'));
    });
    // The grade options list "All Grades" and "9th"; preselect via picker-option testID.
    await waitFor(() => {
      expect(screen.getByTestId('picker-option-grade-9th')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('picker-option-grade-9th'));
    });

    // The grade chip now reflects the selection.
    expect(screen.getByTestId('filter-chip-grade')).toBeTruthy();
    expect(screen.getAllByText('9th').length).toBeGreaterThan(0);

    // Switch to the Reports section via the menu.
    await act(async () => {
      fireEvent.press(screen.getByTestId('section-menu-trigger'));
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('section-menu-item-students'));
    });

    await waitFor(() => {
      expect(screen.getByText('Filter Students')).toBeTruthy();
      expect(screen.getByText('Aditi Sharma')).toBeTruthy();
    });

    // The grade filter is preserved — the chip still shows 9th.
    expect(screen.getAllByText('9th').length).toBeGreaterThan(0);
  });
});
