/* global Buffer */
import { describe, expect, it, vi } from 'vitest';
import { isRetryableDatalabStatus, ocrWithDatalab, resolveOcrEngine, retryDelayMs } from '../../apps/processing-worker/datalabOcr.js';

describe('Datalab OCR client', () => {
  it('defaults the worker OCR engine to datalab', () => {
    expect(resolveOcrEngine({})).toBe('datalab');
    expect(resolveOcrEngine({ OCR_ENGINE: 'Mistral' })).toBe('mistral');
    expect(resolveOcrEngine({ OCR_ENGINE: 'datalab' })).toBe('datalab');
  });

  it('retries Datalab rate limits and 5xx', () => {
    expect(isRetryableDatalabStatus(429)).toBe(true);
    expect(isRetryableDatalabStatus(503)).toBe(true);
    expect(isRetryableDatalabStatus(400)).toBe(false);
  });

  it('submits a file and returns markdown when the poll completes', async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      if (String(url).endsWith('/convert')) {
        expect(init.headers['X-API-Key']).toBe('key');
        return { ok: true, status: 200, json: async () => ({ request_id: 'req_1', request_check_url: 'https://www.datalab.to/api/v1/convert/req_1' }) };
      }
      return { ok: true, status: 200, json: async () => ({ status: 'complete', markdown: '# Q1', page_count: 1 }) };
    });
    const result = await ocrWithDatalab({
      buffer: Buffer.from('pdf'),
      filename: 'question_paper.pdf',
      mimeType: 'application/pdf',
      apiKey: 'key',
      mode: 'accurate',
      fetchImpl,
      pollMs: 0,
      wait: (fn) => fn(),
    });
    expect(result.markdown).toBe('# Q1');
    expect(result.model).toBe('datalab-accurate');
    expect(result.pageCount).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('marks upload 429 as retryable', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 429,
      json: async () => ({ error: 'Rate limit exceeded' }),
    }));
    await expect(ocrWithDatalab({
      buffer: Buffer.from('x'),
      filename: 'page.jpg',
      mimeType: 'image/jpeg',
      apiKey: 'key',
      fetchImpl,
      submitRetries: 0,
    })).rejects.toMatchObject({ message: 'Rate limit exceeded', retryable: true, status: 429 });
  });
});

describe('Datalab upload backoff', () => {
  it('retries a rate-limited upload after Retry-After and then succeeds', async () => {
    const waits = [];
    let uploads = 0;
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).endsWith('/convert')) {
        uploads += 1;
        if (uploads === 1) {
          return { ok: false, status: 429, headers: { get: (k) => (k === 'retry-after' ? '7' : null) }, json: async () => ({ error: 'Rate limit exceeded' }) };
        }
        return { ok: true, status: 200, json: async () => ({ request_id: 'req_2', request_check_url: 'https://www.datalab.to/api/v1/convert/req_2' }) };
      }
      return { ok: true, status: 200, json: async () => ({ status: 'complete', markdown: '# Q1', page_count: 1 }) };
    });
    const result = await ocrWithDatalab({
      buffer: Buffer.from('pdf'),
      filename: 'sheet.pdf',
      mimeType: 'application/pdf',
      apiKey: 'key',
      fetchImpl,
      pollMs: 0,
      wait: (fn, ms) => { waits.push(ms); fn(); },
    });
    expect(result.markdown).toBe('# Q1');
    expect(uploads).toBe(2);
    expect(waits[0]).toBe(7000);
  });

  it('gives up after the retry budget and keeps the error retryable', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 429, headers: { get: () => null }, json: async () => ({ error: 'Rate limit exceeded' }) }));
    await expect(ocrWithDatalab({
      buffer: Buffer.from('x'), filename: 'page.jpg', mimeType: 'image/jpeg', apiKey: 'key', fetchImpl,
      submitRetries: 2, submitBackoffMs: 1, wait: (fn) => fn(),
    })).rejects.toMatchObject({ message: 'Rate limit exceeded', retryable: true, status: 429 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('uses exponential backoff when Retry-After is absent, capped at a minute', () => {
    const none = { headers: { get: () => null } };
    expect(retryDelayMs(none, 0, 5000)).toBe(5000);
    expect(retryDelayMs(none, 1, 5000)).toBe(10000);
    expect(retryDelayMs(none, 5, 5000)).toBe(60000);
    expect(retryDelayMs({ headers: { get: () => '120' } }, 0)).toBe(60000);
  });
});
