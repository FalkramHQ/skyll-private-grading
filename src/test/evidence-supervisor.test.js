import { describe, expect, it } from 'vitest';
import { EvidenceSupervisor } from '../../apps/processing-worker/evidenceSupervisor.js';

/**
 * FLKRM-160: cohort failure detection must use a rolling window so that a
 * sustained run of low-coverage students halts the cohort at ANY point, not
 * only at the exact sample-size boundary.
 */
describe('EvidenceSupervisor cohort failure detection (FLKRM-160)', () => {
  const options = { cohortSampleSize: 3, minCoverageThreshold: 0.3, fastForwardThreshold: 0.65, perStudentRetryThreshold: 0.4 };

  const complete = (attempted, total = 10) => ({ attempted, total, answers: Array.from({ length: total }, (_, i) => i < attempted ? { question_number: String(i + 1), attempted: true } : { question_number: String(i + 1), attempted: false }) });

  it('halts on sustained low coverage partway through the cohort (not just at sample boundary)', () => {
    const sup = new EvidenceSupervisor([], options);
    // Healthy start, then a failing run begins after the sample window.
    expect(sup.onStudentComplete(complete(9)).action).toBe('continue'); // window [0.9]
    expect(sup.onStudentComplete(complete(9)).action).toBe('continue'); // window [0.9,0.9]
    expect(sup.onStudentComplete(complete(9)).action).toBe('fast_forward'); // window [0.9,0.9,0.9] healthy first sample
    // Failing run continues — the OLD code switched off after student 3.
    expect(sup.onStudentComplete(complete(1)).action).toBe('continue'); // window [0.9,0.9,0.1] avg ~0.63
    expect(sup.onStudentComplete(complete(0)).action).toBe('continue'); // window [0.9,0.1,0.0] avg ~0.33 (still above 0.3)
    // Now the rolling window reflects the sustained failure → halt partway.
    const verdict = sup.onStudentComplete(complete(0)); // window [0.1,0.0,0.0] avg ~0.03
    expect(verdict.action).toBe('pause');
    expect(verdict.reason).toBe('systemic_failure');
    expect(sup.halted).toBe(true);
  });

  it('does not halt a healthy cohort', () => {
    const sup = new EvidenceSupervisor([], options);
    for (let i = 0; i < 8; i += 1) {
      expect(sup.onStudentComplete(complete(9)).action).not.toBe('pause');
    }
    expect(sup.halted).toBe(false);
    expect(sup.postRunReport().halted).toBe(false);
  });

  it('halts immediately when the very first sample is catastrophically low', () => {
    const sup = new EvidenceSupervisor([], options);
    sup.onStudentComplete(complete(0)); // [0.0]
    sup.onStudentComplete(complete(0)); // [0.0,0.0]
    const verdict = sup.onStudentComplete(complete(0)); // [0.0,0.0,0.0] avg 0
    expect(verdict.action).toBe('pause');
    expect(sup.haltReason).toMatch(/probable systemic OCR failure/);
  });
});
