// @vitest-environment node
// Once a school is opted in, every model call must be routed by whose data it carries.
import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ sessionForRequest: vi.fn(), database: vi.fn(() => ({ execute: vi.fn() })) }));
vi.mock('../../api/_lib/auth.js', () => auth);

const { callJsonModel } = await import('../../api/_lib/llmGateway.js');
const { inferenceContextForUser, withRequestInferenceContext } = await import('../../api/_lib/privateInferenceRequest.js');
const { nearPrivateEnabledForCurrentJob, runWithInferenceContext } = await import('../../apps/processing-worker/inferenceContext.js');
const { requestRubricPackage } = await import('../../apps/processing-worker/rubricBuild.js');
const { callDeepinfraModelJson } = await import('../../apps/processing-worker/llmGateway.js');

const saved = { ...process.env };
beforeEach(() => {
  process.env.NEAR_AI_API_KEY = 'sk-test';
  process.env.NEAR_AI_SCHOOLS = 'Private School, sch_private';
  process.env.DEEPINFRA_API_KEY = 'di-test';
  process.env.DEEPSEEK_API_KEY = 'ds-test';
  auth.sessionForRequest.mockReset();
});
afterEach(() => {
  process.env = { ...saved };
  vi.unstubAllGlobals();
});

// Fails every NEAR call at attestation and records where each request went.
function stubFetch() {
  const urls = [];
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ error: { message: 'stopped by test' } }), { status: 500 });
  }));
  return urls;
}
const outside = (urls) => urls.filter((url) => !url.startsWith('https://cloud-api.near.ai/'));

describe('private inference routing', () => {
  it('refuses a model call with no context once a school is opted in', async () => {
    const urls = stubFetch();
    await expect(callJsonModel({ prompt: 'x', attempts: 1 })).rejects.toThrow(/without an inference context/);
    expect(urls).toEqual([]);
  });

  it('leaves calls alone when no school is opted in', async () => {
    process.env.NEAR_AI_SCHOOLS = '';
    const urls = stubFetch();
    await expect(callJsonModel({ prompt: 'x', attempts: 1, retryDelayMs: 0 })).rejects.toThrow();
    expect(urls.length).toBeGreaterThan(0);
    expect(outside(urls).length).toBe(urls.length);
  });

  it('sends an opted-in school only to NEAR AI, and a failure never falls back', async () => {
    const urls = stubFetch();
    await expect(runWithInferenceContext({ school: 'Private School' }, () => callJsonModel({ prompt: 'x', attempts: 1, retryDelayMs: 0 })))
      .rejects.toThrow();
    expect(urls.length).toBeGreaterThan(0);
    expect(outside(urls)).toEqual([]);
  });

  it('matches a school by canonical id when its name is an old spelling', () => {
    const enabled = runWithInferenceContext({ school: 'Old Spelling', schoolId: 'sch_private' }, () => nearPrivateEnabledForCurrentJob());
    expect(enabled).toBe(true);
  });

  it('keeps the rubric build and the key check on NEAR AI', async () => {
    const urls = stubFetch();
    const context = { school: 'Private School' };
    await expect(runWithInferenceContext(context, () => requestRubricPackage('build it'))).rejects.toThrow();
    await expect(runWithInferenceContext(context, () => callDeepinfraModelJson('Qwen/Qwen3.8-Flash', 'check it'))).rejects.toThrow();
    expect(urls.length).toBeGreaterThan(0);
    expect(outside(urls)).toEqual([]);
  });

  it('gives a request its user\'s school, and platform staff the private path', async () => {
    auth.sessionForRequest.mockResolvedValue({ school: 'Private School', school_id: 'sch_private', role: 'teacher' });
    const teacher = await withRequestInferenceContext({}, 'ai:tutor', async () => nearPrivateEnabledForCurrentJob());
    expect(teacher).toBe(true);

    auth.sessionForRequest.mockResolvedValue({ school: 'Another School', school_id: 'sch_other', role: 'teacher' });
    const other = await withRequestInferenceContext({}, 'ai:tutor', async () => nearPrivateEnabledForCurrentJob());
    expect(other).toBe(false);

    const staff = runWithInferenceContext(inferenceContextForUser({ role: 'skyll_admin' }, 'ai:tutor'), () => nearPrivateEnabledForCurrentJob());
    expect(staff).toBe(true);
  });

  it('keeps platform staff on the normal path until a school is opted in', () => {
    process.env.NEAR_AI_SCHOOLS = '';
    const staff = runWithInferenceContext(inferenceContextForUser({ role: 'skyll_admin' }, 'query'), () => nearPrivateEnabledForCurrentJob());
    expect(staff).toBe(false);
  });

  it('skips the session lookup entirely when no school is opted in', async () => {
    process.env.NEAR_AI_SCHOOLS = '';
    await withRequestInferenceContext({}, 'ai:tutor', async () => 'ran');
    expect(auth.sessionForRequest).not.toHaveBeenCalled();
  });
});
