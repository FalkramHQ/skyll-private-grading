// LLM gateway — DeepSeek/Phala/Qwen/MiMo callers with retry + JSON parsing.
// Extracted from index.js for maintainability.

import { parseJsonModelResponse } from '../../workers/mistral-ocr/src/ocrProtocol.js';
import { nearAiConfig, nearPrivateChatCompletion, nearPrivateEnabledForCurrentJob } from './nearPrivateInference.js';

/** OpenAI-compatible DeepSeek chat endpoint. Prefer Phala when configured. */
export function deepseekCompatConfig({ purpose = 'reasoning' } = {}) {
  if (process.env.PHALA_API_KEY) {
    const base = (process.env.PHALA_BASE_URL || 'https://inference.phala.com/v1').replace(/\/+$/, '');
    return {
      provider: 'phala',
      url: `${base}/chat/completions`,
      apiKey: process.env.PHALA_API_KEY,
      model: process.env.PHALA_DEEPSEEK_MODEL || 'deepseek/deepseek-v4-flash-0731',
    };
  }
  return {
    provider: 'deepseek',
    url: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/chat/completions',
    apiKey: process.env.DEEPSEEK_API_KEY,
    model: purpose === 'rubric'
      ? (process.env.DEEPSEEK_RUBRIC_MODEL || 'deepseek-v4-flash')
      : (process.env.DEEPSEEK_EXAM_MODEL || process.env.DEEPSEEK_RUBRIC_MODEL || 'deepseek-v4-flash'),
  };
}

/** OpenAI-compatible DeepInfra endpoint used when official DeepSeek balance is down. */
export function deepinfraCompatConfig({ purpose = 'reasoning' } = {}) {
  if (!process.env.DEEPINFRA_API_KEY) return null;
  const base = (process.env.DEEPINFRA_BASE_URL || 'https://api.deepinfra.com/v1/openai').replace(/\/+$/, '');
  return {
    provider: 'deepinfra',
    url: `${base}/chat/completions`,
    apiKey: process.env.DEEPINFRA_API_KEY,
    model: purpose === 'vision'
      ? (process.env.DEEPINFRA_VISION_MODEL || 'google/gemma-4-26B-A4B-it')
      : (process.env.DEEPINFRA_REASONING_MODEL || 'deepseek-ai/DeepSeek-V4.1-Flash'),
  };
}

export function isProviderBalanceError(message) {
  // Providers word an empty account differently; every form must fall back instead of
  // failing the job: DashScope "The free quota has been exhausted" / "Free quota exhausted.",
  // DeepInfra "You need positive balance to do inference", Phala "Account quota exceeded.
  // Please add credits to continue."
  return /insufficient (?:account )?balance|quota (?:has been )?(?:exhausted|exceeded)|quota will reset|positive balance|add credits|payment required|402/i.test(String(message || ''));
}

async function callReasoningJsonOnEndpoint(endpoint, prompt, maxTokens, reasoningEffort) {
  let parseError = null;
  const attempts = Math.max(2, Number(process.env.REASONING_JSON_ATTEMPTS || 3));
  if (!endpoint?.apiKey) throw new Error('No DeepSeek-compatible API key configured (PHALA_API_KEY, DEEPSEEK_API_KEY, or DEEPINFRA_API_KEY).');
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 300000); // 5 min hard timeout
    const userContent = attempt === 0
      ? prompt
      : `${prompt}\n\nCRITICAL: Your previous reply was invalid or truncated JSON (${parseError?.message || 'parse error'}). Return one COMPLETE valid JSON object only. Keep each student_answer under 800 characters. Do not cut off mid-string.`;
    // After a truncation/parse miss, leave more room for the JSON payload.
    const attemptMaxTokens = attempt === 0 ? maxTokens : Math.min(16000, Math.max(maxTokens, Math.ceil(maxTokens * 1.25)));
    const requestBody = {
      model: endpoint.model,
      temperature: 0,
      max_tokens: attemptMaxTokens,
      ...(endpoint.provider === 'deepseek' ? { reasoning_effort: reasoningEffort } : {}),
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: 'Return one complete, strictly valid JSON object. Never invent student work. Escape all strings correctly and do not truncate the JSON.' }, { role: 'user', content: userContent }],
    };
    let ok;
    let status;
    let body;
    let receipt = null;
    try {
      if (endpoint.provider === 'nearai') {
        ({ ok, status, body, receipt } = await nearPrivateChatCompletion(endpoint, requestBody, { signal: controller.signal }));
      } else {
        const response = await fetch(endpoint.url, {
          method: 'POST',
          headers: { authorization: `Bearer ${endpoint.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });
        ({ ok, status } = response);
        body = await response.json().catch(() => ({}));
      }
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('Reasoning model timed out (120s)');
      throw err;
    } finally { clearTimeout(timeout); }
    if (!ok || body.error) throw new Error(body?.error?.message || `Reasoning model failed (${status})`);
    const message = body?.choices?.[0]?.message || {};
    const finishReason = body?.choices?.[0]?.finish_reason || '';
    const responseContent = typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
        ? message.content.map((part) => typeof part === 'string' ? part : part?.text || part?.content || '').join('')
        : '';
    const content = String(responseContent || (finishReason !== 'length' ? (message.reasoning_content || message.reasoning || '') : '')).trim();
    if (!content && finishReason === 'length') {
      parseError = new Error('Reasoning model exhausted max_tokens on reasoning without producing JSON output.');
      continue;
    }
    try {
      const parsed = { value: parseJsonModelResponse(content), model: body.model || endpoint.model, usage: body.usage || null, ...(receipt ? { receipt } : {}) };
      // Truncated-but-parseable JSON often drops trailing answers — retry unless last attempt.
      if (finishReason === 'length' && attempt < attempts - 1) {
        parseError = new Error('Reasoning model output truncated (finish_reason=length); retrying with tighter answers.');
        continue;
      }
      return parsed;
    } catch (error) {
      parseError = error;
    }
  }
  throw parseError || new Error('Reasoning model did not return valid JSON.');
}

/**
 * One JSON call to a named model on DeepInfra (OpenAI-compatible), with the same
 * retry-on-bad-JSON handling as callReasoningJson. Used where a specific model family
 * is required, e.g. the rubric key check must not use the family that built the rubric.
 */
export async function callDeepinfraModelJson(model, prompt, maxTokens = 4000) {
  const endpoint = deepinfraCompatConfig({ purpose: 'reasoning' });
  if (!endpoint) throw new Error('DEEPINFRA_API_KEY is not configured.');
  return callReasoningJsonOnEndpoint({ ...endpoint, model }, prompt, maxTokens, 'low');
}

/**
 * JSON call for grading (subjective items and the MCQ batch). GRADE_MODEL names a
 * DeepInfra model for grading only; unset, grading uses the shared reasoning chain
 * exactly as before. If the grading model fails on balance, rate limit, timeout or
 * a 5xx, the call falls back to that chain so grading never stops on a model switch.
 */
export async function callGradeJson(prompt, maxTokens = 8000) {
  if (nearPrivateEnabledForCurrentJob()) return callReasoningJson(prompt, maxTokens);
  const model = String(process.env.GRADE_MODEL || '').trim();
  if (!model || !process.env.DEEPINFRA_API_KEY) return callReasoningJson(prompt, maxTokens);
  try {
    return await callDeepinfraModelJson(model, prompt, maxTokens);
  } catch (error) {
    if (!(isProviderBalanceError(error.message) || /timed out|429|rate.?limit|5\d\d|failed \(5/i.test(error.message))) throw error;
    console.log(JSON.stringify({ event: 'grade_model_fallback', model, reason: String(error.message).slice(0, 200) }));
    return callReasoningJson(prompt, maxTokens);
  }
}

export async function callReasoningJson(prompt, maxTokens = 4000, reasoningEffort = 'low') {
  // A school opted into private inference never falls back to a non-TEE provider.
  if (nearPrivateEnabledForCurrentJob()) return callReasoningJsonOnEndpoint(nearAiConfig(), prompt, maxTokens, reasoningEffort);
  const deepseek = deepseekCompatConfig({ purpose: 'reasoning' });
  const deepinfra = deepinfraCompatConfig({ purpose: 'reasoning' });
  const chain = [];
  if (deepinfra?.apiKey) chain.push(deepinfra);
  if (deepseek?.apiKey && deepseek.apiKey !== deepinfra?.apiKey) chain.push(deepseek);
  if (!chain.length) throw new Error('No DeepSeek-compatible API key configured (PHALA_API_KEY, DEEPSEEK_API_KEY, or DEEPINFRA_API_KEY).');
  let lastError = null;
  for (const [index, endpoint] of chain.entries()) {
    try {
      return await callReasoningJsonOnEndpoint(endpoint, prompt, maxTokens, reasoningEffort);
    } catch (error) {
      lastError = error;
      const canFallback = index < chain.length - 1 && (
        isProviderBalanceError(error.message) || /timed out|429|rate.?limit|503|502/i.test(error.message)
      );
      if (!canFallback) throw error;
    }
  }
  throw lastError;
}

export async function callMimoJson(prompt, maxTokens) {
  const apiKey = process.env.MI_API_KEY || process.env.MIMO_API_KEY;
  if (!apiKey) throw new Error('MiMo report fallback is not configured.');
  let parseError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(process.env.MI_BASE_URL || 'https://api.xiaomimimo.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: process.env.MI_MODEL || 'mimo-v2.5-pro',
        temperature: 0.1,
        top_p: 0.95,
        max_completion_tokens: maxTokens,
        stream: false,
        messages: [
          { role: 'system', content: 'Return one complete, strictly valid JSON object. Never use Markdown or add commentary outside the JSON.' },
          { role: 'user', content: attempt === 0 ? prompt : `${prompt}\n\nYour previous reply was invalid JSON. Return a shorter, complete JSON object only.` },
        ],
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.error) throw new Error(body?.error?.message || `MiMo report fallback failed (${response.status})`);
    const message = body?.choices?.[0]?.message || {};
    const content = typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.map((part) => typeof part === 'string' ? part : part?.text || part?.content || '').join('') : '';
    try {
      return { value: parseJsonModelResponse(content), model: body.model || process.env.MI_MODEL || 'mimo-v2.5-pro', usage: body.usage || null };
    } catch (error) {
      parseError = error;
    }
  }
  throw parseError || new Error('MiMo report fallback did not return valid JSON.');
}

export async function callQwenJson(prompt, maxTokens) {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error('DASHSCOPE_API_KEY is not configured.');
  const baseUrl = (process.env.DASHSCOPE_BASE_URL || 'https://dashscope-intl.aliyuncs.com/api/v1').replace(/\/+$/, '');
  let parseError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(10_000, Number(process.env.QWEN_TIMEOUT_MS || 90_000)));
    try {
      const response = await fetch(`${baseUrl}/services/aigc/multimodal-generation/generation`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: process.env.QWEN_REASONING_MODEL || 'qwen3.7-plus',
          input: { messages: [{ role: 'user', content: [{ text: attempt === 0 ? prompt : `${prompt}\n\nReturn one shorter, complete JSON object only.` }] }] },
          parameters: { result_format: 'message', enable_thinking: false, max_tokens: maxTokens, temperature: 0 },
        }),
      });
      const body = await response.json().catch(() => ({}));
      const content = body?.output?.choices?.[0]?.message?.content;
      const output = Array.isArray(content) ? content.map((part) => typeof part === 'string' ? part : part?.text || '').join('') : typeof content === 'string' ? content : '';
      if (!response.ok || !output) throw new Error(body?.message || body?.code || `Qwen report module failed (${response.status})`);
      try {
        return { value: parseJsonModelResponse(output), model: body.model || process.env.QWEN_REASONING_MODEL || 'qwen3.7-plus', usage: body.usage || null };
      } catch (error) {
        parseError = error;
      }
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`Qwen report module timed out after ${Math.round(Number(process.env.QWEN_TIMEOUT_MS || 90_000) / 1000)} seconds.`);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw parseError || new Error('Qwen report module did not return valid JSON.');
}

export async function callReportModulesJson(prompt, maxTokens) {
  const provider = String(process.env.REPORT_MODULE_PROVIDER || '').toLowerCase();
  const tryMimo = async (primaryError) => {
    try {
      return await callMimoJson(prompt, maxTokens);
    } catch (fallbackError) {
      throw new Error(`Primary report model failed (${String(primaryError.message || primaryError)}); MiMo fallback failed (${String(fallbackError.message || fallbackError)})`);
    }
  };
  if (nearPrivateEnabledForCurrentJob()) return callReasoningJson(prompt, maxTokens);
  if (provider === 'mimo') return callMimoJson(prompt, maxTokens);
  if (provider === 'qwen') {
    try {
      return await callQwenJson(prompt, maxTokens);
    } catch (qwenError) {
      try {
        return await callReasoningJson(prompt, maxTokens);
      } catch (reasoningError) {
        return tryMimo(new Error(`Qwen failed (${String(qwenError.message || qwenError)}); reasoning failed (${String(reasoningError.message || reasoningError)})`));
      }
    }
  }
  try {
    return await callReasoningJson(prompt, maxTokens);
  } catch (primaryError) {
    return tryMimo(primaryError);
  }
}
