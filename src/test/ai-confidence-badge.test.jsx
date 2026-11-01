import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import React from 'react';
import AiConfidenceBadge, { getConfidenceLevel } from '../components/AiConfidenceBadge';

afterEach(cleanup);

describe('getConfidenceLevel', () => {
  it('returns "high" for confidence >= 0.85', () => {
    expect(getConfidenceLevel(0.85)).toBe('high');
    expect(getConfidenceLevel(0.95)).toBe('high');
  });

  it('returns "medium" for confidence between 0.6 and 0.85', () => {
    expect(getConfidenceLevel(0.6)).toBe('medium');
    expect(getConfidenceLevel(0.7)).toBe('medium');
    expect(getConfidenceLevel(0.84)).toBe('medium');
  });

  it('returns "low" for confidence < 0.6', () => {
    expect(getConfidenceLevel(0.59)).toBe('low');
    expect(getConfidenceLevel(0.3)).toBe('low');
    expect(getConfidenceLevel(0)).toBe('low');
  });

  it('returns "unknown" for null/undefined/NaN', () => {
    expect(getConfidenceLevel(null)).toBe('unknown');
    expect(getConfidenceLevel(undefined)).toBe('unknown');
    expect(getConfidenceLevel(NaN)).toBe('unknown');
  });
});

describe('AiConfidenceBadge', () => {
  it('renders high confidence with correct label and semantic class', () => {
    const { container } = render(<AiConfidenceBadge confidence={0.92} />);
    expect(screen.getByText(/High confidence/)).toBeInTheDocument();
    expect(container.firstChild.className).toContain('bg-success-soft');
  });

  it('renders medium confidence with correct label and semantic class', () => {
    const { container } = render(<AiConfidenceBadge confidence={0.7} />);
    expect(screen.getByText(/Medium confidence/)).toBeInTheDocument();
    expect(container.firstChild.className).toContain('bg-warning-soft');
  });

  it('renders low confidence with correct label and semantic class', () => {
    const { container } = render(<AiConfidenceBadge confidence={0.4} />);
    expect(screen.getByText(/Low confidence/)).toBeInTheDocument();
    expect(container.firstChild.className).toContain('bg-destructive-soft');
  });

  it('renders unknown state when confidence is missing', () => {
    render(<AiConfidenceBadge confidence={null} />);
    expect(screen.getByText(/Confidence unavailable/)).toBeInTheDocument();
  });

  it('renders nothing when showOnlyWhenRisk is true and confidence is high', () => {
    const { container } = render(<AiConfidenceBadge confidence={0.92} showOnlyWhenRisk />);
    expect(container.firstChild).toBeNull();
  });

  it('renders medium confidence even with showOnlyWhenRisk', () => {
    render(<AiConfidenceBadge confidence={0.7} showOnlyWhenRisk />);
    expect(screen.getByText(/Medium confidence/)).toBeInTheDocument();
  });
});
