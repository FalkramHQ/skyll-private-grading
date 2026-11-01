import { describe, expect, it } from 'vitest';
import { TEST_STATES, assessmentStateLabel, projectAssessmentLifecycle } from '../../shared/workflowLifecycle.js';

const completeAssets = { questionPaper: true, answerKey: true, answerSheets: 1 };

describe('assessment lifecycle projection', () => {
  it('keeps the documented assessment vocabulary complete', () => {
    expect(TEST_STATES).toEqual([
      'draft', 'uploading', 'ready_to_process', 'queued', 'processing',
      'rubric_ready_for_review', 'ready_for_review', 'published', 'needs_attention', 'cancelled',
    ]);
  });

  it.each([
    [{ testStatus: 'draft' }, 'draft', 'Continue setup'],
    [{ testStatus: 'uploading', assets: { pendingUploads: 1 } }, 'uploading', 'Continue uploads'],
    [{ assets: completeAssets }, 'ready_to_process', 'Start processing'],
    [{ assets: completeAssets, job: { status: 'queued', type: 'mistral_ocr' } }, 'queued', 'Refresh status'],
    [{ assets: completeAssets, job: { status: 'running', type: 'mistral_ocr' } }, 'processing', 'Refresh status'],
    [{ testStatus: 'rubric_ready_for_review', assets: completeAssets }, 'rubric_ready_for_review', 'Review rubric'],
    [{ testStatus: 'ready_for_review' }, 'ready_for_review', 'Open review'],
    [{ publication: { complete: true, publishedAt: '2026-07-24T10:00:00.000Z' } }, 'published', null],
    [{ cancelled: true }, 'cancelled', null],
  ])('maps evidence to %s', (input, state, actionLabel) => {
    const result = projectAssessmentLifecycle(input);
    expect(result.state).toBe(state);
    expect(result.label).toBe(assessmentStateLabel(state));
    expect(result.action?.label || null).toBe(actionLabel);
    expect(result.explanation).toBeTruthy();
  });

  it('keeps a scheduled retry queued instead of showing a false failure', () => {
    const result = projectAssessmentLifecycle({
      testStatus: 'ocr_failed',
      job: { status: 'queued', type: 'mistral_ocr', nextAttemptAt: '2026-07-24T10:05:00.000Z' },
    });
    expect(result).toMatchObject({
      state: 'queued',
      retryScheduledAt: '2026-07-24T10:05:00.000Z',
    });
    expect(result.explanation).toContain('automatic retry');
  });

  it('maps failed OCR to a safe retry action without exposing raw worker error text', () => {
    const result = projectAssessmentLifecycle({
      testStatus: 'ocr_failed',
      job: {
        status: 'failed_retryable',
        type: 'mistral_ocr',
        lastErrorCode: 'worker_lease_expired',
        error: 'internal endpoint https://secret.example/token',
      },
    });
    expect(result).toMatchObject({
      state: 'needs_attention',
      action: { id: 'retry_ocr', label: 'Retry OCR' },
      attention: {
        code: 'worker_lease_expired',
        retrySupported: true,
      },
    });
    expect(result.attention.summary).toContain('worker stopped');
    expect(JSON.stringify(result)).not.toContain('secret.example');
  });

  it('requires escalation instead of inventing a retry for failed downstream work', () => {
    const result = projectAssessmentLifecycle({
      job: { status: 'failed_retryable', type: 'build_reports', lastErrorCode: 'upstream_error' },
    });
    expect(result).toMatchObject({
      state: 'needs_attention',
      action: { id: 'escalate', label: 'Contact operations' },
      attention: { retrySupported: false, code: 'upstream_error' },
    });
  });

  it('uses deterministic evidence precedence to avoid contradictory labels', () => {
    expect(projectAssessmentLifecycle({
      testStatus: 'processing_failed',
      job: { status: 'failed_retryable', type: 'mistral_ocr' },
      publication: { complete: true },
    }).state).toBe('published');

    expect(projectAssessmentLifecycle({
      testStatus: 'ready_for_review',
      job: { status: 'running', type: 'build_reports' },
    }).state).toBe('processing');

    expect(projectAssessmentLifecycle({
      cancelled: true,
      publication: { complete: true },
    }).state).toBe('cancelled');
  });
});
