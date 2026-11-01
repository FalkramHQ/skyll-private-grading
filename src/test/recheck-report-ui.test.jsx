import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecheckControl } from '../pages/SubjectDetail.jsx';

afterEach(cleanup);

const labels = {
  open: 'Requested',
  in_review: 'In review',
  awaiting_regrade: 'Updating report',
  resolved: 'Updated',
  declined: 'Reviewed',
  cancelled: 'Cancelled',
};

function request(status, overrides = {}) {
  return {
    id: `request_${status}`,
    status,
    reason: 'The final working supports another mark.',
    requestedByRole: 'student',
    ...overrides,
  };
}

describe('student report recheck states', () => {
  it.each(Object.entries(labels))('renders %s as the canonical label %s', (status, label) => {
    render(<RecheckControl request={request(status)} />);
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByText('The final working supports another mark.')).toBeInTheDocument();
  });

  it('identifies the actual requester role without calling an admin a teacher', () => {
    render(<RecheckControl request={request('open', { requestedByRole: 'admin' })} />);
    expect(screen.getByText('Raised by school admin')).toBeInTheDocument();
    expect(screen.queryByText('Raised by teacher')).not.toBeInTheDocument();
  });

  it('shows a safe final resolution and does not render internal workflow fields', () => {
    render(<RecheckControl request={request('resolved', {
      resolutionNote: 'The corrected report is now available.',
      internalOcr: 'raw extraction',
      reviewerId: 'private-reviewer',
      workflowRunId: 'private-run',
      modelError: 'private-model-error',
    })} />);
    expect(screen.getByText('The corrected report is now available.')).toBeInTheDocument();
    expect(screen.queryByText('raw extraction')).not.toBeInTheDocument();
    expect(screen.queryByText('private-reviewer')).not.toBeInTheDocument();
    expect(screen.queryByText('private-run')).not.toBeInTheDocument();
    expect(screen.queryByText('private-model-error')).not.toBeInTheDocument();
  });

  it('rejects an 11-character reason and submits a 12-character reason', async () => {
    const onSubmit = vi.fn().mockResolvedValue({ ok: true });
    render(<RecheckControl onSubmit={onSubmit} requesterRole="student" />);
    fireEvent.click(screen.getByRole('button', { name: 'Request a recheck' }));
    const reason = screen.getByRole('textbox');

    fireEvent.change(reason, { target: { value: '12345678901' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send recheck request' }));
    expect(screen.getByText(/at least 12 characters/i)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.change(reason, { target: { value: '123456789012' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send recheck request' }));
    expect(onSubmit).toHaveBeenCalledWith('123456789012');
  });

  it('enforces the 800-character browser input limit', () => {
    render(<RecheckControl onSubmit={vi.fn()} requesterRole="student" />);
    fireEvent.click(screen.getByRole('button', { name: 'Request a recheck' }));
    expect(screen.getByRole('textbox')).toHaveAttribute('maxlength', '800');
  });
});
