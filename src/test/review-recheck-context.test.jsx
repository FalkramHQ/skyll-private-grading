import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecheckRequestCard } from '../pages/VlReviewDashboard.jsx';

afterEach(cleanup);

function request(overrides = {}) {
  return {
    id: 'recheck_1',
    requestedBy: 'student_a',
    requestedByRole: 'student',
    requestedAt: '2026-07-28T10:30:00.000Z',
    status: 'open',
    reason: 'Please consider the final calculation.',
    ...overrides,
  };
}

describe('review recheck context card', () => {
  it('shows requester, time, status, reason, and the next action for a student request', () => {
    const takeUp = vi.fn();
    render(<RecheckRequestCard request={request()} onTakeUp={takeUp} onKeepOriginalGrade={vi.fn()} />);

    expect(screen.getByText('Student request')).toBeInTheDocument();
    expect(screen.getByText(/student_a/)).toBeInTheDocument();
    expect(screen.getByText('Requested')).toBeInTheDocument();
    expect(screen.getByText('Please consider the final calculation.')).toBeInTheDocument();
    expect(screen.getByText('Next: Take up recheck')).toBeInTheDocument();
    expect(screen.getByText(/2026/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Take up' }));
    expect(takeUp).toHaveBeenCalledWith('recheck_1');
  });

  it('identifies staff requests and explains that awaiting regrade needs no manual transition', () => {
    render(<RecheckRequestCard request={request({
      requestedBy: 'admin_a',
      requestedByRole: 'admin',
      status: 'awaiting_regrade',
      internalModelTrace: 'never render this',
    })} onTakeUp={vi.fn()} onKeepOriginalGrade={vi.fn()} />);

    expect(screen.getByText('Teacher request')).toBeInTheDocument();
    expect(screen.getByText(/admin_a/)).toBeInTheDocument();
    expect(screen.getByText('Updating report')).toBeInTheDocument();
    expect(screen.getByText('Next: Awaiting updated report')).toBeInTheDocument();
    expect(screen.queryByText('never render this')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Take up' })).not.toBeInTheDocument();
  });
});
