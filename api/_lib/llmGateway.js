/**
 * Shared LLM JSON gateway for API + worker-adjacent callers.
 * Pattern extracted from cohort regrade DeepSeek calls.
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function jsonFromModel(text) {
  const clean = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(clean);
}

const MAX_JSON_TOKENS = 16000;

export function isProviderBalanceError(message) {
  return /insufficient balance|quota has been exhausted|quota will reset|payment required|402/i.test(String(message || ''));
}

function deepinfraReviewEndpoint() {
  if (!process.env.DEEPINFRA_API_KEY) return null;
  const base = (process.env.DEEPINFRA_BASE_URL || 'https://api.deepinfra.com/v1/openai').replace(/\/+$/, '');
  return {
    apiKey: process.env.DEEPINFRA_API_KEY,
    baseUrl: `${base}/chat/completions`,
    model: process.env.DEEPINFRA_REASONING_MODEL || 'deepseek-ai/DeepSeek-V4.1-Flash',
  };
}

/**
 * Call a chat-completions model and parse a JSON object response.
 *
 * @param {object} options
 * @param {string} options.prompt
 * @param {number} [options.maxTokens]
 * @param {string} [options.system]
 * @param {string} [options.model]
 * @param {number} [options.temperature]
 * @param {number} [options.attempts]
 * @param {string} [options.apiKey]
 * @param {string} [options.baseUrl]
 * @returns {Promise<{ result: object, model: string, usage: object|null }>}
 */
async function callJsonModelOnce({
  prompt,
  maxTokens = 900,
  system = 'You are an exacting educational assistant. Return valid, compact JSON only. Do not use Markdown.',
  model,
  temperature = 0.1,
  attempts = 4,
  retryDelayMs,
  apiKey,
  baseUrl,
} = {}) {
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY is not configured');
  if (!prompt || typeof prompt !== 'string') throw new Error('prompt is required');

  let lastError = null;
  let tokenBudget = maxTokens;
  let truncated = false;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      const delay = retryDelayMs == null
        ? Math.min(2000 * 2 ** (attempt - 1), 12000)
        : retryDelayMs;
      if (delay > 0) await sleep(delay);
    }
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature,
        max_tokens: tokenBudget,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          {
            role: 'user',
            content: attempt === 0
              ? prompt
              : truncated
                ? `${prompt}\n\nYour previous response was cut off before the JSON closed. Return the complete JSON object only, as compactly as possible.`
                : `${prompt}\n\nYour previous response was invalid JSON. Return a shorter valid JSON object only.`,
          },
        ],
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.error) {
      const status = response.status;
      const message = body.error?.message || `LLM request failed (${status})`;
      if (status === 429 || status >= 500) {
        lastError = new Error(message);
        continue;
      }
      throw new Error(message);
    }
    const choice = body.choices?.[0];
    truncated = choice?.finish_reason === 'length';
    if (truncated) {
      // The JSON was cut off by max_tokens. Retrying at the same budget just
      // reproduces the same unterminated string, so double it (capped).
      tokenBudget = Math.min(Math.max(tokenBudget * 2, tokenBudget + 500), MAX_JSON_TOKENS);
      lastError = new Error(`LLM output truncated (finish_reason=length) at ${choice?.message?.content?.length || 0} chars`);
      continue;
    }
    try {
      const content = choice?.message?.content;
      if (!content) {
        lastError = new Error('LLM returned empty content');
        continue;
      }
      return { result: jsonFromModel(content), model: body.model || model, usage: body.usage || null };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('LLM returned invalid JSON');
}

export async function callJsonModel(options = {}) {
  const fallback = deepinfraReviewEndpoint();
  const hasExplicitEndpoint = Boolean(options.apiKey || options.baseUrl);
  const apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY;
  const baseUrl = options.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/chat/completions';
  const model = options.model
    ?? process.env.DEEPSEEK_REVIEW_MODEL
    ?? process.env.DEEPSEEK_EXAM_MODEL
    ?? process.env.DEEPSEEK_MODEL
    ?? 'deepseek-chat';
  const resolved = { ...options, apiKey, baseUrl, model };
  // Official DeepSeek balance dies regularly. Prefer DeepInfra V4.1-Flash unless
  // the caller pinned a specific endpoint (tests / explicit keys).
  if (!hasExplicitEndpoint && fallback) {
    const deepinfraModel = model.includes('/') ? model : fallback.model;
    return callJsonModelOnce({ ...resolved, ...fallback, model: deepinfraModel });
  }
  if (!apiKey && fallback) return callJsonModelOnce({ ...resolved, ...fallback });
  try {
    return await callJsonModelOnce(resolved);
  } catch (error) {
    if (fallback && isProviderBalanceError(error.message) && apiKey !== fallback.apiKey) {
      return callJsonModelOnce({ ...resolved, ...fallback });
    }
    throw error;
  }
}
