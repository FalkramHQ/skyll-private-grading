import { describe, expect, it } from 'vitest';
import { evaluateEarlyWarning } from '../../api/_lib/earlyWarning.js';

function q(number, topic, obtained, total, status = 'incorrect') {
  return { number, topic, marks_obtained: obtained, marks_total: total, status };
}

describe('evaluateEarlyWarning', () => {
  it('returns null for a healthy script', () => {
    const result = evaluateEarlyWarning({
      score: 18,
      total: 20,
      priorPct: 80,
      questions: [
        q('1', 'Email', 5, 5, 'correct'),
        q('2', 'Grammar', 4, 5, 'partial'),
        q('3', 'Grammar', 5, 5, 'correct'),
        q('4', 'Notice', 4, 5, 'partial'),
      ],
    });
    expect(result).toBeNull();
  });

  it('flags a large score drop', () => {
    const result = evaluateEarlyWarning({
      score: 8,
      total: 20,
      priorPct: 78,
      questions: [
        q('1', 'Email', 2, 5),
        q('2', 'Grammar', 2, 5),
        q('3', 'Grammar', 2, 5),
        q('4', 'Notice', 2, 5),
      ],
    });
    expect(result).not.toBeNull();
    expect(result.reasons.some((reason) => reason.code === 'score_drop')).toBe(true);
    expect(result.severity).toBe('at_risk');
  });

  it('flags many zeros', () => {
    const result = evaluateEarlyWarning({
      score: 5,
      total: 20,
      questions: [
        q('1', 'Email', 5, 5, 'correct'),
        q('2', 'Grammar', 0, 5),
        q('3', 'Grammar', 0, 5),
        q('4', 'Notice', 0, 5),
        q('5', 'Joining', 0, 5),
      ],
    });
    expect(result.reasons.some((reason) => reason.code === 'many_zeros')).toBe(true);
    expect(result.zeroCount).toBe(4);
  });

  it('flags clustered weak topics', () => {
    const result = evaluateEarlyWarning({
      score: 10,
      total: 20,
      questions: [
        q('1', 'Email', 5, 5, 'correct'),
        q('2', 'Tenses', 1, 5),
        q('3', 'Prepositions', 0, 5),
        q('4', 'Notice', 4, 5, 'partial'),
      ],
    });
    expect(result.reasons.some((reason) => reason.code === 'weak_topics')).toBe(true);
    expect(result.weakTopics.map((row) => row.topic)).toEqual(expect.arrayContaining(['Tenses', 'Prepositions']));
  });

  it('ignores not_attempted questions for zero ratio', () => {
    const result = evaluateEarlyWarning({
      score: 10,
      total: 10,
      questions: [
        q('1', 'Email', 5, 5, 'correct'),
        q('2', 'Grammar', 5, 5, 'correct'),
        q('3', 'Optional', 0, 5, 'not_attempted'),
        q('4', 'Optional', 0, 5, 'not_attempted'),
        q('5', 'Optional', 0, 5, 'not_attempted'),
      ],
    });
    expect(result).toBeNull();
  });

  it('evaluates gracefully when prior percentage or historical averages are missing or undefined', () => {
    const result = evaluateEarlyWarning({
      score: 15,
      total: 20,
      priorPct: undefined,
      questions: [q('1', 'Math', 15, 20, 'partial')],
    });
    expect(result).toBeNull();
  });

  it('captures simultaneous multi-flag scenarios (score drop, many zeros, and weak topics)', () => {
    const result = evaluateEarlyWarning({
      score: 3,
      total: 50,
      priorPct: 85,
      questions: [
        q('1', 'Algebra', 3, 10, 'partial'),
        q('2', 'Calculus', 0, 10),
        q('3', 'Geometry', 0, 10),
        q('4', 'Calculus', 0, 10),
        q('5', 'Geometry', 0, 10),
      ],
    });
    expect(result).not.toBeNull();
    const codes = result.reasons.map((r) => r.code);
    expect(codes).toContain('score_drop');
    expect(codes).toContain('many_zeros');
    expect(codes).toContain('weak_topics');
    expect(result.severity).toBe('at_risk');
  });
});


