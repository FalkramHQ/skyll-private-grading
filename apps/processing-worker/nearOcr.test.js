// @vitest-environment node
import PDFDocument from 'pdfkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UNREAD_REGION_MARKER } from '../../shared/unreadRegion.js';
import { NEAR_OCR_FALLBACK_MODEL, NEAR_OCR_MODEL, NEAR_OCR_PROMPT, ocrWithNearAi, pageImagesFor } from './nearOcr.js';

const reply = (content, finish_reason = 'stop') => ({
  ok: true,
  status: 200,
  body: { choices: [{ message: { content }, finish_reason }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
  receipt: { id: 'pir_1' },
});
const jpeg = Buffer.from([0xff, 0xd8, 0xff]);

function pdfWithPages(count) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4' });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    for (let page = 1; page <= count; page += 1) {
      if (page > 1) doc.addPage();
      doc.text(`Question ${page}`);
    }
    doc.end();
  });
}

describe('ocrWithNearAi', () => {
  const savedKey = process.env.NEAR_AI_API_KEY;
  beforeEach(() => { process.env.NEAR_AI_API_KEY = 'sk-test'; });
  afterEach(() => { process.env.NEAR_AI_API_KEY = savedKey ?? ''; });

  it('tells the model to keep mistakes and uses the conventions extraction understands', () => {
    expect(NEAR_OCR_PROMPT).toMatch(/Never correct/);
    expect(NEAR_OCR_PROMPT).toContain('~~');
    expect(NEAR_OCR_PROMPT).toContain(UNREAD_REGION_MARKER);
  });

  it('sends the attested vision model the image and returns the Datalab result shape', async () => {
    const send = vi.fn(async () => reply('Q.1 x = 8/4 = 2'));
    const result = await ocrWithNearAi({ buffer: jpeg, mimeType: 'image/jpeg', send });
    expect(send.mock.calls[0][0].model).toBe(NEAR_OCR_MODEL);
    expect(send.mock.calls[0][1].messages[0].content[1].image_url.url).toBe(`data:image/jpeg;base64,${jpeg.toString('base64')}`);
    expect(result).toMatchObject({
      markdown: 'Q.1 x = 8/4 = 2',
      pages: [{ index: 0, markdown: 'Q.1 x = 8/4 = 2' }],
      pageCount: 1,
      model: NEAR_OCR_MODEL,
      usage: { prompt_tokens: 10, completion_tokens: 5, receipts: ['pir_1'] },
    });
  });

  it('strips a code fence and treats a blank page as no text', async () => {
    const fenced = await ocrWithNearAi({ buffer: jpeg, mimeType: 'image/jpeg', send: async () => reply('```markdown\nQ.1\n```') });
    expect(fenced.markdown).toBe('Q.1');
    const blank = await ocrWithNearAi({ buffer: jpeg, mimeType: 'image/jpeg', send: async () => reply('[blank page]') });
    expect(blank.markdown).toBe('');
  });

  it('reads a page the vision model loops on with the attested fallback, and keeps no cut-off text', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce(reply('Q.1 Q.1 Q.1', 'length'))
      .mockResolvedValueOnce(reply('<think>reading</think>Q.1 x = 2'));
    const result = await ocrWithNearAi({ buffer: jpeg, mimeType: 'image/jpeg', send });
    expect(send.mock.calls.map(([config]) => config.model)).toEqual([NEAR_OCR_MODEL, NEAR_OCR_FALLBACK_MODEL]);
    expect(result.markdown).toBe('Q.1 x = 2');
    expect(result.usage.fallback_pages).toBe(1);
  });

  it('fails a page both models cut off instead of losing the end of an answer', async () => {
    await expect(ocrWithNearAi({ buffer: jpeg, mimeType: 'image/jpeg', send: async () => reply('Q.1 partial', 'length') }))
      .rejects.toMatchObject({ retryable: true });
  });

  it('retries a provider outage but not a rejected request', async () => {
    await expect(ocrWithNearAi({ buffer: jpeg, mimeType: 'image/jpeg', send: async () => ({ ok: false, status: 503, body: {} }) }))
      .rejects.toMatchObject({ retryable: true, status: 503 });
    await expect(ocrWithNearAi({ buffer: jpeg, mimeType: 'image/jpeg', send: async () => ({ ok: false, status: 400, body: {} }) }))
      .rejects.toMatchObject({ retryable: false, status: 400 });
  });

  it('treats a failed verification as a failed page, never as text', async () => {
    const send = async () => { throw new Error('NEAR AI private inference not verified: bad signature'); };
    await expect(ocrWithNearAi({ buffer: jpeg, mimeType: 'image/jpeg', send })).rejects.toThrow(/not verified/);
  });

  it('renders a PDF to one PNG per page and reads them in order', async () => {
    const buffer = await pdfWithPages(2);
    const images = await pageImagesFor({ buffer, mimeType: 'application/pdf' });
    expect(images).toHaveLength(2);
    expect(images[0].mimeType).toBe('image/png');
    expect(images[0].bytes.subarray(1, 4).toString()).toBe('PNG');

    let call = 0;
    const result = await ocrWithNearAi({ buffer, mimeType: 'application/pdf', send: async () => { call += 1; return reply(`page ${call}`); } });
    expect(result.markdown).toBe('page 1\n\npage 2');
    expect(result.pageCount).toBe(2);
  });
});
