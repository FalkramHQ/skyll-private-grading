// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { OCR_ASSETS_FAILED_CODE, assetFailureIsRetryable, decideOcrOutcome } from '../../apps/processing-worker/ocrOutcome.js';

describe('OCR job outcome (no silent student loss)', () => {
  it('succeeds when every asset was processed or reused', () => {
    const outcome = decideOcrOutcome({ processed: 3, reused: 2, totalAssets: 5 });
    expect(outcome.ok).toBe(true);
    expect(outcome.error).toBeNull();
    expect(outcome.code).toBeNull();
    expect(outcome.stepDetail).toBe('3 file(s) processed; 2 unchanged artifact(s) reused');
    expect(outcome.result).toEqual({ processedAssets: 3, reusedAssets: 2, totalAssets: 5, failedAssets: [] });
  });

  it('fails the job when an answer sheet failed, even though the required sources succeeded', () => {
    const outcome = decideOcrOutcome({
      processed: 4, reused: 0, totalAssets: 5,
      failedOptional: [{ id: 'asset_9', kind: 'answer_sheet', student: 'Asha', reason: 'Datalab OCR failed (503)', retryable: true }],
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe(OCR_ASSETS_FAILED_CODE);
    expect(outcome.error).toContain('1 of 5 asset(s)');
    expect(outcome.error).toContain('Asha answer_sheet (asset_9): Datalab OCR failed (503)');
    expect(outcome.stepDetail).toContain('FAILED 1: Asha answer_sheet asset_9');
    expect(outcome.result.failedAssets).toEqual([{ id: 'asset_9', kind: 'answer_sheet', student: 'Asha', reason: 'Datalab OCR failed (503)' }]);
  });

  it('is retryable only when every failed asset is retryable', () => {
    const retryable = decideOcrOutcome({
      totalAssets: 3,
      failedOptional: [
        { id: 'a', kind: 'answer_sheet', reason: 'timeout', retryable: true },
        { id: 'b', kind: 'answer_sheet', reason: 'unknown engine error' }, // no flag => retried
      ],
    });
    expect(retryable.retryable).toBe(true);

    const permanent = decideOcrOutcome({
      totalAssets: 3,
      failedOptional: [
        { id: 'a', kind: 'answer_sheet', reason: 'timeout', retryable: true },
        { id: 'b', kind: 'answer_sheet', reason: 'Unsupported file type', retryable: false },
      ],
    });
    expect(permanent.retryable).toBe(false);
  });

  it('treats an unflagged failure as retryable and an explicit false as permanent', () => {
    expect(assetFailureIsRetryable({})).toBe(true);
    expect(assetFailureIsRetryable({ retryable: undefined })).toBe(true);
    expect(assetFailureIsRetryable({ retryable: true })).toBe(true);
    expect(assetFailureIsRetryable({ retryable: false })).toBe(false);
  });

  it('names required-source failures and counts them separately', () => {
    const outcome = decideOcrOutcome({
      processed: 1, totalAssets: 3,
      failedRequired: [{ id: 'qp', kind: 'question_paper', reason: 'OCR returned no readable content', retryable: true }],
      failedOptional: [{ id: 'as', kind: 'answer_sheet', student: 'Ravi', reason: 'Failed to download OCR source (403)', retryable: true }],
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('2 of 3 asset(s) (1 required source)');
    expect(outcome.error).toContain('question_paper (qp)');
    expect(outcome.error).toContain('Ravi answer_sheet (as)');
    expect(outcome.failedAssets.map((asset) => asset.id)).toEqual(['qp', 'as']);
  });

  it('caps the number of named assets in the error text but keeps every failure in the result', () => {
    const failedOptional = Array.from({ length: 20 }, (_, index) => ({ id: `asset_${index}`, kind: 'answer_sheet', reason: 'Rate limit exceeded', retryable: true }));
    const outcome = decideOcrOutcome({ totalAssets: 21, processed: 1, failedOptional });
    expect(outcome.error).toContain('and 8 more');
    expect(outcome.result.failedAssets).toHaveLength(20);
    expect(outcome.retryable).toBe(true);
  });
});
