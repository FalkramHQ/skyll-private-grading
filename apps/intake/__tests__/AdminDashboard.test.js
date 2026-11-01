import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { AdminDashboard } from '../src/RoleDashboards';

describe('AdminDashboard Component', () => {
  const mockInitialData = {
    academic_years: [
      { id: 'ay2025', label: '2024-2025', is_current: false },
      { id: 'ay2026', label: '2025-2026', is_current: true }
    ],
    exams: [
      // Simulate production payload: no academic_year_id is present, only academic_year label string
      { id: 'exam1', source_test_id: 'test1', name: 'Maths Exam', subject: 'Maths', grade: '9th', exam_type: 'mcq', exam_date: '2026-08-01', academic_year: '2025-2026' },
      { id: 'exam2', source_test_id: 'test2', name: 'Physics Exam', subject: 'Physics', grade: '10th', exam_type: 'subjective', exam_date: '2026-08-02', academic_year: '2025-2026' }
    ]
  };

  const mockLoadedExamData = {
    academic_years: mockInitialData.academic_years,
    exams: mockInitialData.exams,
    report: {
      cohort_reports: {
        test1: {
          overview: {
            evaluated_students: 2,
            average_score: 75,
            average_total: 100,
            average_percentage: 75
          },
          segmentation: {
            quadrant_a: ['Aditi Sharma'],
            quadrant_b: [],
            quadrant_c: [],
            quadrant_d: ['Rahul Verma']
          },
          systemic_strengths: ['1 learner strong in performance'],
          systemic_gaps: ['1 learner needs focused support'],
          exam_hotspots: [
            { id: 'Q1', title: 'Calculus concept', failure_rate: '50% struggled', why: 'Struggled with limit concepts', implication: 'Revisit limit definitions' }
          ],
          interventions: [
            { type: 'immediate', title: 'Triage gaps', action: 'Focused study session' },
            { type: 'long-term', title: 'Pedagogical changes', action: 'Iterative practice' }
          ]
        },
        test2: {
          overview: {
            evaluated_students: 2,
            average_score: 85,
            average_total: 100,
            average_percentage: 85
          },
          segmentation: {
            quadrant_a: ['Aditi Sharma', 'Rahul Verma'],
            quadrant_b: [],
            quadrant_c: [],
            quadrant_d: []
          },
          systemic_strengths: ['All learners strong'],
          systemic_gaps: [],
          exam_hotspots: [],
          interventions: []
        }
      }
    },
    studentReports: [
      {
        username: 'aditi',
        public_username: 'aditi_s',
        student: { name: 'Aditi Sharma', class: '9th' },
        test_id: 'test1',
        term1: {
          subjects: [{ name: 'Mathematics', score: 90, total: 100 }]
        }
      },
      {
        username: 'rahul',
        student: { name: 'Rahul Verma', class: '9th' },
        test_id: 'test1',
        term1: {
          subjects: [{ name: 'Mathematics', score: 30, total: 100 }]
        }
      }
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
  });

  test('defaults to current academic year and triggers loaders', async () => {
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
      expect(mockLoadExamData).toHaveBeenCalledWith('ay2026', 'test1');
    });
  });

  test('does not reload the selected exam when parent data is refreshed', async () => {
    let refreshParent;
    function Parent() {
      const [data, setData] = React.useState(mockInitialData);
      refreshParent = () => setData({ ...mockInitialData });
      return (
        <AdminDashboard
          data={data}
          school="Test School"
          onLogout={mockLogout}
          onBack={mockBack}
          onOpenStudent={mockOpenStudent}
          refreshing={false}
          onRefresh={mockRefresh}
          onLoadExamData={mockLoadExamData}
        />
      );
    }

    await act(async () => {
      render(<Parent />);
    });

    await waitFor(() => {
      expect(mockLoadExamData).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      refreshParent();
    });

    expect(mockLoadExamData).toHaveBeenCalledTimes(1);
  });

  test('keeps the latest exam response when an earlier request finishes late', async () => {
    let resolveFirstRequest;
    const firstRequest = new Promise((resolve) => {
      resolveFirstRequest = resolve;
    });
    const currentExamData = {
      ...mockLoadedExamData,
      studentReports: [{
        username: 'current',
        student: { name: 'Current exam result', class: '10th' },
        test_id: 'test2',
        term1: { subjects: [{ name: 'Physics', score: 88, total: 100 }] },
      }],
    };
    const staleExamData = {
      ...mockLoadedExamData,
      studentReports: [{
        username: 'stale',
        student: { name: 'Stale exam result', class: '9th' },
        test_id: 'test1',
        term1: { subjects: [{ name: 'Mathematics', score: 20, total: 100 }] },
      }],
    };
    mockLoadExamData
      .mockImplementationOnce(() => firstRequest)
      .mockResolvedValueOnce(currentExamData);

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
      expect(mockLoadExamData).toHaveBeenCalledWith('ay2026', 'test1');
    });

    await act(async () => {
      fireEvent.press(screen.getByTestId('filter-chip-exam'));
    });
    await waitFor(() => {
      expect(screen.getByText('Physics Exam')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.press(screen.getByText('Physics Exam'));
    });

    await waitFor(() => {
      expect(mockLoadExamData).toHaveBeenLastCalledWith('ay2026', 'test2');
    });

    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.press(screen.getByText('Reports'));
    });
    await waitFor(() => {
      expect(screen.getByText('Current exam result')).toBeTruthy();
    });

    await act(async () => {
      resolveFirstRequest(staleExamData);
      await firstRequest;
    });

    expect(screen.getByText('Current exam result')).toBeTruthy();
    expect(screen.queryByText('Stale exam result')).toBeNull();
  });

  test('switching tabs changes visible content', async () => {
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

    // Wait for load
    await waitFor(() => {
      expect(screen.getByText('Evaluated Students')).toBeTruthy();
    });

    // Switch to Segments
    await act(async () => {
      fireEvent.press(screen.getByText('Segments'));
    });
    await waitFor(() => {
      expect(screen.getByText('Conceptual Anchors')).toBeTruthy();
      expect(screen.getByText('Aditi Sharma')).toBeTruthy();
    });

    // Switch to Hotspots
    await act(async () => {
      fireEvent.press(screen.getByText('Hotspots'));
    });
    await waitFor(() => {
      expect(screen.getByText('Calculus concept')).toBeTruthy();
    });

    // Switch to Action Plan
    await act(async () => {
      fireEvent.press(screen.getByText('Action Plan'));
    });
    await waitFor(() => {
      expect(screen.getByText('Triage gaps')).toBeTruthy();
      expect(screen.getByText('Pedagogical changes')).toBeTruthy();
    });

    // Switch to Reports
    await act(async () => {
      fireEvent.press(screen.getByText('Reports'));
    });
    await waitFor(() => {
      expect(screen.getByText('Filter Students')).toBeTruthy();
      expect(screen.getByText('Aditi Sharma')).toBeTruthy();
      expect(screen.getByText('Rahul Verma')).toBeTruthy();
    });
  });

  test('cascade filters and resetSelections works', async () => {
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
      expect(mockLoadExamData).toHaveBeenCalled();
    });

    // Open subject picker filter
    await act(async () => {
      fireEvent.press(screen.getByTestId('filter-chip-subject'));
    });

    // Select Physics
    await act(async () => {
      fireEvent.press(screen.getByText(/Physics/));
    });

    // Verify it loads test2 (which belongs to Physics) since test1 is Maths
    await waitFor(() => {
      expect(mockLoadExamData).toHaveBeenLastCalledWith('ay2026', 'test2');
    });
  });

  test('preserving assessment processing status', async () => {
    const mockTests = [
      { id: 't1', title: 'Intake test 1', status: 'uploading', jobStatus: null },
      { id: 't2', title: 'Intake test 2', status: 'completed', jobStatus: 'running' }
    ];

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
          tests={mockTests}
        />
      );
    });

    await waitFor(() => {
      expect(screen.getByText('Intake test 1')).toBeTruthy();
      expect(screen.getByText('Processing: running')).toBeTruthy();
    });
  });

  test('handles student reports list interactions, filters, and expanding', async () => {
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

    // Wait for load
    await waitFor(() => {
      expect(screen.getByText('Evaluated Students')).toBeTruthy();
    });

    // Go to reports tab
    await act(async () => {
      fireEvent.press(screen.getByText('Reports'));
    });

    // Tap Aditi Sharma row to expand it
    await act(async () => {
      fireEvent.press(screen.getByText('Aditi Sharma'));
    });

    // Expanding should show "Show Full Report"
    await waitFor(() => {
      expect(screen.getByText('Show Full Report')).toBeTruthy();
    });

    // Clicking "Show Full Report" should trigger onOpenStudent
    await act(async () => {
      fireEvent.press(screen.getByText('Show Full Report'));
    });
    // Since Aditi has a public_username 'aditi_s', verify it passes that
    expect(mockOpenStudent).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'aditi', public_username: 'aditi_s' })
    );
  });

  test('stale selections and rapid filter changes handling', async () => {
    // Return a delayed response for first call, immediate response for second call
    let firstPromiseResolve;
    const firstPromise = new Promise(resolve => {
      firstPromiseResolve = resolve;
    });

    mockLoadExamData.mockImplementation((year, examId) => {
      if (examId === 'test1') {
        return firstPromise;
      }
      return Promise.resolve({
        ...mockLoadedExamData,
        // For test2, let's change average percentage to 85 so we can verify test2 won
        report: {
          cohort_reports: {
            test2: {
              overview: {
                evaluated_students: 2,
                average_score: 85,
                average_total: 100,
                average_percentage: 85
              }
            }
          }
        },
        studentReports: [
          {
            username: 'aditi',
            student: { name: 'Aditi Sharma', class: '10th' },
            test_id: 'test2',
            term1: { subjects: [{ name: 'Physics', score: 85, total: 100 }] }
          }
        ]
      });
    });

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

    // Triggers default test1 first (delayed)
    await waitFor(() => {
      expect(mockLoadExamData).toHaveBeenCalledWith('ay2026', 'test1');
    });

    // Manually trigger Physics change to trigger second call (immediate)
    await act(async () => {
      fireEvent.press(screen.getByTestId('filter-chip-subject'));
    });
    await act(async () => {
      fireEvent.press(screen.getByText(/Physics/)); // triggers test2 load
    });

    await waitFor(() => {
      expect(mockLoadExamData).toHaveBeenLastCalledWith('ay2026', 'test2');
    });

    // Resolve first call afterwards
    await act(async () => {
      firstPromiseResolve({
        ...mockLoadedExamData,
        report: {
          cohort_reports: {
            test1: {
              overview: {
                evaluated_students: 0,
                average_percentage: 0
              }
            }
          }
        },
        studentReports: []
      });
    });

    // Verify Overview tab shows average score of test2 (85%), NOT the stale test1 (0%)
    await waitFor(() => {
      expect(screen.getAllByText('85%').length).toBeGreaterThan(0);
    });

    // Go to reports tab and verify test2 reports (Aditi Sharma) are present, not stale empty list
    await act(async () => {
      fireEvent.press(screen.getByText('Reports'));
    });
    await waitFor(() => {
      expect(screen.getByText('Aditi Sharma')).toBeTruthy();
      expect(screen.queryByText('No matching student reports found.')).toBeNull();
    });
  });

  test('truthful empty states for hotspots and reports', async () => {
    const emptyLoadedExamData = {
      academic_years: mockInitialData.academic_years,
      exams: mockInitialData.exams,
      report: {
        cohort_reports: {
          test1: {
            overview: {},
            segmentation: {},
            exam_hotspots: [],
            interventions: []
          }
        }
      },
      studentReports: []
    };

    mockLoadExamData.mockResolvedValue(emptyLoadedExamData);

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

    // Wait for load
    await waitFor(() => {
      expect(screen.getByText('Priority Gaps')).toBeTruthy();
    });

    // Hotspots empty state
    await act(async () => {
      fireEvent.press(screen.getByText('Hotspots'));
    });
    await waitFor(() => {
      expect(screen.getByText('No per-question analysis available yet. Hotspots appear once grading data is available.')).toBeTruthy();
    });

    // Reports empty state
    await act(async () => {
      fireEvent.press(screen.getByText('Reports'));
    });
    await waitFor(() => {
      expect(screen.getByText('No matching student reports found.')).toBeTruthy();
    });
  });

  test('displays error and retry mechanism', async () => {
    mockLoadExamData.mockRejectedValue(new Error('Network disconnected'));

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
      expect(screen.getByText('Network disconnected')).toBeTruthy();
    });

    // Verify retry button exists
    expect(screen.getByText('Retry Loading')).toBeTruthy();

    // Press retry
    mockLoadExamData.mockResolvedValue(mockLoadedExamData);
    await act(async () => {
      fireEvent.press(screen.getByText('Retry Loading'));
    });

    await waitFor(() => {
      expect(screen.getByText('Evaluated Students')).toBeTruthy();
    });
  });

  test('selecting a non-current year triggers two-stage load and selects newest exam', async () => {
    // 1. Initial render defaults to ay2026/test1
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
      expect(mockLoadExamData).toHaveBeenCalledWith('ay2026', 'test1');
    });

    // Mock response for older year ay2025
    const mockAy2025Data = {
      academic_years: mockInitialData.academic_years,
      exams: [
        { id: 'exam3', source_test_id: 'test3', name: 'Chemistry Exam', subject: 'Chemistry', grade: '9th', exam_type: 'mcq', exam_date: '2025-08-01', academic_year: '2024-2025' }
      ],
      report: {
        cohort_reports: {
          test3: {
            overview: {
              evaluated_students: 3,
              average_score: 92,
              average_total: 100,
              average_percentage: 92
            }
          }
        }
      },
      studentReports: [
        {
          username: 'rohan',
          student: { name: 'Rohan Gupta', class: '9th' },
          test_id: 'test3',
          term1: {
            subjects: [{ name: 'Chemistry', score: 92, total: 100 }]
          }
        }
      ]
    };

    mockLoadExamData.mockResolvedValue(mockAy2025Data);

    // 2. Click Year chip to trigger picker
    await act(async () => {
      fireEvent.press(screen.getByTestId('filter-chip-year'));
    });

    // 3. Select 2024-2025 (ay2025) option
    await act(async () => {
      fireEvent.press(screen.getByText('2024-2025'));
    });

    // Verify it triggers first-stage load with selectedYear='ay2025' and selectedExamId=''
    await waitFor(() => {
      expect(mockLoadExamData).toHaveBeenCalledWith('ay2025', '');
    });

    // Once that resolves, stage-2 should auto-select the newest exam of ay2025 (test3)
    await waitFor(() => {
      expect(mockLoadExamData).toHaveBeenLastCalledWith('ay2025', 'test3');
    });

    // Check that reports of test3 (Rohan Gupta) and metrics are rendered
    await waitFor(() => {
      expect(screen.getAllByText('92%').length).toBeGreaterThan(0);
    });

    await act(async () => {
      fireEvent.press(screen.getByText('Reports'));
    });

    await waitFor(() => {
      expect(screen.getByText('Rohan Gupta')).toBeTruthy();
    });
  });
});
