// OCR inside NEAR AI's TEE, for student work from schools opted into private inference.
// Every other school, and every question paper and answer key, stays on Datalab. This is
// the one sanctioned exception to "no vision models for text extraction" (AGENTS.md): no
// attested OCR service exists, and sending answer sheets to Datalab takes them out of the TEE.

import { UNREAD_REGION_MARKER } from '../../shared/unreadRegion.js';
import { nearAiConfig, nearPrivateChatCompletion } from './nearPrivateInference.js';

export const NEAR_OCR_MODEL = 'Qwen/Qwen3-VL-30B-A3B-Instruct';
// On about 1.5% of real pages the vision model repeats itself until it runs out of tokens, and
// a retry does not help. This model is also attested, and reasons first, so it needs more room.
export const NEAR_OCR_FALLBACK_MODEL = 'Qwen/Qwen3.8-27B';
const OCR_REQUEST_TIMEOUT_MS = 300_000;
const MAX_PAGE_SIDE_PX = 2000;
const BLANK_PAGE = '[blank page]';

// A vision model tends to fix what it reads. Marks depend on the student's mistakes
// surviving, so the prompt forbids that first and spells out the OCR conventions
// extraction already understands (~~ for crossed-out work, the unread-region marker).
export const NEAR_OCR_PROMPT = `Transcribe this exam page exactly as written. You are a copying machine, not a teacher.

- Copy every word, number and symbol exactly as it appears, including spelling, grammar, arithmetic and factual mistakes.
- Never correct, complete, solve, reorder or improve anything, even when it is plainly wrong.
- Keep question numbers, line breaks and the order on the page.
- Write maths as plain text with Unicode symbols, or inline LaTeX where plain text cannot show it.
- Write tables as Markdown tables.
- Wrap crossed-out text in ~~ and ~~.
- Where a part cannot be read, or is a drawing or diagram, write ${UNREAD_REGION_MARKER} in its place. Never guess.
- If the page has no writing at all, reply with exactly ${BLANK_PAGE}

Output only the transcription, with no commentary and no code fences.`;

/** Papers and keys are the only kinds known to hold no student work, so anything else stays private. */
export function readsStudentWork(kind) {
  return kind !== 'question_paper' && kind !== 'answer_key';
}

function ocrError(message, { retryable = true, status } = {}) {
  const error = new Error(message);
  error.retryable = retryable;
  if (status != null) error.status = status;
  return error;
}

/** Renders each PDF page to a PNG here on the worker, so only the page image reaches the TEE. */
async function renderPdfPages(buffer) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { createCanvas } = await import('@napi-rs/canvas');
  const pdf = await getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, isEvalSupported: false }).promise;
  const pages = [];
  try {
    for (let number = 1; number <= pdf.numPages; number += 1) {
      const page = await pdf.getPage(number);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(2, MAX_PAGE_SIDE_PX / Math.max(base.width, base.height));
      const viewport = page.getViewport({ scale });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport }).promise;
      pages.push({ mimeType: 'image/png', bytes: canvas.toBuffer('image/png') });
      page.cleanup();
    }
  } finally {
    await pdf.destroy();
  }
  return pages;
}

export function pageImagesFor({ buffer, mimeType }) {
  return /pdf/i.test(String(mimeType || '')) ? renderPdfPages(buffer) : [{ mimeType: mimeType || 'image/jpeg', bytes: buffer }];
}

function cleanTranscription(content) {
  const text = String(content || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^\s*```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
  return text === BLANK_PAGE ? '' : text;
}

async function readPage({ image, index, models, send }) {
  for (const [attempt, model] of models.entries()) {
    let result;
    try {
      result = await send(nearAiConfig({ model }), {
        temperature: 0,
        max_tokens: attempt === 0 ? Math.max(500, Number(process.env.NEAR_AI_OCR_MAX_TOKENS || 4000)) : 8000,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: NEAR_OCR_PROMPT },
            { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.bytes.toString('base64')}` } },
          ],
        }],
      }, { signal: AbortSignal.timeout(OCR_REQUEST_TIMEOUT_MS) });
    } catch (error) {
      throw ocrError(`Private OCR failed on page ${index + 1}: ${error.message}`);
    }
    if (!result.ok) {
      const status = Number(result.status);
      throw ocrError(result.body?.error?.message || `Private OCR failed (${status})`, { status, retryable: status === 408 || status === 429 || status >= 500 });
    }
    // A cut-off page would lose the end of an answer without a trace, so it is never kept.
    if (result.body?.choices?.[0]?.finish_reason !== 'length') return { result, model };
  }
  throw ocrError(`Private OCR ran out of tokens on page ${index + 1}`);
}

/** Same result shape as ocrWithDatalab, so saving and extraction need no changes. */
export async function ocrWithNearAi({ buffer, mimeType, send = nearPrivateChatCompletion } = {}) {
  if (!nearAiConfig()) throw ocrError('NEAR_AI_API_KEY is required for private OCR', { retryable: false });
  const primary = process.env.NEAR_AI_OCR_MODEL || NEAR_OCR_MODEL;
  const models = [...new Set([primary, process.env.NEAR_AI_OCR_FALLBACK_MODEL || NEAR_OCR_FALLBACK_MODEL])];
  const images = await pageImagesFor({ buffer, mimeType });
  const pages = [];
  const usage = { prompt_tokens: 0, completion_tokens: 0, receipts: [], fallback_pages: 0 };
  for (const [index, image] of images.entries()) {
    const { result, model } = await readPage({ image, index, models, send });
    pages.push({ index, markdown: cleanTranscription(result.body?.choices?.[0]?.message?.content) });
    usage.prompt_tokens += Number(result.body?.usage?.prompt_tokens || 0);
    usage.completion_tokens += Number(result.body?.usage?.completion_tokens || 0);
    if (model !== primary) usage.fallback_pages += 1;
    if (result.receipt?.id) usage.receipts.push(result.receipt.id);
  }
  return {
    markdown: pages.map((page) => page.markdown).filter(Boolean).join('\n\n').trim(),
    pages,
    pageCount: pages.length,
    usage,
    model: usage.fallback_pages ? `${primary}+${models[1]}` : primary,
  };
}
