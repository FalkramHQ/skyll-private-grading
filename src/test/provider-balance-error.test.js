import { describe, expect, it } from 'vitest';
import { isProviderBalanceError } from '../../apps/processing-worker/llmGateway.js';

describe('isProviderBalanceError', () => {
  it('recognises both DashScope quota wordings, so the rubric build falls back to DeepSeek', () => {
    expect(isProviderBalanceError('The free quota has been exhausted. To continue accessing the model on a paid basis, please complete your payment information')).toBe(true);
    expect(isProviderBalanceError('Free quota exhausted. To continue accessing the model on a paid basis, please add funds or disable the "use free tier only" mode in the management console.')).toBe(true);
  });

  it('recognises DeepInfra and Phala empty-account messages', () => {
    expect(isProviderBalanceError('You need positive balance to do inference. Please add balance manually or setup top-up')).toBe(true);
    expect(isProviderBalanceError('Account quota exceeded. Please add credits to continue.')).toBe(true);
    expect(isProviderBalanceError('Insufficient account balance')).toBe(true);
  });

  it('still recognises the other balance errors and nothing else', () => {
    expect(isProviderBalanceError('Insufficient Balance')).toBe(true);
    expect(isProviderBalanceError('HTTP 402 Payment Required')).toBe(true);
    expect(isProviderBalanceError('Rubric package has placeholder question text for Q4(iii).')).toBe(false);
    expect(isProviderBalanceError('Request timed out')).toBe(false);
  });
});
