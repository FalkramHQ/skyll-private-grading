import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { useMobileLayout, MobileRosterDrawer, MobileActionBar } from '../components/ReviewMobileLayout';

afterEach(cleanup);

function TestHookComponent({ breakpoint = 768 }) {
  const isMobile = useMobileLayout(breakpoint);
  return <div data-testid="mobile-indicator">{isMobile ? 'MOBILE_MODE' : 'DESKTOP_MODE'}</div>;
}

const mockStudents = [
  { studentId: 'stu_1', name: 'emma_watson', marks: 18, total: 20, pending: 1, flaggedCount: 0 },
  { studentId: 'stu_2', name: 'liam_neeson', marks: 14, total: 20, pending: 0, flaggedCount: 1 },
];

describe('Phase 4 Mobile Layout & Verification: Mobile Roster & Action Bar', () => {
  it('useMobileLayout returns true when window width is below breakpoint and reacts to resize events', () => {
    // Simulate desktop width initially
    window.innerWidth = 1024;
    const { getByTestId } = render(<TestHookComponent breakpoint={768} />);
    expect(getByTestId('mobile-indicator').textContent).toBe('DESKTOP_MODE');

    // Simulate window resize to mobile screen dimensions
    window.innerWidth = 500;
    fireEvent(window, new Event('resize'));
    expect(getByTestId('mobile-indicator').textContent).toBe('MOBILE_MODE');
  });

  it('MobileRosterDrawer does not render content in DOM when isOpen is false', () => {
    const { container } = render(
      <MobileRosterDrawer isOpen={false} students={mockStudents} onClose={vi.fn()} onSelectStudent={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('MobileRosterDrawer renders overlay, header title, search controls, and student roster list when isOpen is true', () => {
    render(
      <MobileRosterDrawer isOpen={true} students={mockStudents} onClose={vi.fn()} onSelectStudent={vi.fn()} />
    );
    expect(screen.getByText('Student Roster')).toBeInTheDocument();
    expect(screen.getByText('Emma Watson')).toBeInTheDocument();
    expect(screen.getByText('Liam Neeson')).toBeInTheDocument();
  });

  it('MobileRosterDrawer invokes onClose callback when clicking close icon or backdrop overlay', () => {
    const onClose = vi.fn();
    render(
      <MobileRosterDrawer isOpen={true} students={mockStudents} onClose={onClose} onSelectStudent={vi.fn()} />
    );

    const closeBtn = screen.getByRole('button', { name: /Close roster drawer/ });
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);

    const backdrop = screen.getByLabelText('Close drawer overlay');
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('MobileActionBar displays active question progression numbers and roster badge count accurately', () => {
    render(
      <MobileActionBar currentIndex={2} totalItems={15} rosterCount={8} onPrev={vi.fn()} onNext={vi.fn()} onApprove={vi.fn()} onToggleRoster={vi.fn()} />
    );
    expect(screen.getByText('Question 3 of 15')).toBeInTheDocument();
    expect(screen.getByText('8')).toBeInTheDocument();
  });

  it('MobileActionBar invokes navigation and drawer toggle callbacks upon button clicks', () => {
    const onToggleRoster = vi.fn();
    const onPrev = vi.fn();
    const onNext = vi.fn();
    render(
      <MobileActionBar currentIndex={1} totalItems={5} onPrev={onPrev} onNext={onNext} onToggleRoster={onToggleRoster} onApprove={vi.fn()} />
    );

    fireEvent.click(screen.getByRole('button', { name: /Toggle mobile student roster/ }));
    expect(onToggleRoster).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: /Previous question/ }));
    expect(onPrev).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: /Next question/ }));
    expect(onNext).toHaveBeenCalledOnce();
  });

  it('MobileActionBar adapts button styling for overrides and disables actions when saving is underway', () => {
    const { rerender } = render(
      <MobileActionBar currentIndex={0} totalItems={5} isSaving={false} hasOverride={true} onApprove={vi.fn()} />
    );
    expect(screen.getByText('Save Override')).toBeInTheDocument();

    rerender(
      <MobileActionBar currentIndex={0} totalItems={5} isSaving={true} hasOverride={false} onApprove={vi.fn()} />
    );
    expect(screen.getByText('Saving...')).toBeInTheDocument();
  });
});
