import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { ReportOutline } from '../components/ReportOutline';

afterEach(cleanup);

const sections = [
  { id: 'result', label: 'Assessment Result', nextAction: 'Review weak areas' },
  { id: 'dna', label: 'Learner DNA', nextAction: null },
  { id: 'subjects', label: 'Subject Performance', nextAction: null },
  { id: 'questions', label: 'Question Analysis', nextAction: null },
  { id: 'answer-sheets', label: 'Answer Sheets', nextAction: null },
  { id: 'rechecks', label: 'Recheck Requests', nextAction: null },
];

describe('ReportOutline', () => {
  it('renders all section labels', () => {
    render(<ReportOutline sections={sections} activeId="result" onSelect={() => {}} />);
    expect(screen.getByText('Assessment Result')).toBeInTheDocument();
    expect(screen.getByText('Learner DNA')).toBeInTheDocument();
    expect(screen.getByText('Subject Performance')).toBeInTheDocument();
  });

  it('calls onSelect with section id when clicked', () => {
    const onSelect = vi.fn();
    render(<ReportOutline sections={sections} activeId="result" onSelect={onSelect} />);
    fireEvent.click(screen.getByText('Learner DNA'));
    expect(onSelect).toHaveBeenCalledWith('dna');
  });

  it('marks active section with distinct styling', () => {
    const { container } = render(<ReportOutline sections={sections} activeId="dna" onSelect={() => {}} />);
    const buttons = container.querySelectorAll('button');
    const activeButton = Array.from(buttons).find(b => b.textContent.includes('Learner DNA'));
    expect(activeButton.className).toContain('text-accent');
    expect(activeButton.className).toContain('font-semibold');
  });

  it('shows next-action hint for sections that have one', () => {
    render(<ReportOutline sections={sections} activeId="result" onSelect={() => {}} />);
    expect(screen.getByText('Review weak areas')).toBeInTheDocument();
  });

  it('renders nothing when sections array is empty', () => {
    const { container } = render(<ReportOutline sections={[]} activeId="" onSelect={() => {}} />);
    expect(container.firstChild).toBeNull();
  });
});
