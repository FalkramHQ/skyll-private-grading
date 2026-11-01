// src/test/masteryEstimator.test.js
import { describe, it, expect } from 'vitest';
import { betaPosterior, thetaMean, credibleInterval, computeMastery } from '../../api/_lib/masteryEstimator.js';

describe('beta-binomial', () => {
  it('updates alpha/beta with confidence-weighted partial credit', () => {
    // prior Beta(1,1); one signal p=0.5, confidence=1, marks_total=4 → w=1, α=1.5, β=1.5
    const post = betaPosterior({ alpha: 1, beta: 1 }, [{ p: 0.5, confidence: 1, marksTotal: 4 }]);
    expect(post.alpha).toBeCloseTo(1.5, 6);
    expect(post.beta).toBeCloseTo(1.5, 6);
  });

  it('weights by confidence and marks_total (capped at /4)', () => {
    // marks_total=8, confidence=0.5 → w = 0.5 * min(8/4,1) = 0.5; p=1 → α += 0.5
    const post = betaPosterior({ alpha: 1, beta: 1 }, [{ p: 1, confidence: 0.5, marksTotal: 8 }]);
    expect(post.alpha).toBeCloseTo(1.5, 6);
    expect(post.beta).toBeCloseTo(1, 6);
  });

  it('theta mean = α/(α+β)', () => {
    expect(thetaMean({ alpha: 3, beta: 1 })).toBeCloseTo(0.75, 6);
  });

  it('CI is wide for thin evidence, tight for rich', () => {
    const thin = credibleInterval({ alpha: 1.5, beta: 1.5 }); // n<30 → wide flag
    expect(thin.wide).toBe(true);
    const rich = credibleInterval({ alpha: 30, beta: 10 }); // n=40 → tight
    expect(rich.wide).toBe(false);
    expect(rich.ciLow).toBeLessThan(rich.ciHigh);
  });

  it('computeMastery aggregates signals into a posterior snapshot', () => {
    const signals = [
      { marksObtained: 4, marksTotal: 4, confidence: 0.9 },
      { marksObtained: 1, marksTotal: 4, confidence: 0.6 },
    ];
    const m = computeMastery(signals, { kcId: 'kc_a', subject: 'Mathematics' });
    expect(m.kcId).toBe('kc_a');
    expect(m.alpha).toBeGreaterThan(1);
    expect(m.thetaMean).toBeGreaterThan(0);
    expect(m.thetaMean).toBeLessThan(1);
    expect(m.evidenceCount).toBe(2);
  });

  it('lastSignalAt picks the newest extractedAt', () => {
    const m = computeMastery([
      { marksObtained: 2, marksTotal: 4, confidence: 1, extractedAt: '2026-01-01T00:00:00Z' },
      { marksObtained: 3, marksTotal: 4, confidence: 1, extractedAt: '2026-03-01T00:00:00Z' },
      { marksObtained: 1, marksTotal: 4, confidence: 1, extractedAt: '2026-02-01T00:00:00Z' },
    ], { kcId: 'kc_a', subject: 'Mathematics' });
    expect(m.lastSignalAt).toBe('2026-03-01T00:00:00Z');
  });
});
