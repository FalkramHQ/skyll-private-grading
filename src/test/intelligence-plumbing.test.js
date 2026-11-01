/* global process */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isRateLimited, resetRateLimitBuckets } from '../../api/_lib/aiRateLimit.js';
import { buildCohortContext, buildStudentContext } from '../../api/_lib/contextBuilder.js';
import { callJsonModel, jsonFromModel } from '../../api/_lib/llmGateway.js';

describe('intelligence shared plumbing', () => {
  afterEach(() => {
    resetRateLimitBuckets();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('rate-limits after the sliding window fills', () => {
    expect(isRateLimited('user_a', { max: 2, windowMs: 60_000 })).toBe(false);
    expect(isRateLimited('user_a', { max: 2, windowMs: 60_000 })).toBe(false);
    expect(isRateLimited('user_a', { max: 2, windowMs: 60_000 })).toBe(true);
    expect(isRateLimited('user_b', { max: 2, windowMs: 60_000 })).toBe(false);
  });

  it('parses fenced JSON from model output', () => {
    expect(jsonFromModel('```json\n{"ok":true}\n```')).toEqual({ ok: true });
  });

  it('retries transient LLM failures then returns JSON', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        json: async () => ({ error: { message: 'rate limited' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          model: 'deepseek-chat',
          usage: { total_tokens: 12 },
          choices: [{ message: { content: '{"answer":"yes"}' } }],
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const result = await callJsonModel({
      prompt: 'Return {"answer":"yes"}',
      apiKey: 'test-key',
      attempts: 3,
      retryDelayMs: 0,
    });

    expect(result).toEqual({
      result: { answer: 'yes' },
      model: 'deepseek-chat',
      usage: { total_tokens: 12 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('falls back to DeepInfra after a DeepSeek balance error', async () => {
    const previous = {
      key: process.env.DEEPINFRA_API_KEY,
      url: process.env.DEEPINFRA_BASE_URL,
      model: process.env.DEEPINFRA_REASONING_MODEL,
    };
    process.env.DEEPINFRA_API_KEY = 'di-key';
    process.env.DEEPINFRA_BASE_URL = 'https://api.deepinfra.com/v1/openai';
    process.env.DEEPINFRA_REASONING_MODEL = 'deepseek-ai/DeepSeek-V3.2';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 402,
        json: async () => ({ error: { message: 'Insufficient Balance' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          model: 'deepseek-ai/DeepSeek-V3.2',
          usage: { total_tokens: 9 },
          choices: [{ message: { content: '{"ok":true}' } }],
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const result = await callJsonModel({
        prompt: 'Return {"ok":true}',
        apiKey: 'deepseek-key',
        baseUrl: 'https://api.deepseek.com/chat/completions',
        model: 'deepseek-v4-flash',
        attempts: 1,
        retryDelayMs: 0,
      });

      expect(result.result).toEqual({ ok: true });
      expect(result.model).toBe('deepseek-ai/DeepSeek-V3.2');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1][0]).toBe('https://api.deepinfra.com/v1/openai/chat/completions');
    } finally {
      process.env.DEEPINFRA_API_KEY = previous.key;
      process.env.DEEPINFRA_BASE_URL = previous.url;
      process.env.DEEPINFRA_REASONING_MODEL = previous.model;
    }
  });

  it('uses DeepInfra V4.1-Flash first when no endpoint is pinned', async () => {
    const previous = {
      key: process.env.DEEPINFRA_API_KEY,
      url: process.env.DEEPINFRA_BASE_URL,
      model: process.env.DEEPINFRA_REASONING_MODEL,
      deepseek: process.env.DEEPSEEK_API_KEY,
    };
    process.env.DEEPINFRA_API_KEY = 'di-key';
    process.env.DEEPINFRA_BASE_URL = 'https://api.deepinfra.com/v1/openai';
    process.env.DEEPINFRA_REASONING_MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash';
    process.env.DEEPSEEK_API_KEY = 'deepseek-key';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        model: 'deepseek-ai/DeepSeek-V4.1-Flash',
        usage: { total_tokens: 4 },
        choices: [{ message: { content: '{"ok":true}' } }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await callJsonModel({ prompt: 'Return {"ok":true}', attempts: 1, retryDelayMs: 0 });
      expect(result.model).toBe('deepseek-ai/DeepSeek-V4.1-Flash');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe('https://api.deepinfra.com/v1/openai/chat/completions');
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe('deepseek-ai/DeepSeek-V4.1-Flash');
    } finally {
      process.env.DEEPINFRA_API_KEY = previous.key;
      process.env.DEEPINFRA_BASE_URL = previous.url;
      process.env.DEEPINFRA_REASONING_MODEL = previous.model;
      process.env.DEEPSEEK_API_KEY = previous.deepseek;
    }
  });

  it('builds empty typed context shells with school scoping required', async () => {
    const db = {
      execute: vi.fn(async () => ({ rows: [] })),
    };
    await expect(buildStudentContext(db, {})).rejects.toThrow(/schoolId/);
    await expect(buildCohortContext(db, {})).rejects.toThrow(/schoolId/);

    // A student that does not resolve inside the school yields an empty shell,
    // never the caller's identifiers echoed back for unscoped reads (FLKRM-382).
    await expect(buildStudentContext(db, { schoolId: 'school_1', studentId: 'st_1' })).resolves.toEqual({
      studentId: '',
      schoolId: 'school_1',
      username: undefined,
      name: null,
      className: null,
      school: null,
      resolved: false,
      dna: null,
      examCount: 0,
      questionCount: 0,
      dnaUpdatedAt: null,
      recentReports: [],
      signals: [],
      synthesisRuns: [],
      mastery: [],
    });

    await expect(buildCohortContext(db, { schoolId: 'school_1', examId: 'exam_1' })).resolves.toEqual({
      schoolId: 'school_1',
      schoolName: null,
      examId: 'exam_1',
      testId: '',
      className: null,
      subject: null,
      overview: {
        publishedReports: 0,
        studentsWithReports: 0,
        latestPublishedAt: null,
        activeSignals: 0,
        dnaProfiles: 0,
        primaryModes: [],
      },
      hotspots: [],
      curriculumTopics: [],
    });
  });
});

describe('callJsonModel truncation handling', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('retries with a larger max_tokens when the model output was cut off', async () => {
    const bodies = [];
    const fetchMock = vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      if (bodies.length === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            model: 'deepseek-chat',
            choices: [{ finish_reason: 'length', message: { content: '{"answer":"this string never clo' } }],
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'deepseek-chat',
          choices: [{ finish_reason: 'stop', message: { content: '{"answer":"complete"}' } }],
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await callJsonModel({
      prompt: 'Return a long answer',
      apiKey: 'test-key',
      baseUrl: 'https://example.test/chat',
      maxTokens: 2200,
      attempts: 3,
      retryDelayMs: 0,
    });

    expect(result.result).toEqual({ answer: 'complete' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodies[0].max_tokens).toBe(2200);
    expect(bodies[1].max_tokens).toBeGreaterThan(2200);
    expect(bodies[1].messages[1].content).toContain('cut off');
  });

  it('surfaces a truncation error instead of a JSON parse error when every attempt is cut off', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        model: 'deepseek-chat',
        choices: [{ finish_reason: 'length', message: { content: '{"answer":"never' } }],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(callJsonModel({
      prompt: 'Return a long answer',
      apiKey: 'test-key',
      baseUrl: 'https://example.test/chat',
      maxTokens: 1000,
      attempts: 2,
      retryDelayMs: 0,
    })).rejects.toThrow(/truncated/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
