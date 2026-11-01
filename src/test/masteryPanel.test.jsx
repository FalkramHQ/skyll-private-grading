import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import MasteryPanel from '../components/MasteryPanel';
import { normalizeMasteryRows } from '../lib/mastery';

const rawRows = [
  { kcId: 'kc_a', kcLabel: 'Integrals', subject: 'Mathematics', thetaMean: 0.42, ciLow: 0.2, ciHigh: 0.6, evidenceCount: 6, wide: false },
  { kcId: 'kc_b', kcLabel: 'Matrices', subject: 'Mathematics', thetaMean: 0.5, ciLow: null, ciHigh: null, evidenceCount: 1, wide: true },
];

const rows = normalizeMasteryRows(rawRows);

afterEach(() => {
  cleanup();
});

describe('MasteryPanel', () => {
  it('renders KC rows with evidence counts', () => {
    render(<MasteryPanel rows={rows} />);
    expect(screen.getByText('Integrals')).toBeInTheDocument();
    expect(screen.getByText(/6 pieces of evidence/)).toBeInTheDocument();
  });

  it('flags wide rows as gathering evidence', () => {
    render(<MasteryPanel rows={rows} />);
    expect(screen.getByText('Gathering evidence')).toBeInTheDocument();
  });

  it('shows the evidence-gated empty state', () => {
    render(<MasteryPanel rows={[]} />);
    expect(screen.getByText(/No measured knowledge components yet/)).toBeInTheDocument();
  });

  it('shows a loading state', () => {
    render(<MasteryPanel rows={[]} loading />);
    expect(screen.getByText(/Measuring knowledge components/)).toBeInTheDocument();
  });

  it('paints the CI whisker with the correct bounds over the bar', () => {
    render(<MasteryPanel rows={rows} />);
    const track = screen.getByRole('img', { name: 'Integrals: 42% mastery, 95% CI 20–60%' });
    const whisker = Array.from(track.children).find((el) => el.style.left === '20%');
    expect(whisker).toBeInTheDocument();
    expect(whisker.style.width).toBe('40%');
  });

  it('groups rows by subject', () => {
    render(<MasteryPanel rows={[...rawRows, { kcId: 'kc_h', kcLabel: 'Sparsh', subject: 'Hindi', thetaMean: 0.7, ciLow: 0.4, ciHigh: 0.9, evidenceCount: 2, wide: false }]} />);
    expect(screen.getByText('Mathematics')).toBeInTheDocument();
    expect(screen.getByText('Hindi')).toBeInTheDocument();
  });

  it('caps each subject at 12 rows and shows a +N more footnote', () => {
    const many = Array.from({ length: 13 }, (_, i) => ({
      kcId: `kc_${i}`,
      kcLabel: `Topic ${i}`,
      subject: 'Mathematics',
      thetaMean: 0.5,
      ciLow: 0.2,
      ciHigh: 0.8,
      evidenceCount: 2,
      wide: false,
    }));
    render(<MasteryPanel rows={many} />);
    expect(screen.queryByText('Topic 12')).not.toBeInTheDocument();
    expect(screen.getByText('+1 more knowledge component')).toBeInTheDocument();
  });

  it('shows the At risk badge and singular evidence count', () => {
    render(<MasteryPanel rows={rows} />);
    expect(screen.getByText('At risk')).toBeInTheDocument();
    expect(screen.getByText('1 piece of evidence')).toBeInTheDocument();
  });

  it('renders the empty state for null rows without throwing', () => {
    render(<MasteryPanel rows={null} />);
    expect(screen.getByText(/No measured knowledge components yet/)).toBeInTheDocument();
  });
});
