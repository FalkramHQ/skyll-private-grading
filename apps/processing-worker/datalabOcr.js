import { markUnreadRegions } from '../../shared/unreadRegion.js';

const DATALAB_BASE = 'https://www.datalab.to/api/v1';
const DEFAULT_POLL_MS = 2500;
const DEFAULT_TIMEOUT_MS = 8 * 60 * 1000;

export function resolveOcrEngine(env = process.env) {
  return String(env.OCR_ENGINE || 'datalab').trim().toLowerCase() === 'mistral' ? 'mistral' : 'datalab';
}

function extensionForMime(mimeType) {
  const mime = String(mimeType || '').toLowerCase();
  if (mime.includes('pdf')) return '.pdf';
  if (mime.includes('png')) return '.png';
  if (mime.includes('webp')) return '.webp';
  return '.jpg';
}

function sleep(ms, wait = globalThis.setTimeout) {
  return new Promise((resolve) => wait(resolve, ms));
}

function normalizeDatalabResult(result, mode) {
  // Regions Datalab returned as images (no text) become the unread-region marker;
  // the image bytes themselves are not kept.
  const markdown = markUnreadRegions(Array.isArray(result?.markdown)
    ? result.markdown.filter(Boolean).join('\n\n').trim()
    : String(result?.markdown || '').trim());
  const rawPages = Array.isArray(result?.pages) ? result.pages : [];
  const pages = rawPages.length
    ? rawPages.map((page, index) => ({
      index: Number.isFinite(Number(page?.index)) ? Number(page.index) : index,
      markdown: markUnreadRegions(String(page?.markdown || page?.text || '')),
    }))
    : [{ index: 0, markdown }];
  return {
    markdown,
    pages,
    pageCount: Number(result?.page_count || pages.length || 1),
    usage: {
      parse_quality_score: result?.parse_quality_score ?? null,
      total_cost: result?.total_cost ?? null,
    },
    model: `datalab-${mode}`,
  };
}

function ocrError(message, { retryable = false, status } = {}) {
  const error = new Error(message);
  error.retryable = retryable;
  if (status != null) error.status = status;
  return error;
}

const DEFAULT_SUBMIT_RETRIES = 3;
const DEFAULT_SUBMIT_BACKOFF_MS = 5_000;
const MAX_RETRY_AFTER_MS = 60_000;

/** Delay before the next upload attempt: Retry-After when sent, else exponential. */
export function retryDelayMs(response, attempt, baseMs = DEFAULT_SUBMIT_BACKOFF_MS) {
  const header = response?.headers?.get?.('retry-after');
  const seconds = Number(header);
  if (header && Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  return Math.min(baseMs * 2 ** attempt, MAX_RETRY_AFTER_MS);
}

export function isRetryableDatalabStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

/**
 * Submit a file to Datalab Marker convert and poll until markdown is ready.
 */
export async function ocrWithDatalab({
  buffer,
  filename,
  mimeType = 'application/octet-stream',
  apiKey,
  mode = 'accurate',
  fetchImpl = fetch,
  now = Date.now,
  wait = globalThis.setTimeout,
  pollMs = DEFAULT_POLL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  submitRetries = DEFAULT_SUBMIT_RETRIES,
  submitBackoffMs = DEFAULT_SUBMIT_BACKOFF_MS,
} = {}) {
  if (!apiKey) throw ocrError('DATALAB_API_KEY is required for Datalab OCR');
  const name = filename || `asset${extensionForMime(mimeType)}`;
  const body = new FormData();
  body.append('file', new Blob([buffer], { type: mimeType || 'application/octet-stream' }), name);
  body.append('output_format', 'markdown');
  body.append('mode', mode);
  // Keep image regions so their place shows up in the markdown: with extraction
  // disabled Datalab drops a handwritten line it labels as a Figure without a trace.
  body.append('disable_image_extraction', 'false');

  // Datalab rate-limits bursts (a 199-sheet paper produced 1 000+ "Rate limit
  // exceeded" failures in 20 minutes). Honour Retry-After and back off a few
  // times before giving up on the asset.
  let submit;
  let submitted;
  for (let attempt = 0; ; attempt += 1) {
    submit = await fetchImpl(`${DATALAB_BASE}/convert`, {
      method: 'POST',
      headers: { 'X-API-Key': apiKey },
      body,
    });
    submitted = await submit.json().catch(() => ({}));
    if (submit.ok && submitted.request_id) break;
    const retryable = isRetryableDatalabStatus(submit.status);
    if (!retryable || attempt >= submitRetries) {
      throw ocrError(
        submitted.error || submitted.detail || `Datalab upload failed (${submit.status})`,
        { retryable, status: submit.status },
      );
    }
    await sleep(retryDelayMs(submit, attempt, submitBackoffMs), wait);
  }
  const checkUrl = submitted.request_check_url;
  if (!checkUrl) throw ocrError('Datalab upload succeeded without a poll URL');

  const started = now();
  while (now() - started < timeoutMs) {
    await sleep(pollMs, wait);
    const poll = await fetchImpl(checkUrl, { headers: { 'X-API-Key': apiKey } });
    const result = await poll.json().catch(() => ({}));
    if (!poll.ok) {
      throw ocrError(
        result.error || result.detail || `Datalab poll failed (${poll.status})`,
        { retryable: isRetryableDatalabStatus(poll.status), status: poll.status },
      );
    }
    if (result.status === 'complete') return normalizeDatalabResult(result, mode);
    if (result.status === 'failed') throw ocrError(result.error || 'Datalab conversion failed');
  }
  throw ocrError('Datalab OCR timed out', { retryable: true });
}

export function assetFilename(asset) {
  return `${asset?.kind || 'asset'}${extensionForMime(asset?.mimeType)}`;
}
