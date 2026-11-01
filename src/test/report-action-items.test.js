import { describe, expect, it } from 'vitest';
import {
  backfillReportActionItems,
  normalizeRecommendation,
  normalizeRecommendations,
  normalizeStrategies,
  normalizeStrategy,
} from '../../shared/reportActionItems.js';
import { createStudentReportView } from '../lib/reportViewModel';

describe('report action items', () => {
  it('normalizes canonical strategy and recommendation objects', () => {
    expect(normalizeStrategy({ topic: 'Tenses', strategy: 'Drill past perfect.' })).toEqual({
      topic: 'Tenses',
      strategy: 'Drill past perfect.',
    });
    expect(normalizeRecommendation({ topic: 'Prepositions', action: 'Practice collocations.', priority: 'critical' })).toEqual({
      topic: 'Prepositions',
      action: 'Practice collocations.',
      priority: 'critical',
    });
  });

  it('coerces legacy string action items into canonical objects', () => {
    expect(normalizeStrategy('For Q2(a), state the method first.')).toMatchObject({
      topic: expect.any(String),
      strategy: 'For Q2(a), state the method first.',
    });
    expect(normalizeRecommendation('Review past perfect tense formation.')).toMatchObject({
      topic: expect.any(String),
      action: 'Review past perfect tense formation.',
      priority: 'important',
    });
  });

  it('maps legacy title fields onto topic', () => {
    expect(normalizeStrategy({ title: 'Simplification', strategy: 'Use GCD.' }).topic).toBe('Simplification');
    expect(normalizeRecommendation({ title: 'Verb forms', action: 'Rewrite Q2.' }).topic).toBe('Verb forms');
  });

  it('backfills string-shaped report payloads in place', () => {
    const { payload, changed } = backfillReportActionItems({
      term1: {
        subjects: [{
          name: 'English',
          recommendations: ['Practice irregular verbs.'],
          learning_profile: {
            strategies: ['Use flashcards for prepositions.'],
          },
        }],
      },
    });

    expect(changed).toBe(true);
    expect(payload.term1.subjects[0].recommendations[0]).toMatchObject({
      action: 'Practice irregular verbs.',
      priority: 'important',
    });
    expect(payload.term1.subjects[0].learning_profile.strategies[0]).toMatchObject({
      strategy: 'Use flashcards for prepositions.',
    });
  });

  it('leaves already-canonical payloads unchanged', () => {
    const input = {
      term1: {
        subjects: [{
          recommendations: [{ topic: 'A', action: 'B', priority: 'important' }],
          learning_profile: { strategies: [{ topic: 'C', strategy: 'D' }] },
        }],
      },
    };
    const { changed } = backfillReportActionItems(input);
    expect(changed).toBe(false);
  });

  it('exposes normalized strategies through the student report view model', () => {
    const view = createStudentReportView({
      subjects: [{
        name: 'English',
        recommendations: ['Practice prepositions in context.'],
        learning_profile: {
          core_strength: 'Strong email structure.',
          strategies: ['Create flashcards for verb forms.'],
        },
      }],
    });

    expect(view.subjects[0].learning_profile.strategies[0]).toMatchObject({
      strategy: 'Create flashcards for verb forms.',
    });
    expect(view.subjects[0].recommendations[0]).toMatchObject({
      action: 'Practice prepositions in context.',
      priority: 'important',
    });
    expect(view.subjects[0].nextAction.action).toBe('Practice prepositions in context.');
  });

  it('keeps list helpers bounded', () => {
    expect(normalizeStrategies(['a', 'b', 'c', 'd', 'e'])).toHaveLength(4);
    expect(normalizeRecommendations(['a', 'b', 'c', 'd', 'e'])).toHaveLength(4);
  });
});
