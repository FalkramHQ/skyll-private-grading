import { describe, expect, it } from 'vitest';
import { LEARNING_MODES, normalizeLearnerDna } from '../lib/learnerDna';

describe('learner DNA normalization', () => {
  it('adapts earlier report DNA into the current display schema', () => {
    const dna = normalizeLearnerDna({
      label: 'The Foundation Rebuilder',
      narrative: 'This paper shows secure responses alongside developing ones.',
      dimensions: [{ name: 'Accuracy', level: 'developing' }],
    });

    expect(dna).toMatchObject({
      schema_version: 2,
      identity: { label: 'Current learning snapshot' },
    });
    expect(dna.dimensions).toHaveLength(LEARNING_MODES.length);
    expect(dna.dimensions.every((dimension) => dimension.state === 'not_observed')).toBe(true);
  });

  it('keeps only approved modes and reduces unsupported single-question certainty', () => {
    const dna = normalizeLearnerDna({
      schema_version: 2,
      assessment_scope: { level: 'assessment_snapshot' },
      primary_mode: { mode_id: 'architect', title: 'The Architect' },
      dimensions: [
        { id: 'architect', state: 'secure', score: 100, evidence_count: 1, evidence_question_ids: ['Q1'] },
        { id: 'dreamer', state: 'secure', score: 100, evidence_count: 4, evidence_question_ids: ['Q2'] },
      ],
    });

    expect(dna.identity.label).toBe('The Architect');
    expect(dna.dimensions.map((dimension) => dimension.id)).toEqual(LEARNING_MODES.map((mode) => mode.id));
    expect(dna.dimensions.find((dimension) => dimension.id === 'architect')).toMatchObject({
      state: 'developing', evidence_count: 1,
    });
    expect(dna.dimensions.find((dimension) => dimension.id === 'bridgebuilder')).toMatchObject({ state: 'not_observed' });
  });

  it('handles null input', () => {
    expect(normalizeLearnerDna(null)).toBeNull();
    expect(normalizeLearnerDna(undefined)).toBeNull();
  });

  it('handles empty dimensions gracefully', () => {
    const dna = normalizeLearnerDna({ dimensions: [] });
    expect(dna.dimensions).toHaveLength(LEARNING_MODES.length);
    expect(dna.dimensions.every((dim) => dim.state === 'not_observed')).toBe(true);
    expect(dna.identity.label).toBe('Current learning snapshot');
  });

  it('falls back when given an unknown mode_id', () => {
    const dna = normalizeLearnerDna({
      primary_mode: { mode_id: 'nonexistent_mode' },
      dimensions: [{ id: 'pathfinder', state: 'secure', evidence_count: 2 }]
    });
    expect(dna.primary_mode.mode_id).toBe('pathfinder');
    expect(dna.identity.label).toBe('The Pathfinder - Problem interpretation and method selection');
  });

  it('forces schema_version to 2 even for future schema versions', () => {
    const dna = normalizeLearnerDna({ schema_version: 99 });
    expect(dna.schema_version).toBe(2);
  });
});
