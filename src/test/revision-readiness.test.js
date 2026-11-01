import { describe, expect, it } from 'vitest';
import { buildRevisionFallback, generateRevisionPlan, normalizeRevisionPlan } from '../../api/_lib/revisionPlan.js';
import { computeReadiness } from '../../api/_lib/readiness.js';
import { InsufficientEvidenceError } from '../../api/_lib/contextBuilder.js';

describe('revision plan', () => {
  it('builds heuristic priorities from gaps and low mastery', () => {
    const plan = buildRevisionFallback({
      subject: 'Mathematics',
      mastery: [{ topic: 'Quadratic Equations', pct: 40 }],
      gaps: [{ topic: 'Trigonometric Identities', misconceptions: ['identity slip'], evidence: ['Q3'], count: 2 }],
      growthEdge: { mode_id: 'calibrator', action: 'check steps' },
    });
    expect(plan.priority_1.topic).toBe('Trigonometric Identities');
    expect(plan.priority_2.topic).toBe('Quadratic Equations');
    expect(plan.total_study_time).toMatch(/min/);
  });

  it('normalizes LLM payloads onto the display contract', () => {
    const normalized = normalizeRevisionPlan({
      subject: 'Mathematics',
      priorities: [{ topic: 'A', reason: 'r1', evidence_qids: ['Q1'], estimated_time: '20 min', resources: [] }],
      total_study_time: '40 min',
      strength_to_leverage: 'Algebra',
    }, buildRevisionFallback({ subject: 'Mathematics', mastery: [], gaps: [], growthEdge: null }));
    expect(normalized.priority_1.topic).toBe('A');
    expect(normalized.strength_to_leverage).toBe('Algebra');
  });

  it('refuses revision generation without evidence', async () => {
    const db = { execute: async () => ({ rows: [] }) };
    await expect(generateRevisionPlan(db, { schoolId: 'sch_x', username: 's1' }))
      .rejects.toThrow(InsufficientEvidenceError);
  });
});

describe('readiness score', () => {
  it('computes weighted readiness from KC mastery', () => {
    const result = computeReadiness({
      targetTopics: [
        { topic: 'Trigonometric Identities', difficultyWeight: 2 },
        { topic: 'Quadratic Equations', difficultyWeight: 1 },
      ],
      mastery: [
        { kcId: 'kc_trig', kcLabel: 'Trigonometric Identities', thetaMean: 0.4 },
        { kcId: 'kc_quad', kcLabel: 'Quadratic Equations', thetaMean: 0.8 },
      ],
    });
    expect(result.score).toBe(Math.round((40 * 2 + 80) / 3));
    expect(result.breakdown[0].status).toBe('at_risk');
    expect(result.explanation).toMatch(/40%/);
  });
});
