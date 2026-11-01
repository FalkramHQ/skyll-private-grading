import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VISUAL_REQUIREMENT,
  suggestVisualRequirements,
  withSuggestedVisualRequirements,
} from '../../shared/visualRequirements.js';

describe('visualRequirements heuristics', () => {
  it('leaves pure text questions alone', () => {
    expect(suggestVisualRequirements({
      expected_response_type: 'long_answer',
      question_text: 'State Ohm\'s law and define resistance.',
      marking_rubric: '1 mark definition, 1 mark formula',
    })).toBeNull();
  });

  it('auto-suggests VL for Wheatstone neat-diagram long answers', () => {
    const suggested = suggestVisualRequirements({
      expected_response_type: 'long_answer',
      question_text: "With the help of neat diagram, describe wheatstone's network and obtain the balanced condition.",
      correct_answer_summary: 'Diagram of Wheatstone bridge. Balanced condition P/Q = R/S.',
      marking_rubric: '1 mark for describing construction. 1 mark for balanced condition.',
    });
    expect(suggested).toMatch(/wheatstone/i);
  });

  it('auto-suggests for diagram response type', () => {
    expect(suggestVisualRequirements({ expected_response_type: 'diagram', question_text: 'Draw X' }))
      .toBe(DEFAULT_VISUAL_REQUIREMENT);
  });

  it('does not overwrite an existing visual_requirements value', () => {
    const q = {
      expected_response_type: 'long_answer',
      question_text: 'With the help of neat diagram, describe wheatstone network.',
      visual_requirements: 'Custom VL note',
    };
    expect(withSuggestedVisualRequirements(q).visual_requirements).toBe('Custom VL note');
  });
});
