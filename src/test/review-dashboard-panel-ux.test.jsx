import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { RosterSearch, StudentRosterCard, filterAndSortStudents } from '../components/StudentRoster';
import { SaveStateBanner, ContextualApproveButton, EvidenceFocusPanel, RevisionSummaryBadge } from '../components/ReviewPanelComponents';

afterEach(cleanup);

const mockStudents = [
  { studentId: 'stu_101', name: 'alice_smith', marks: 15, total: 20, pending: 0, flaggedCount: 2, recheckCount: 0 },
  { studentId: 'stu_102', name: 'bob_jones', marks: 8, total: 20, pending: 3, flaggedCount: 0, recheckCount: 0 },
  { studentId: 'stu_103', name: 'charlie_brown', marks: 19, total: 20, pending: 0, flaggedCount: 0, recheckCount: 0 },
  { studentId: 'stu_104', name: 'dave_miller', marks: 10, total: 20, pending: 0, flaggedCount: 0, recheckCount: 1 },
];

describe('Phase 3 UX Improvements: Student Roster & Review Panel Components', () => {
  it('filters students by name (case-insensitive)', () => {
    const res = filterAndSortStudents(mockStudents, 'ALICE', 'name_asc');
    expect(res).toHaveLength(1);
    expect(res[0].studentId).toBe('stu_101');
  });

  it('filters students by studentId / roll number', () => {
    const res = filterAndSortStudents(mockStudents, '103', 'name_asc');
    expect(res).toHaveLength(1);
    expect(res[0].name).toBe('charlie_brown');
  });

  it('returns complete roster when search query is empty', () => {
    const res = filterAndSortStudents(mockStudents, '  ', 'name_asc');
    expect(res).toHaveLength(4);
  });

  it('sorts by risk prioritizing flagged items above other factors', () => {
    const res = filterAndSortStudents(mockStudents, '', 'risk');
    expect(res[0].studentId).toBe('stu_101'); // 2 flagged = 20 risk score
  });

  it('sorts by risk ranking recheck requests appropriately', () => {
    const res = filterAndSortStudents(mockStudents, '', 'risk');
    expect(res[1].studentId).toBe('stu_104'); // 1 recheck = 5 risk score
  });

  it('sorts by ascending score percentage correctly', () => {
    const res = filterAndSortStudents(mockStudents, '', 'score_asc');
    expect(res[0].studentId).toBe('stu_102'); // 8/20 = 40%
    expect(res[3].studentId).toBe('stu_103'); // 19/20 = 95%
  });

  it('sorts by descending score percentage correctly', () => {
    const res = filterAndSortStudents(mockStudents, '', 'score_desc');
    expect(res[0].studentId).toBe('stu_103'); // 95%
    expect(res[3].studentId).toBe('stu_102'); // 40%
  });

  it('sorts alphabetically by student name when name_asc is selected', () => {
    const res = filterAndSortStudents(mockStudents, '', 'name_asc');
    expect(res[0].name).toBe('alice_smith');
    expect(res[1].name).toBe('bob_jones');
    expect(res[2].name).toBe('charlie_brown');
    expect(res[3].name).toBe('dave_miller');
  });

  it('renders RosterSearch controls and dynamic count label in the UI', () => {
    const onSearch = vi.fn();
    render(<RosterSearch searchTerm="" onSearchChange={onSearch} studentCount={4} />);
    expect(screen.getByPlaceholderText('Search students...')).toBeInTheDocument();
    expect(screen.getByText('Showing 4 students')).toBeInTheDocument();
  });

  it('triggers callback on input change and renders clear button when text is present', () => {
    const onSearch = vi.fn();
    render(<RosterSearch searchTerm="bob" onSearchChange={onSearch} studentCount={1} />);
    const input = screen.getByPlaceholderText('Search students...');
    fireEvent.change(input, { target: { value: 'alice' } });
    expect(onSearch).toHaveBeenCalledWith('alice');
    
    const clearBtn = screen.getByRole('button', { name: /Clear student search/ });
    fireEvent.click(clearBtn);
    expect(onSearch).toHaveBeenCalledWith('');
  });

  it('renders StudentRosterCard with properly formatted human-readable names and percentage score', () => {
    render(<StudentRosterCard student={mockStudents[0]} isSelected={false} onSelect={vi.fn()} />);
    expect(screen.getByText('Alice Smith')).toBeInTheDocument();
    expect(screen.getByText(/ID: stu_101/)).toBeInTheDocument();
    expect(screen.getByText(/75%/)).toBeInTheDocument();
  });

  it('renders accurate status chips for flagged, pending, and recheck items on StudentRosterCard', () => {
    render(
      <>
        <StudentRosterCard student={mockStudents[0]} isSelected={false} onSelect={vi.fn()} />
        <StudentRosterCard student={mockStudents[1]} isSelected={false} onSelect={vi.fn()} />
        <StudentRosterCard student={mockStudents[3]} isSelected={false} onSelect={vi.fn()} />
      </>
    );
    expect(screen.getByText(/2 flagged/)).toBeInTheDocument();
    expect(screen.getByText(/3 pending/)).toBeInTheDocument();
    expect(screen.getByText(/1 recheck/)).toBeInTheDocument();
  });

  it('shows Reviewed badge on StudentRosterCard when all items are complete with zero risk factors', () => {
    render(<StudentRosterCard student={mockStudents[2]} isSelected={false} onSelect={vi.fn()} />);
    expect(screen.getByText(/Reviewed/)).toBeInTheDocument();
  });

  it('displays saving progress alert inside SaveStateBanner during active backend synchronization', () => {
    render(<SaveStateBanner status="saving" />);
    expect(screen.getByText(/Saving decision to canonical student record/)).toBeInTheDocument();
  });

  it('displays unsaved mark overrides alert in SaveStateBanner when marks are edited', () => {
    render(<SaveStateBanner hasOverrides={true} />);
    expect(screen.getByText(/Unsaved mark adjustments active/)).toBeInTheDocument();
  });

  it('displays secure synchronization confirmation in SaveStateBanner when status is saved', () => {
    render(<SaveStateBanner status="saved" />);
    expect(screen.getByText(/All review decisions synchronized securely/)).toBeInTheDocument();
  });

  it('displays standard Approve Score label with marks summary on ContextualApproveButton', () => {
    render(<ContextualApproveButton isApproved={false} hasOverride={false} marks={3} maxMarks={5} onApprove={vi.fn()} />);
    expect(screen.getByText(/Approve Score \(3\/5\)/)).toBeInTheDocument();
  });

  it('displays Save Override label on ContextualApproveButton when mark override is active', () => {
    render(<ContextualApproveButton isApproved={true} hasOverride={true} marks={4.5} maxMarks={5} onApprove={vi.fn()} />);
    expect(screen.getByText(/Save Override \(4.5\/5\)/)).toBeInTheDocument();
  });

  it('invokes onApprove and onApproveAndNext handlers upon clicking appropriate action buttons', () => {
    const onApprove = vi.fn();
    const onApproveAndNext = vi.fn();
    render(<ContextualApproveButton isApproved={false} hasOverride={false} marks={2} maxMarks={2} onApprove={onApprove} onApproveAndNext={onApproveAndNext} />);
    
    fireEvent.click(screen.getByText(/Approve Score/));
    expect(onApprove).toHaveBeenCalledOnce();
    
    fireEvent.click(screen.getByText(/Approve & Next/));
    expect(onApproveAndNext).toHaveBeenCalledOnce();
  });

  it('renders correct RevisionSummaryBadge for published vs pending regrade states and switches EvidenceFocusPanel views', () => {
    const { rerender } = render(<RevisionSummaryBadge reviewRevision={2} regradedRevision={1} isEdited={true} />);
    expect(screen.getByText(/Edits pending regrade \(Rev 2\)/)).toBeInTheDocument();

    rerender(<RevisionSummaryBadge reviewRevision={2} regradedRevision={2} isEdited={true} />);
    expect(screen.getByText(/Published in revision 2/)).toBeInTheDocument();

    render(<EvidenceFocusPanel imageUrl="http://test.local/full.png" cropUrl="http://test.local/crop.png" />);
    expect(screen.getByText(/Cropped Answer Evidence/)).toBeInTheDocument();
    
    const toggleBtn = screen.getByRole('button', { name: /Toggle full sheet view/ });
    fireEvent.click(toggleBtn);
    expect(screen.getByText(/Full Student Answer Sheet/)).toBeInTheDocument();
  });
});
