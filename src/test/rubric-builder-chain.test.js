/* global process */
// Rubric builder: DeepSeek on DeepInfra first, DeepSeek on Phala as the fallback,
// DashScope (Qwen) no longer used. DashScope and Phala were both out of credit on
// 22 Oct 2026 and rubric builds had no way to reach DeepInfra.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestRubricPackage, rubricModelChain, shouldTryNextProvider } from '../../apps/processing-worker/rubricBuild.js';

const KEYS = ['DEEPINFRA_API_KEY', 'DEEPINFRA_BASE_URL', 'DEEPINFRA_REASONING_MODEL', 'DEEPINFRA_RUBRIC_MODEL', 'PHALA_API_KEY', 'PHALA_BASE_URL', 'PHALA_DEEPSEEK_MODEL', 'DEEPSEEK_API_KEY', 'DASHSCOPE_API_KEY', 'QWEN_API_KEY'];
const saved = {};
const ok = (model) => ({ ok: true, status: 200, json: async () => ({ model, choices: [{ message: { content: '{"exam":{},"questions":[{"number":"Q1"}]}' } }] }) });
const fail = (status, message) => ({ ok: false, status, json: async () => ({ error: { message } }) });

describe('rubric builder chain', () => {
  let fetchMock;
  beforeEach(() => {
    for (const key of KEYS) { saved[key] = process.env[key]; delete process.env[key]; }
    Object.assign(process.env, {
      DEEPINFRA_API_KEY: 'di', DEEPINFRA_REASONING_MODEL: 'deepseek-ai/DeepSeek-V4.1-Flash',
      PHALA_API_KEY: 'ph', PHALA_BASE_URL: 'https://phala.example/v1', PHALA_DEEPSEEK_MODEL: 'deepseek/deepseek-v4-flash-0731',
      DASHSCOPE_API_KEY: 'ds',
    });
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals(); vi.restoreAllMocks();
    for (const key of KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  });

  it('is DeepInfra DeepSeek, then Phala DeepSeek, with no DashScope', () => {
    expect(rubricModelChain().map((p) => [p.provider, p.model])).toEqual([
      ['deepinfra', 'deepseek-ai/DeepSeek-V4.1-Flash'],
      ['phala', 'deepseek/deepseek-v4-flash-0731'],
    ]);
    process.env.DEEPINFRA_RUBRIC_MODEL = 'deepseek-ai/DeepSeek-V4.2';
    expect(rubricModelChain()[0].model).toBe('deepseek-ai/DeepSeek-V4.2');
  });

  it('builds with DeepInfra and never calls DashScope', async () => {
    fetchMock.mockResolvedValueOnce(ok('deepseek-ai/DeepSeek-V4.1-Flash'));
    const result = await requestRubricPackage('prompt', { testId: 't1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toMatch(/api\.deepinfra\.com/);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe('deepseek-ai/DeepSeek-V4.1-Flash');
    expect(result).toMatchObject({ model: 'deepseek-ai/DeepSeek-V4.1-Flash', parsed: { questions: [{ number: 'Q1' }] } });
  });

  it('falls back to Phala when DeepInfra is out of credit or down', async () => {
    fetchMock.mockResolvedValueOnce(fail(402, 'You need positive balance to do inference')).mockResolvedValueOnce(ok('deepseek/deepseek-v4-flash-0731'));
    const result = await requestRubricPackage('prompt');
    expect(fetchMock.mock.calls[1][0]).toBe('https://phala.example/v1/chat/completions');
    expect(result.model).toBe('deepseek/deepseek-v4-flash-0731');
    fetchMock.mockResolvedValueOnce(fail(503, 'Service unavailable')).mockResolvedValueOnce(ok('deepseek/deepseek-v4-flash-0731'));
    expect((await requestRubricPackage('prompt')).model).toBe('deepseek/deepseek-v4-flash-0731');
  });

  it('does not hide a bad request behind the fallback, and reports when every provider fails', async () => {
    fetchMock.mockResolvedValueOnce(fail(400, 'Invalid request: max_tokens too large'));
    await expect(requestRubricPackage('prompt')).rejects.toThrow('Invalid request');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValueOnce(fail(402, 'You need positive balance')).mockResolvedValueOnce(fail(402, 'Account quota exceeded. Please add credits to continue.'));
    await expect(requestRubricPackage('prompt')).rejects.toThrow('Account quota exceeded');
  });

  it('knows which failures are worth the next provider', () => {
    expect(shouldTryNextProvider(Object.assign(new Error('Rate limit exceeded'), { status: 429 }))).toBe(true);
    expect(shouldTryNextProvider(new Error('fetch failed'))).toBe(true);
    expect(shouldTryNextProvider(Object.assign(new Error('Bad input'), { status: 400 }))).toBe(false);
  });
});
