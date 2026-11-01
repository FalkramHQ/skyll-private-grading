// Meta's WhatsApp webhook (D2, D9, D12). One URL receives events for every
// connected class; each change names its WhatsApp account (entry.id) and, for
// messages, the phone number id, which maps to exactly one school.
//
// The signature is HMAC-SHA256 of the exact bytes Meta sent, keyed by the app
// secret. Nothing is parsed or stored before it checks out.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { blockConnection, unblockConnection } from './health.js';
import { applyMessagesChange } from './inbound.js';
import { applyTemplateUpdate } from './templates.js';

export function signatureValid(rawBody, header, appSecret) {
  if (!appSecret || !rawBody || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const given = Buffer.from(header.slice(7), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * The raw request body. The local dev server keeps it as `req.rawBody`; on
 * Vercel the stream is read here, before anything touches `req.body`.
 */
export async function readRawBody(req) {
  if (typeof req.rawBody === 'string' || Buffer.isBuffer(req.rawBody)) return Buffer.from(req.rawBody);
  if (typeof req[Symbol.asyncIterator] === 'function' && !req.readableEnded) {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (chunks.length) return Buffer.concat(chunks);
  }
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body);
  return null;
}

async function connectionsForWaba(db, wabaId) {
  const result = await db.execute({ sql: "SELECT * FROM crm_wa_connections WHERE waba_id = ? AND status = 'connected'", args: [String(wabaId)] });
  return result.rows;
}

const ACCOUNT_PROBLEMS = {
  PARTNER_REMOVED: 'The class removed Skyll’s access in Meta; reconnect WhatsApp',
  ACCOUNT_DELETED: 'The class’s WhatsApp account was deleted in Meta; reconnect WhatsApp',
  ACCOUNT_RESTRICTION: 'Meta has restricted the class’s WhatsApp account',
  ACCOUNT_VIOLATION: 'Meta has restricted the class’s WhatsApp account for a policy violation',
  DISABLED_UPDATE: 'Meta has disabled the class’s WhatsApp account',
};

async function applyAccountUpdate(db, wabaId, value, now) {
  const event = String(value.event || '').toUpperCase();
  for (const connection of await connectionsForWaba(db, wabaId)) {
    if (ACCOUNT_PROBLEMS[event]) await blockConnection(db, connection, { code: event.toLowerCase(), reason: ACCOUNT_PROBLEMS[event] }, now);
    else if (event === 'ACCOUNT_RESTRICTION_LIFTED' || event === 'VERIFIED_ACCOUNT') await unblockConnection(db, connection, now);
  }
}

async function applyQualityUpdate(db, wabaId, value, now) {
  const event = String(value.event || '').toUpperCase();
  const rating = event === 'FLAGGED' ? 'RED' : event === 'UNFLAGGED' ? 'GREEN' : null;
  if (!rating) return;
  await db.execute({
    sql: "UPDATE crm_wa_connections SET quality_rating = ?, updated_at = ? WHERE waba_id = ? AND status = 'connected'",
    args: [rating, now, String(wabaId)],
  });
}

const handlers = {
  messages: applyMessagesChange,
  message_template_status_update: (db, wabaId, value, now) => applyTemplateUpdate(db, wabaId, value, now),
  account_update: applyAccountUpdate,
  phone_number_quality_update: applyQualityUpdate,
};

export function registerWebhookHandler(field, handler) {
  handlers[field] = handler;
}

/** Applies every change in a verified payload. Unknown fields are ignored. */
export async function processWebhook(db, payload, { now = () => new Date().toISOString() } = {}) {
  if (payload?.object !== 'whatsapp_business_account') return { changes: 0 };
  let changes = 0;
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const handler = handlers[change.field];
      if (!handler) continue;
      await handler(db, String(entry.id), change.value || {}, now());
      changes += 1;
    }
  }
  return { changes };
}
