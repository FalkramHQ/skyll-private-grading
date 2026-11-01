// Meta's WhatsApp webhook as a public CRM route (no login; no new serverless
// function). GET answers Meta's one-time verification; POST checks the
// signature over the raw body before reading anything (CRM M2 phase 2 S1).
import { z } from 'zod';
import { metaConfig } from '../comms/meta.js';
import { processWebhook, readRawBody, signatureValid } from '../comms/webhook.js';
import { crmErrors } from './errors.js';

export const webhookQuery = z.object({
  'hub.mode': z.string().max(40).optional(),
  'hub.verify_token': z.string().max(200).optional(),
  'hub.challenge': z.string().max(200).optional(),
}).passthrough();

export async function verifyWebhook({ res, input }) {
  const { verifyToken } = metaConfig();
  const query = input.query;
  if (!verifyToken || query['hub.mode'] !== 'subscribe' || query['hub.verify_token'] !== verifyToken || !query['hub.challenge']) throw crmErrors.forbidden();
  res.setHeader('Content-Type', 'text/plain');
  return res.status(200).send(query['hub.challenge']);
}

export async function receiveWebhook({ req, db }) {
  const raw = await readRawBody(req);
  const { appSecret } = metaConfig();
  if (!signatureValid(raw, req.headers?.['x-hub-signature-256'], appSecret)) {
    console.warn(JSON.stringify({ event: 'wa_webhook_rejected', reason: raw ? 'signature' : 'no_raw_body' }));
    throw crmErrors.unauthenticated();
  }
  let payload;
  try { payload = JSON.parse(raw.toString('utf8')); } catch { throw crmErrors.validation([{ path: 'body', message: 'Not JSON' }]); }
  try {
    return await processWebhook(db, payload);
  } catch (error) {
    // A 500 makes Meta retry later, which is what we want for a database hiccup.
    console.error(JSON.stringify({ event: 'wa_webhook_failed', error: String(error?.message || error) }));
    throw error;
  }
}
