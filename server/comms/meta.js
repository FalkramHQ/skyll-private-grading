// Meta WhatsApp Cloud API client (D2). Skyll calls Meta directly with each
// class's own business token; no reseller sits in the path. Every call has a
// timeout, and errors become ProviderError (server/comms/errors.js).
import { classifyMetaError, networkError } from './errors.js';

const TIMEOUT_MS = 15_000;

export function metaConfig(env = process.env) {
  return {
    graphVersion: String(env.META_GRAPH_VERSION || 'v23.0').trim(),
    appId: String(env.META_APP_ID || '').trim() || null,
    appSecret: String(env.META_APP_SECRET || '').trim() || null,
    configId: String(env.META_ES_CONFIG_ID || '').trim() || null,
    verifyToken: String(env.META_WEBHOOK_VERIFY_TOKEN || '').trim() || null,
    solutionId: String(env.META_SOLUTION_ID || '').trim() || null,
  };
}

function graphUrl(path, query = {}, env = process.env) {
  const url = new URL(`https://graph.facebook.com/${metaConfig(env).graphVersion}/${String(path).replace(/^\//, '')}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url;
}

/** One Graph request. `token` goes in the Authorization header, never the URL. */
export async function graph({ method = 'GET', path, token = null, query, json, body, headers = {}, fetchImpl = fetch, env = process.env }) {
  let response;
  try {
    response = await fetchImpl(graphUrl(path, query, env), {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(json ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: json ? JSON.stringify(json) : body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw networkError(error);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.error) throw classifyMetaError(payload?.error || {}, response.status);
  return payload;
}

/** Exchanges an Embedded Signup code for the class's business token. */
export async function exchangeCode(code, { fetchImpl, env = process.env } = {}) {
  const { appId, appSecret } = metaConfig(env);
  if (!appId || !appSecret) throw new Error('META_APP_ID and META_APP_SECRET are required to connect WhatsApp');
  const result = await graph({ path: 'oauth/access_token', query: { client_id: appId, client_secret: appSecret, code }, fetchImpl, env });
  if (!result.access_token) throw new Error('Meta did not return an access token');
  return result.access_token;
}

export function phoneNumberInfo(token, phoneNumberId, options = {}) {
  return graph({ path: phoneNumberId, token, query: { fields: 'display_phone_number,verified_name,quality_rating,platform_type,status' }, ...options });
}

export function wabaPhoneNumbers(token, wabaId, options = {}) {
  return graph({ path: `${wabaId}/phone_numbers`, token, query: { fields: 'id,display_phone_number,verified_name' }, ...options });
}

export function subscribeApp(token, wabaId, options = {}) {
  return graph({ method: 'POST', path: `${wabaId}/subscribed_apps`, token, ...options });
}

/** Registers a newly added number for the Cloud API with a two-step PIN. Not used for coexistence numbers. */
export function registerNumber(token, phoneNumberId, pin, options = {}) {
  return graph({ method: 'POST', path: `${phoneNumberId}/register`, token, json: { messaging_product: 'whatsapp', pin }, ...options });
}

export function submitTemplate(token, wabaId, payload, options = {}) {
  return graph({ method: 'POST', path: `${wabaId}/message_templates`, token, json: payload, ...options });
}

export async function listTemplates(token, wabaId, options = {}) {
  const result = await graph({ path: `${wabaId}/message_templates`, token, query: { fields: 'id,name,language,status,category,rejected_reason', limit: 200 }, ...options });
  return result.data || [];
}

export function sendMessage(token, phoneNumberId, payload, options = {}) {
  return graph({ method: 'POST', path: `${phoneNumberId}/messages`, token, json: { messaging_product: 'whatsapp', ...payload }, ...options });
}

/** Uploads a file to the number's media store; returns the media id used in a message. */
export async function uploadMedia(token, phoneNumberId, { data, mimeType, filename }, options = {}) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimeType);
  form.append('file', new Blob([data], { type: mimeType }), filename);
  const result = await graph({ method: 'POST', path: `${phoneNumberId}/media`, token, body: form, ...options });
  return result.id;
}

/**
 * Meta's resumable upload, which gives the sample `header_handle` a template
 * with a document header needs for approval.
 */
export async function uploadTemplateSample(token, { data, mimeType, filename }, { fetchImpl, env = process.env } = {}) {
  const { appId } = metaConfig(env);
  if (!appId) throw new Error('META_APP_ID is required to submit a document template');
  const session = await graph({ method: 'POST', path: `${appId}/uploads`, token, query: { file_name: filename, file_length: data.length, file_type: mimeType }, fetchImpl, env });
  const uploaded = await graph({ method: 'POST', path: session.id, headers: { Authorization: `OAuth ${token}`, file_offset: '0' }, body: data, fetchImpl, env });
  return uploaded.h;
}
