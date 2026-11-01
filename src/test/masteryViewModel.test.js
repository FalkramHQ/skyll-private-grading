import { describe, it, expect } from 'vitest';
import { masteryStatus, normalizeMasteryRows, groupMasteryBySubject } from '../lib/mastery';

describe('mastery view model', () => {
  it('maps theta to status bands', () => {
    expect(masteryStatus(0.8)).toBe('ready');
    expect(masteryStatus(0.6)).toBe('developing');
    expect(masteryStatus(0.3)).toBe('at_risk');
  });

  it('treats the ready band boundary as ready', () => {
    expect(masteryStatus(0.75)).toBe('ready');
  });

  it('normalizes empty and nullish inputs to an empty list', () => {
    expect(normalizeMasteryRows([])).toEqual([]);
    expect(normalizeMasteryRows(null)).toEqual([]);
  });

  it('normalizes route rows with pct + wide handling', () => {
    const rows = normalizeMasteryRows([
      { kcId: 'kc_a', kcLabel: 'Integrals', subject: 'Mathematics', thetaMean: 0.42, ciLow: 0.2, ciHigh: 0.6, evidenceCount: 6, wide: false },
      { kcId: 'kc_b', kcLabel: 'Matrices', subject: 'Mathematics', thetaMean: 0.5, ciLow: null, ciHigh: null, evidenceCount: 1, wide: true },
    ]);
    expect(rows[0]).toMatchObject({ kcId: 'kc_a', pct: 42, status: 'at_risk', wide: false, hasCi: true });
    expect(rows[1]).toMatchObject({ kcId: 'kc_b', status: 'developing', wide: true, hasCi: false });
    // weakest first
    expect(rows[0].thetaMean).toBeLessThanOrEqual(rows[1].thetaMean);
  });

  it('groups by subject', () => {
    const rows = normalizeMasteryRows([
      { kcId: 'kc_a', subject: 'Mathematics', thetaMean: 0.5, evidenceCount: 1, wide: false, ciLow: 0.2, ciHigh: 0.8 },
      { kcId: 'kc_h', subject: 'Hindi', thetaMean: 0.7, evidenceCount: 2, wide: false, ciLow: 0.4, ciHigh: 0.9 },
    ]);
    const groups = groupMasteryBySubject(rows);
    expect(groups.map((g) => g.subject)).toEqual(['Hindi', 'Mathematics']);
  });
});
