const fs = require('fs');
const https = require('https');
const path = require('path');

const { parseJson } = require('./core.cjs');

const DEFAULT_SITE_URL = process.env.OPENROUTER_SITE_URL || 'https://curio.skyll.ai';
const DEFAULT_TITLE = process.env.OPENROUTER_TITLE || 'Curio Grading Pipeline';

const sessionUsage = {
  calls: 0,
  errors: 0,
  input_tokens: 0,
  output_tokens: 0,
  total_tokens: 0,
  by_model: {},
};

function imageDataUrl(imagePath) {
  const buffer = fs.readFileSync(imagePath);
  const ext = path.extname(imagePath).replace('.', '').toLowerCase();
  const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'application/octet-stream';
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

function pdfDataUrl(filePath) {
  return `data:application/pdf;base64,${fs.readFileSync(filePath).toString('base64')}`;
}

function pdfPart(filePath) {
  return {
    type: 'file',
    file: {
      filename: path.basename(filePath),
      file_data: pdfDataUrl(filePath),
    },
  };
}

function isRetryable(err) {
  return /\b(429|500|502|503|504)\b|Provider returned error|rate|non-JSON|returned no message content|ETIMEDOUT|ECONNRESET|ENOTFOUND|EPIPE|socket hang up|network/i.test(err.message);
}

function isFatalBillingOrAuth(err) {
  return /\b(401|402|403)\b|Insufficient credits|User not found|Unauthorized|Forbidden|billing/i.test(err.message);
}

function recordUsage(model, parsed) {
  sessionUsage.calls += 1;
  const usage = parsed.usage || {};
  const input = Number(usage.prompt_tokens || usage.input_tokens || 0);
  const output = Number(usage.completion_tokens || usage.output_tokens || 0);
  const total = Number(usage.total_tokens || input + output || 0);
  sessionUsage.input_tokens += input;
  sessionUsage.output_tokens += output;
  sessionUsage.total_tokens += total;
  const key = parsed.model || model;
  sessionUsage.by_model[key] = sessionUsage.by_model[key] || {
    calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
  };
  sessionUsage.by_model[key].calls += 1;
  sessionUsage.by_model[key].input_tokens += input;
  sessionUsage.by_model[key].output_tokens += output;
  sessionUsage.by_model[key].total_tokens += total;
}

function callOnce({
  apiKey = process.env.OPENROUTER_API_KEY,
  model,
  messages,
  temperature = 0,
  maxTokens = 4000,
  siteUrl = DEFAULT_SITE_URL,
  title = DEFAULT_TITLE,
  plugins = null,
  timeoutMs = 120000,
}) {
  if (!apiKey) throw new Error('Missing OPENROUTER_API_KEY');
  const payload = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    reasoning: { exclude: true },
    include_reasoning: false,
  };
  if (plugins) payload.plugins = plugins;

  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: 'openrouter.ai',
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': siteUrl,
        'X-Title': title,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          sessionUsage.errors += 1;
          reject(new Error(`OpenRouter returned non-JSON (${res.statusCode}): ${data.slice(0, 500)}`));
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300 || parsed.error) {
          sessionUsage.errors += 1;
          reject(new Error(`OpenRouter API error (${parsed.error?.code || res.statusCode}): ${parsed.error?.message || data.slice(0, 500)}`));
          return;
        }
        const content = parsed.choices?.[0]?.message?.content;
        if (!content || !String(content).trim()) {
          sessionUsage.errors += 1;
          reject(new Error(`OpenRouter returned no message content (${res.statusCode})`));
          return;
        }
        recordUsage(model, parsed);
        resolve({ content, model: parsed.model || model, usage: parsed.usage || null, raw: parsed });
      });
    });
    req.on('timeout', () => {
      req.destroy();
      sessionUsage.errors += 1;
      reject(new Error('OpenRouter request timeout'));
    });
    req.on('error', (err) => {
      sessionUsage.errors += 1;
      reject(err);
    });
    req.write(body);
    req.end();
  });
}

async function callWithRetry(options, retries = 2) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await callOnce(options);
    } catch (err) {
      lastError = err;
      if (isFatalBillingOrAuth(err) || !isRetryable(err) || attempt === retries) break;
      const delay = Math.min(15000, 1000 * 2 ** attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

async function callWithFallback({
  models,
  retries = 1,
  onAttempt = null,
  ...options
}) {
  let lastError = null;
  for (const model of models.filter(Boolean).filter((m, i, arr) => arr.indexOf(m) === i)) {
    try {
      if (onAttempt) onAttempt(model);
      return await callWithRetry({ ...options, model }, retries);
    } catch (err) {
      lastError = err;
      if (isFatalBillingOrAuth(err) || !isRetryable(err)) break;
    }
  }
  throw lastError;
}

async function callJson(options, label = 'OpenRouter JSON response') {
  const response = await callWithFallback(options);
  return { ...response, parsed: parseJson(response.content, label) };
}

function usageSnapshot() {
  return JSON.parse(JSON.stringify(sessionUsage));
}

module.exports = {
  callJson,
  callOnce,
  callWithFallback,
  callWithRetry,
  imageDataUrl,
  isFatalBillingOrAuth,
  isRetryable,
  pdfDataUrl,
  pdfPart,
  usageSnapshot,
};
