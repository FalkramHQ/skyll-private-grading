import { createHmac } from 'node:crypto';

/**
 * Operational alerts for the processing worker and the API.
 *
 * The worker previously had no alerting at all: a job exhausting its retries,
 * a lease running out, or the poll loop failing was visible only in journald.
 * When ALERT_WEBHOOK_URL is set, these events are POSTed as JSON (Slack- and
 * Discord-compatible: `text` plus a structured `skyll` block). Without it the
 * alerter is a no-op, so local and test runs are unaffected.
 *
 * A Lark or Feishu custom-bot URL (open.larksuite.com / open.feishu.cn
 * /open-apis/bot/...) gets Lark's own shape instead: a text message carrying
 * the headline and the details. ALERT_WEBHOOK_SECRET signs it when the bot has
 * signature verification on. Lark answers HTTP 200 even when it rejects a
 * message, so its `code` decides delivery.
 *
 * Alerts are rate-limited per (event, key) so a stuck test cannot flood the
 * channel: one notification per window, then silence until the window ends.
 */

export const DEFAULT_ALERT_WINDOW_MS = 15 * 60 * 1000;

export function isLarkWebhook(url) {
  try {
    const { hostname, pathname } = new URL(url);
    return /(^|\.)(larksuite\.com|feishu\.cn|larkoffice\.com)$/i.test(hostname) && pathname.startsWith('/open-apis/bot/');
  } catch {
    return false;
  }
}

// Lark custom-bot signature: HMAC-SHA256 keyed by "<timestamp>\n<secret>" over
// an empty message, base64-encoded.
export function larkSignature(timestampSeconds, secret) {
  return createHmac('sha256', `${timestampSeconds}\n${secret}`).update('').digest('base64');
}

function larkBody(headline, details, { secret, nowMs }) {
  const lines = Object.entries(details)
    .filter(([, value]) => value != null && value !== '' && typeof value !== 'object')
    .map(([key, value]) => `${key}: ${String(value).slice(0, 300)}`);
  const body = { msg_type: 'text', content: { text: [headline, ...lines].join('\n') } };
  if (secret) {
    const timestamp = String(Math.floor(nowMs / 1000));
    body.timestamp = timestamp;
    body.sign = larkSignature(timestamp, secret);
  }
  return body;
}

export function createAlerter({
  webhookUrl = process.env.ALERT_WEBHOOK_URL || '',
  webhookSecret = process.env.ALERT_WEBHOOK_SECRET || '',
  fetchImpl = globalThis.fetch,
  now = Date.now,
  windowMs = Number(process.env.ALERT_WINDOW_MS || DEFAULT_ALERT_WINDOW_MS),
  env = process.env.SKYLL_WORKER_VERSION || 'unknown',
  log = (entry) => console.warn(JSON.stringify(entry)),
  timeoutMs = 8000,
} = {}) {
  const lastSent = new Map();
  const enabled = Boolean(webhookUrl);
  const lark = isLarkWebhook(webhookUrl);

  function shouldSend(event, key) {
    const bucket = `${event}:${key || ''}`;
    const previous = lastSent.get(bucket) || 0;
    const at = now();
    if (at - previous < windowMs) return false;
    lastSent.set(bucket, at);
    return true;
  }

  /**
   * @param {string} event      e.g. job_failed, job_lease_exhausted, poll_failed
   * @param {object} payload    structured details (jobId, type, testId, school, error...)
   * @param {object} [options]
   * @param {string} [options.key]   rate-limit key; defaults to payload.testId || payload.jobId
   * @param {string} [options.title] human headline
   */
  async function send(event, payload = {}, { key, title } = {}) {
    if (!enabled) return { sent: false, reason: 'disabled' };
    const limitKey = key ?? payload.testId ?? payload.jobId ?? '';
    if (!shouldSend(event, limitKey)) return { sent: false, reason: 'rate_limited' };
    const headline = title || formatTitle(event, payload);
    const details = { event, worker_version: env, at: new Date(now()).toISOString(), ...payload };
    const body = lark
      ? larkBody(headline, details, { secret: webhookSecret, nowMs: now() })
      : { text: headline, content: headline, skyll: details };
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const response = await fetchImpl(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller?.signal,
      });
      if (!response?.ok) {
        log({ event: 'alert_delivery_failed', alert: event, status: response?.status ?? null });
        return { sent: false, reason: `http_${response?.status ?? 'error'}` };
      }
      if (lark) {
        const result = await response.json().catch(() => ({}));
        const code = result?.code ?? result?.StatusCode ?? 0;
        if (code !== 0) {
          log({ event: 'alert_delivery_failed', alert: event, lark_code: code, lark_msg: String(result?.msg || '').slice(0, 200) });
          return { sent: false, reason: `lark_${code}` };
        }
      }
      return { sent: true };
    } catch (error) {
      log({ event: 'alert_delivery_failed', alert: event, error: String(error?.message || error) });
      return { sent: false, reason: 'network' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return { send, enabled };
}

export function formatTitle(event, payload = {}) {
  const where = [payload.school, payload.type, payload.testId].filter(Boolean).join(' · ');
  const suffix = where ? ` (${where})` : '';
  const error = payload.error ? `: ${String(payload.error).slice(0, 200)}` : '';
  switch (event) {
    case 'job_failed': return `Skyll worker: job failed after ${payload.attempts ?? '?'} attempts${suffix}${error}`;
    case 'job_lease_exhausted': return `Skyll worker: job abandoned after repeated lease expiry${suffix}`;
    case 'poll_failed': return `Skyll worker: poll loop error${error}`;
    case 'worker_started': return `Skyll worker started (${payload.workerVersion || 'unknown'})`;
    case 'housekeeping_failed': return `Skyll worker: housekeeping failed${error}`;
    case 'score_mismatch': return `Skyll: stored score does not match the question marks${suffix}`;
    default: return `Skyll worker: ${event}${suffix}${error}`;
  }
}
