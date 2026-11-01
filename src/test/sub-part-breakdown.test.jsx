import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import React from 'react';
import SubPartBreakdown from '../components/SubPartBreakdown';

afterEach(cleanup);

const parts = [
  { label: '(a)', prompt: 'First synonym', response: 'happy', expected: 'joyful', marks_obtained: 1, marks_total: 1, status: 'correct', statusLabel: 'Correct' },
  { label: '(b)', prompt: 'Second synonym', response: 'sad', expected: 'gloomy', marks_obtained: 0, marks_total: 1, status: 'incorrect', statusLabel: 'Incorrect' },
];

describe('SubPartBreakdown', () => {
  it('renders one row per sub-part with label, marks and text status', () => {
    const { container } = render(<SubPartBreakdown parts={parts} block />);
    expect(container.querySelectorAll('.subpart-breakdown .subpart-breakdown-row')).toHaveLength(2);

    expect(screen.getByText('(a)')).toBeInTheDocument();
    expect(screen.getByText('1/1')).toBeInTheDocument();
    expect(screen.getByText('Correct')).toBeInTheDocument();

    expect(screen.getByText('(b)')).toBeInTheDocument();
    expect(screen.getByText('0/1')).toBeInTheDocument();
    expect(screen.getByText('Incorrect')).toBeInTheDocument();
  });

  it('shows prompt, student answer and expected answer per row', () => {
    render(<SubPartBreakdown parts={parts} />);
    expect(screen.getAllByText('Prompt:')).toHaveLength(2);
    expect(screen.getAllByText('Your answer:')).toHaveLength(2);
    expect(screen.getAllByText('Expected:')).toHaveLength(1);
  });

  it('hides the expected answer for fully correct sub-parts', () => {
    render(<SubPartBreakdown parts={parts} />);
    // Only the incorrect part (b) has an expected answer shown.
    expect(screen.getAllByText('Expected:')).toHaveLength(1);
  });

  it('renders collapsible detailed reasoning when provided', () => {
    render(<SubPartBreakdown parts={parts} reasoning="First correct, second wrong." />);
    expect(screen.getByText('Detailed reasoning')).toBeInTheDocument();
  });

  it('renders nothing when there are no parts (legacy fallback)', () => {
    const { container } = render(<SubPartBreakdown parts={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
