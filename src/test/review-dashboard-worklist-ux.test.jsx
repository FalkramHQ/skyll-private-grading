import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import WorklistSummaryBar, { getWorklistSummaryStats } from '../components/WorklistSummaryBar';

afterEach(cleanup);

const mockCohorts = [
  {
    id: 'cohort_1',
    school: 'Alpha School',
    subject: 'Physics',
    grade: '12th',
    pending: 5,
    approved: 15,
    totalQuestions: 20,
    changedQuestions: 0,
    cohortStatus: { status: 'in_review' },
  },
  {
    id: 'cohort_2',
    school: 'Alpha School',
    subject: 'Chemistry',
    grade: '12th',
    pending: 0,
    approved: 25,
    totalQuestions: 25,
    changedQuestions: 3,
    cohortStatus: { status: 'regrade_ready' },
  },
  {
    id: 'cohort_3',
    school: 'Alpha School',
    subject: 'Biology',
    grade: '12th',
    pending: 0,
    approved: 30,
    totalQuestions: 30,
    changedQuestions: 0,
    cohortStatus: { status: 'published' },
  },
  {
    id: 'cohort_4',
    school: 'Alpha School',
    subject: 'Maths',
    grade: '12th',
    pending: 0,
    approved: 10,
    totalQuestions: 10,
    changedQuestions: 0,
    cohortStatus: { status: 'regrade_queued' },
  },
];

describe('WorklistSummaryBar unit tests and stats computations', () => {
  it('computes accurate attentionCount for cohorts with pending reviews', () => {
    const stats = getWorklistSummaryStats(mockCohorts);
    expect(stats.attentionCount).toBe(1); // cohort_1 has pending
  });

  it('computes accurate regradeCount for changed questions or regrade_queued status', () => {
    const stats = getWorklistSummaryStats(mockCohorts);
    expect(stats.regradeCount).toBe(2); // cohort_2 has changedQuestions > 0, cohort_4 is regrade_queued
  });

  it('identifies completed cohorts when no reviews or pending regrade changes remain', () => {
    const stats = getWorklistSummaryStats(mockCohorts);
    expect(stats.completedCount).toBe(1); // only cohort_3
  });

  it('computes total questions, reviewed questions, and overall progress percentage across worklist', () => {
    const stats = getWorklistSummaryStats(mockCohorts);
    expect(stats.totalQuestions).toBe(85);
    expect(stats.reviewedQuestions).toBe(80);
    expect(stats.overallProgress).toBe(94); // 80/85 * 100 ~ 94%
  });

  it('handles empty cohort lists gracefully without division by zero errors', () => {
    const stats = getWorklistSummaryStats([]);
    expect(stats).toEqual({
      attentionCount: 0,
      regradeCount: 0,
      completedCount: 0,
      totalQuestions: 0,
      reviewedQuestions: 0,
      overallProgress: 0,
    });
  });

  it('renders summary title and progress breakdown in the component', () => {
    render(<WorklistSummaryBar cohorts={mockCohorts} />);
    expect(screen.getByText('Teacher Review Worklist')).toBeInTheDocument();
    expect(screen.getByText(/80 of 85 total student answers reviewed/)).toBeInTheDocument();
    expect(screen.getByText(/94% overall completion/)).toBeInTheDocument();
  });

  it('displays filter chip buttons with dynamic item counts', () => {
    render(<WorklistSummaryBar cohorts={mockCohorts} />);
    expect(screen.getByText(/need attention/)).toBeInTheDocument();
    expect(screen.getByText(/regrading/)).toBeInTheDocument();
    expect(screen.getByText(/completed/)).toBeInTheDocument();
  });

  it('invokes callback with needs-review status when attention filter is clicked', () => {
    const onFilter = vi.fn();
    render(<WorklistSummaryBar cohorts={mockCohorts} onFilterSelect={onFilter} />);
    
    const button = screen.getByText(/need attention/).closest('button');
    fireEvent.click(button);
    expect(onFilter).toHaveBeenCalledWith('needs-review');
  });

  it('invokes callback with regrade-pending status when regrade filter is clicked', () => {
    const onFilter = vi.fn();
    render(<WorklistSummaryBar cohorts={mockCohorts} onFilterSelect={onFilter} />);
    
    const button = screen.getByText(/regrading/).closest('button');
    fireEvent.click(button);
    expect(onFilter).toHaveBeenCalledWith('regrade-pending');
  });

  it('invokes callback with completed status when completed filter is clicked and applies active styling', () => {
    const onFilter = vi.fn();
    render(<WorklistSummaryBar cohorts={mockCohorts} onFilterSelect={onFilter} currentStatus="completed" />);
    
    const button = screen.getByText(/completed/).closest('button');
    expect(button.className).toContain('bg-success-soft');
    fireEvent.click(button);
    expect(onFilter).toHaveBeenCalledWith('completed');
  });
});
