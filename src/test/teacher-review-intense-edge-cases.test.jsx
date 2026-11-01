import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { RosterSearch, StudentRosterCard, filterAndSortStudents } from '../components/StudentRoster';
import { SaveStateBanner, ContextualApproveButton, EvidenceFocusPanel, RevisionSummaryBadge } from '../components/ReviewPanelComponents';
import WorklistSummaryBar, { getWorklistSummaryStats } from '../components/WorklistSummaryBar';
import { MobileRosterDrawer, MobileActionBar } from '../components/ReviewMobileLayout';

afterEach(cleanup);

describe('Intense Stress & Edge Case Testing: Teacher Review Dashboard', () => {
  it('High-Volume Classroom Simulation: processes and sorts 1,000 student records under 150ms without degradation', () => {
    const hugeRoster = Array.from({ length: 1000 }, (_, idx) => ({
      studentId: `stu_${idx}`,
      name: `student_${idx}_${idx % 2 ? 'alpha' : 'beta'}`,
      marks: idx % 21,
      total: 20,
      pending: idx % 5 === 0 ? 2 : 0,
      flaggedCount: idx % 7 === 0 ? 1 : 0,
      recheckCount: idx % 13 === 0 ? 1 : 0,
    }));

    const start = performance.now();
    const sortedByRisk = filterAndSortStudents(hugeRoster, 'alpha', 'risk');
    const sortedByScoreDesc = filterAndSortStudents(hugeRoster, '', 'score_desc');
    const duration = performance.now() - start;

    expect(duration).toBeLessThan(150);
    expect(sortedByRisk.length).toBeGreaterThan(0);
    expect(sortedByScoreDesc.length).toBe(1000);
    // Highest percentage scores should sit at index 0 in score_desc
    expect(sortedByScoreDesc[0].marks / sortedByScoreDesc[0].total).toBeGreaterThanOrEqual(
      sortedByScoreDesc[999].marks / sortedByScoreDesc[999].total
    );
  });

  it('Corrupted Data & Nullability Resilience: handles null marks, 0 total, undefined names, and malformed structures without rendering crashes', () => {
    const malformedStudents = [
      { studentId: 'corrupt_1', name: null, marks: null, total: 0, pending: undefined, flaggedCount: NaN },
      { studentId: undefined, name: undefined, marks: -5, total: null, pending: null, recheckCount: '2' },
      { studentId: 'valid_id', name: 'Valid Student', marks: '15', total: '20', pending: '1' },
    ];

    const sorted = filterAndSortStudents(malformedStudents, '', 'risk');
    expect(sorted).toHaveLength(3);

    // Verify UI card renders without crashing on malformed record
    const { container } = render(<StudentRosterCard student={malformedStudents[0]} isSelected={false} onSelect={vi.fn()} />);
    expect(container).toBeInTheDocument();
    expect(screen.getByText(/0%/)).toBeInTheDocument(); // Division by 0 protection
  });

  it('Intensive Worklist Summary Edge Cases: tolerates empty arrays, string numerical strings, and extreme volumes', () => {
    const emptyStats = getWorklistSummaryStats([]);
    expect(emptyStats).toEqual({ attentionCount: 0, regradeCount: 0, completedCount: 0, totalQuestions: 0, reviewedQuestions: 0, overallProgress: 0 });

    const extremeCohorts = [
      { id: 'c1', pending: '500', totalQuestions: '99999', reviewedQuestions: '99999', flaggedCount: '10' },
      { id: 'c2', status: 'regrade_queued', totalQuestions: 1, reviewedQuestions: 0, pending: 0 },
    ];
    const extremeStats = getWorklistSummaryStats(extremeCohorts);
    expect(extremeStats.attentionCount).toBe(1);
    expect(extremeStats.regradeCount).toBe(1);
    expect(extremeStats.totalQuestions).toBe(100000);
    expect(extremeStats.reviewedQuestions).toBe(99999);
    expect(extremeStats.overallProgress).toBe(100); // 99999/100000 rounded
  });

  it('SaveStateBanner Prioritization & Error Flooding: ensures error alert takes precedence over unsaved overrides', () => {
    const { rerender } = render(<SaveStateBanner status="error" errorMessage="Critical database failure" hasOverrides={true} />);
    expect(screen.getByText(/Critical database failure/)).toBeInTheDocument();
    expect(screen.queryByText(/Unsaved mark adjustments/)).toBeNull();

    rerender(<SaveStateBanner status="unsaved" hasOverrides={true} />);
    expect(screen.getByText(/Unsaved mark adjustments/)).toBeInTheDocument();
  });

  it('Action Concurrency Shield: prevents handler firing under rapid consecutive click spam when disabled or saving', () => {
    const onApprove = vi.fn();
    const onApproveAndNext = vi.fn();
    const { rerender } = render(
      <ContextualApproveButton isApproved={false} hasOverride={false} isSaving={true} onApprove={onApprove} onApproveAndNext={onApproveAndNext} />
    );

    const savingBtn = screen.getByText(/Saving.../);
    const nextBtn = screen.getByText(/Approve & Next/);

    // Spam clicks while saving
    for (let i = 0; i < 20; i++) {
      fireEvent.click(savingBtn);
      fireEvent.click(nextBtn);
    }

    expect(onApprove).toHaveBeenCalledTimes(0);
    expect(onApproveAndNext).toHaveBeenCalledTimes(0);

    // Enable and check valid click
    rerender(
      <ContextualApproveButton isApproved={false} hasOverride={false} isSaving={false} onApprove={onApprove} onApproveAndNext={onApproveAndNext} />
    );
    fireEvent.click(screen.getByText(/Approve Score/));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it('Revision & Evidence Panel Resilience: tolerates NaN revisions and missing visual asset references cleanly', () => {
    const { container } = render(<RevisionSummaryBadge reviewRevision={NaN} regradedRevision={undefined} isEdited={true} />);
    expect(container.textContent).toContain('Published in revision 1'); // Fallback to 1

    render(<EvidenceFocusPanel imageUrl={null} cropUrl={undefined} studentName="John Doe" questionNumber="Q5" />);
    expect(screen.getByText(/No cropped visual evidence available for this question/)).toBeInTheDocument();
  });

  it('Mobile Drawer & Action Bar Rigorous Stress: verifies clean dynamic search state rendering during repeated toggles', () => {
    const students = [
      { studentId: 's1', name: 'Sophia Taylor', marks: 10, total: 10, pending: 0 },
      { studentId: 's2', name: 'Oliver Twist', marks: 5, total: 10, pending: 2 },
    ];
    const onClose = vi.fn();
    const { rerender } = render(
      <MobileRosterDrawer isOpen={true} students={students} onClose={onClose} searchTerm="Sophia" sortMode="risk" />
    );

    expect(screen.getByText('Sophia Taylor')).toBeInTheDocument();
    expect(screen.queryByText('Oliver Twist')).toBeNull();

    // Toggle drawer off and on in succession
    rerender(<MobileRosterDrawer isOpen={false} students={students} onClose={onClose} searchTerm="" sortMode="risk" />);
    expect(screen.queryByText('Sophia Taylor')).toBeNull();

    rerender(<MobileRosterDrawer isOpen={true} students={students} onClose={onClose} searchTerm="Twist" sortMode="risk" />);
    expect(screen.getByText('Oliver Twist')).toBeInTheDocument();
  });
});
