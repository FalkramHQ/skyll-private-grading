import { describe, it, expect } from 'vitest';
import { weakTopicsFromContext } from '../../api/_lib/practice';

describe('weakTopicsFromContext (KC-based)', () => {
  it('picks lowest-theta KC labels plus misconception topics', () => {
    const context = {
      mastery: [
        { kcId: 'kc_a', kcLabel: 'Integrals', thetaMean: 0.3 },
        { kcId: 'kc_b', kcLabel: 'Matrices', thetaMean: 0.9 },
      ],
      signals: [{ misconception: 'sign error', topic: 'Determinants' }],
    };
    const topics = weakTopicsFromContext(context);
    expect(topics[0]).toBe('Integrals');
    expect(topics).toContain('Determinants');
    expect(topics).not.toContain('Matrices');
  });

  it('returns signal topics only when no KC mastery exists', () => {
    const context = { mastery: [], signals: [{ misconception: 'sign error', topic: 'Determinants' }] };
    expect(weakTopicsFromContext(context)).toEqual(['Determinants']);
  });
});
