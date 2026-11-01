const fs = require('fs');
const https = require('https');
const path = require('path');

const PROVIDERS = {
  baidu: {
    apiKeyEnv: 'BAIDU_API_KEY',
    baseUrlEnv: 'BAIDU_BASE_URL',
    modelEnv: 'BAIDU_MODEL',
    defaultBaseUrl: 'https://qianfan.baidubce.com/v2/chat/completions',
    defaultModel: 'qianfan-ocr-fast',
    title: 'Baidu Qianfan',
  },
  deepseek: {
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    baseUrlEnv: 'DEEPSEEK_BASE_URL',
    modelEnv: 'DEEPSEEK_MODEL',
    defaultBaseUrl: 'https://api.deepseek.com/chat/completions',
    defaultModel: 'deepseek-chat',
    title: 'DeepSeek',
  },
  glm: {
    apiKeyEnv: 'GLM_API_KEY',
    baseUrlEnv: 'GLM_BASE_URL',
    modelEnv: 'GLM_VISION_MODEL',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    defaultModel: 'glm-4.5v',
    title: 'GLM',
  },
  mi: {
    apiKeyEnv: 'MI_API_KEY',
    baseUrlEnv: 'MI_BASE_URL',
    modelEnv: 'MI_MODEL',
    defaultBaseUrl: 'https://api.xiaomimimo.com/v1/chat/completions',
    defaultModel: 'mimo-v2.5-pro',
    apiKeyHeader: 'api-key',
    maxTokensField: 'max_completion_tokens',
    title: 'Xiaomi MiMo',
  },
  openrouter: {
    apiKeyEnv: 'OPENROUTER_API_KEY',
    baseUrlEnv: 'OPENROUTER_BASE_URL',
    modelEnv: 'OPENROUTER_MODEL',
    defaultBaseUrl: 'https://openrouter.ai/api/v1/chat/completions',
    defaultModel: 'qwen/qwen3-235b-a22b',
    title: 'OpenRouter',
  },
};

function providerConfig(provider, overrides = {}) {
  const spec = PROVIDERS[provider];
  if (!spec) throw new Error(`Unknown direct provider: ${provider}`);
  const apiKey = overrides.apiKey || process.env[spec.apiKeyEnv];
  if (!apiKey) throw new Error(`Missing ${spec.apiKeyEnv}`);
  return {
    provider,
    title: spec.title,
    apiKey,
    baseUrl: overrides.baseUrl || process.env[spec.baseUrlEnv] || spec.defaultBaseUrl,
    model: overrides.model || process.env[spec.modelEnv] || spec.defaultModel,
  };
}

function imageDataUrl(imagePath) {
  const buffer = fs.readFileSync(imagePath);
  const ext = path.extname(imagePath).replace('.', '').toLowerCase();
  const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

function parseResponseContent(parsed) {
  const content = parsed.choices?.[0]?.message?.content;
  if (Array.isArray(content)) {
    return content.map((part) => part.text || part.content || '').join('\n').trim();
  }
  if (content && content.trim()) return String(content).trim();
  // MiMo reasoning models may return content in reasoning_content when content is empty
  const reasoning = parsed.choices?.[0]?.message?.reasoning_content;
  if (reasoning && reasoning.trim()) return String(reasoning).trim();
  return String(content || '').trim();
}

function callOpenAiCompatible({
  provider,
  messages,
  model,
  baseUrl,
  apiKey,
  temperature = 0,
  maxTokens = 1000,
  timeoutMs = 120000,
  seed,
  responseFormat,
}) {
  const config = providerConfig(provider, { model, baseUrl, apiKey });
  const url = new URL(config.baseUrl);

  // MiMo doesn't support array content — flatten to plain string
  let finalMessages = messages;
  if (provider === 'mi') {
    finalMessages = finalMessages.map((m) => {
      if (Array.isArray(m.content)) {
        const textParts = m.content
          .filter((p) => p.type === 'text')
          .map((p) => p.text)
          .join('\n');
        return { ...m, content: textParts };
      }
      return m;
    });
  }

  const body = JSON.stringify({
    model: config.model,
    messages: finalMessages,
    temperature,
    [PROVIDERS[provider].maxTokensField || 'max_tokens']: maxTokens,
    ...(seed != null ? { seed } : {}),
    ...(provider === 'mi' ? { top_p: 0.95, stream: false } : {}),
    ...(responseFormat ? { response_format: responseFormat } : {}),
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [PROVIDERS[provider].apiKeyHeader || 'Authorization']: PROVIDERS[provider].apiKeyHeader ? config.apiKey : `Bearer ${config.apiKey}`,
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
          reject(new Error(`${config.title} returned non-JSON (${res.statusCode}): ${data.slice(0, 500)}`));
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300 || parsed.error) {
          reject(new Error(`${config.title} API error (${parsed.error?.code || res.statusCode}): ${parsed.error?.message || data.slice(0, 500)}`));
          return;
        }
        const content = parseResponseContent(parsed);
        if (!content) {
          reject(new Error(`${config.title} returned empty content (${res.statusCode})`));
          return;
        }
        resolve({ content, model: parsed.model || config.model, usage: parsed.usage || null, raw: parsed });
      });
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`${config.title} request timeout after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = {
  PROVIDERS,
  callOpenAiCompatible,
  imageDataUrl,
  providerConfig,
};
