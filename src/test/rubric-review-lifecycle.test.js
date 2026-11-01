import { describe, expect, it } from 'vitest';
import {
  isAwaitingRubricReview,
  projectAssessmentLifecycle,
} from '../../shared/workflowLifecycle.js';
import { normalizeVisualRequirements } from '../../api/_lib/rubricReviewService.js';
import { DEFAULT_VISUAL_REQUIREMENT } from '../../shared/visualRequirements.js';

describe('rubric review lifecycle gate', () => {
  it('treats rubric_ready_for_review and legacy rubric_complete as awaiting review', () => {
    expect(isAwaitingRubricReview('rubric_ready_for_review')).toBe(true);
    expect(isAwaitingRubricReview('rubric_complete')).toBe(true);
    expect(isAwaitingRubricReview('ready_for_review')).toBe(false);
    expect(isAwaitingRubricReview('evidence_queued')).toBe(false);
  });

  it('projects the review-rubric action while parked after rubric generation', () => {
    const lifecycle = projectAssessmentLifecycle({
      testStatus: 'rubric_ready_for_review',
      assets: { questionPaper: true, answerKey: true, answerSheets: 12 },
    });
    expect(lifecycle.state).toBe('rubric_ready_for_review');
    expect(lifecycle.action?.id).toBe('open_rubric_review');
    expect(lifecycle.label).toMatch(/rubric/i);
  });

  it('does not collapse rubric review into ready_to_process when assets exist', () => {
    const lifecycle = projectAssessmentLifecycle({
      testStatus: 'rubric_complete',
      assets: { questionPaper: true, answerKey: true, answerSheets: 3 },
    });
    expect(lifecycle.state).toBe('rubric_ready_for_review');
  });

  it('normalizes visual requirement toggles for VL gating', () => {
    expect(normalizeVisualRequirements(null)).toBeNull();
    expect(normalizeVisualRequirements('')).toBeNull();
    expect(normalizeVisualRequirements('   ')).toBeNull();
    expect(normalizeVisualRequirements(false)).toBeNull();
    expect(normalizeVisualRequirements(true)).toBe(DEFAULT_VISUAL_REQUIREMENT);
    expect(normalizeVisualRequirements('Wheatstone bridge circuit with labelled arms'))
      .toBe('Wheatstone bridge circuit with labelled arms');
  });
});
