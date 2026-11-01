import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RegradeConfirmDialog } from '../pages/VlReviewDashboard';

afterEach(cleanup);

const cohort = { school: 'Partner Academy B', grade: '11th', subject: 'Chemistry', examName: '11th Mole concept' };

describe('RegradeConfirmDialog', () => {
  it('lists students, totals, and confirms', () => {
    const onConfirm = vi.fn();
    render(<RegradeConfirmDialog
      cohort={cohort}
      preview={{ totalQuestions: 3, students: [
        { studentId: 's1', studentName: 'Asha', questionCount: 2 },
        { studentId: 's2', studentName: 'Kiran', questionCount: 1 },
      ] }}
      loading={false} error={null}
      onConfirm={onConfirm} onCancel={() => {}} onRefresh={() => {}}
    />);
    expect(screen.getByText('Asha')).toBeTruthy();
    expect(screen.getByText(/3 questions across 2 students/)).toBeTruthy();
    fireEvent.click(screen.getByText('Confirm regrade'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('offers refresh instead of confirm when the preview is empty', () => {
    const onRefresh = vi.fn();
    render(<RegradeConfirmDialog
      cohort={cohort} preview={{ totalQuestions: 0, students: [] }}
      loading={false} error={null}
      onConfirm={() => {}} onCancel={() => {}} onRefresh={onRefresh}
    />);
    expect(screen.queryByText('Confirm regrade')).toBeNull();
    fireEvent.click(screen.getByText('Refresh list'));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('disables confirm while loading and on error', () => {
    const { rerender } = render(<RegradeConfirmDialog
      cohort={cohort} preview={null} loading={true} error={null}
      onConfirm={() => {}} onCancel={() => {}} onRefresh={() => {}}
    />);
    expect(screen.queryByText('Confirm regrade')).toBeNull();
    rerender(<RegradeConfirmDialog
      cohort={cohort} preview={null} loading={false} error="Could not load preview"
      onConfirm={() => {}} onCancel={() => {}} onRefresh={() => {}}
    />);
    expect(screen.getByText('Could not load preview')).toBeTruthy();
    expect(screen.queryByText('Confirm regrade')).toBeNull();
  });
});
