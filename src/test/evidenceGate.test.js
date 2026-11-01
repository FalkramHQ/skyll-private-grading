import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_MIN_SIGNALS,
  assessEvidenceReadiness,
  InsufficientEvidenceError,
} from '../../api/_lib/contextBuilder.js';

const signals = (n) => Array.from({ length: n }, (_, i) => ({ id: `s${i}` }));

describe('assessEvidenceReadiness', () => {
  it('returns none with no signals and no DNA', () => {
    const r = assessEvidenceReadiness({ signals: [], dna: null });
    expect(r.level).toBe('none');
    expect(r.reason).toBeTruthy();
  });

  it('returns thin below the minimum', () => {
    const r = assessEvidenceReadiness({
      signals: signals(EVIDENCE_MIN_SIGNALS - 1),
      dna: { topic_mastery: [] },
    });
    expect(r.level).toBe('thin');
    expect(r.signals).toBe(EVIDENCE_MIN_SIGNALS - 1);
  });

  it('returns ok at the minimum', () => {
    const r = assessEvidenceReadiness({ signals: signals(EVIDENCE_MIN_SIGNALS), dna: null });
    expect(r.level).toBe('ok');
    expect(r.reason).toBeNull();
  });

  it('tolerates missing context fields', () => {
    expect(assessEvidenceReadiness(undefined).level).toBe('none');
  });

  it('InsufficientEvidenceError carries evidence payload', () => {
    const err = new InsufficientEvidenceError({ level: 'thin', signals: 2, needed: 5, reason: 'x' });
    expect(err.name).toBe('InsufficientEvidenceError');
    expect(err.evidence.signals).toBe(2);
  });
});
