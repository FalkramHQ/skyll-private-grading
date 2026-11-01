import { describe, it, expect, vi } from 'vitest';
import { computeReadiness, getReadiness } from '../../api/_lib/readiness';

const buildStudentContext = vi.hoisted(() => vi.fn());
const getStudentCurriculum = vi.hoisted(() => vi.fn());
const listCurriculumStandards = vi.hoisted(() => vi.fn());

vi.mock('../../api/_lib/contextBuilder.js', () => ({ buildStudentContext }));
vi.mock('../../api/_lib/curriculumMap.js', () => ({ getStudentCurriculum, listCurriculumStandards }));

const targetTopics = [
  { topic: 'Integrals', difficultyWeight: 1 },
  { topic: 'Matrices', difficultyWeight: 1 },
];

describe('computeReadiness (KC-based)', () => {
  it('computes a weighted score from KC mastery rows', () => {
    const mastery = [
      { kcId: 'kc_int', kcLabel: 'Integrals', thetaMean: 0.8 },
      { kcId: 'kc_mat', kcLabel: 'Matrices', thetaMean: 0.4 },
    ];
    const result = computeReadiness({ targetTopics, mastery });
    expect(result.score).toBe(60); // (80 + 40) / 2
    expect(result.breakdown.find((r) => r.topic === 'Integrals').masteryPct).toBe(80);
  });

  it('evidence-gates when there are no KC estimates', () => {
    const result = computeReadiness({ targetTopics, mastery: [] });
    expect(result.score).toBeNull();
    expect(result.explanation).toMatch(/Not enough measured evidence/);
  });

  it('does not false-positive on raw substring bleed ("AP" vs graphical KC)', () => {
    const result = computeReadiness({
      targetTopics: [{ topic: 'AP', difficultyWeight: 1 }],
      mastery: [
        { kcId: 'kc_graph', kcLabel: 'Graphical representation of a pair of linear equations', thetaMean: 0.2 },
      ],
    });
    const row = result.breakdown.find((r) => r.topic === 'AP');
    expect(row.masteryPct).toBeNull();
    expect(row.status).toBe('unknown');
    expect(result.score).toBeNull();
  });

  it('matches by curriculum standard id even when labels differ', () => {
    const result = computeReadiness({
      targetTopics: [{ topic: 'Integrals', curriculumStandardId: 'cbse_12_math_integration', difficultyWeight: 1 }],
      mastery: [
        { kcId: 'kc_parts', kcLabel: 'Integration by parts', curriculumStandardId: 'cbse_12_math_integration', thetaMean: 0.7 },
      ],
    });
    const row = result.breakdown.find((r) => r.topic === 'Integrals');
    expect(row.masteryPct).toBe(70);
    expect(result.score).toBe(70);
  });

  it('uses word-boundary matching, not substring bleed', () => {
    // Partial token overlap alone must NOT match.
    const noMatch = computeReadiness({
      targetTopics: [{ topic: 'Quadratic Equations', difficultyWeight: 1 }],
      mastery: [{ kcId: 'kc_qf', kcLabel: 'Quadratic formula', thetaMean: 0.6 }],
    });
    expect(noMatch.breakdown[0].masteryPct).toBeNull();
    expect(noMatch.score).toBeNull();

    // Full contiguous token containment (both sides multi-token) MUST match.
    const match = computeReadiness({
      targetTopics: [{ topic: 'Quadratic equations', difficultyWeight: 1 }],
      mastery: [{ kcId: 'kc_sq', kcLabel: 'Solving quadratic equations', thetaMean: 0.55 }],
    });
    expect(match.breakdown[0].masteryPct).toBe(55);
  });

  it('keeps the minimum pct for duplicate KC labels', () => {
    const result = computeReadiness({
      targetTopics: [{ topic: 'Integrals', difficultyWeight: 1 }],
      mastery: [
        { kcId: 'kc_int_a', kcLabel: 'Integrals', thetaMean: 0.8 },
        { kcId: 'kc_int_b', kcLabel: 'Integrals', thetaMean: 0.3 },
      ],
    });
    expect(result.breakdown[0].masteryPct).toBe(30);
    expect(result.score).toBe(30);
  });
});

describe('getReadiness focus branch', () => {
  it('never fabricates pseudo-targets from weakest KC labels', async () => {
    buildStudentContext.mockResolvedValueOnce({
      studentId: 'stu1',
      username: 's1',
      mastery: [{ kcId: 'kc_weak', kcLabel: 'Unrelated weakest KC', thetaMean: 0.1 }],
    });
    const topics = Array.from({ length: 10 }, (_, i) => `Chapter Topic ${i}`);
    const result = await getReadiness({}, { schoolId: 'sch_x', username: 's1', topics });
    expect(result.score).toBeNull();
    expect(result.breakdown).toEqual([]);
    expect(result.breakdown.some((row) => row.topic === 'Unrelated weakest KC')).toBe(false);
  });
});
