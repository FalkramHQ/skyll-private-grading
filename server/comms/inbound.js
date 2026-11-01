// Meta `messages` webhook events (D9, D12, D4): delivery statuses for what
// Skyll sent, and everything parents send to the class's number. Statuses only
// move forwards. A reply is stored (text only; media is noted, never kept) and
// matched to a contact by phone. "STOP" withdraws WhatsApp consent at once.
import { createHash, randomUUID } from 'node:crypto';
import { auditStatement } from '../crm/audit.js';
import { classifyMetaError } from './errors.js';
import { blockStatements } from './health.js';
import { messageStatements } from './outbox.js';
import { systemScope } from './system.js';

const STOP_WORDS = new Set(['STOP', 'STOP ALL', 'STOPALL', 'UNSUBSCRIBE', 'बंद', 'बंद करें', 'बंद करो', 'रोकें']);

export function isStop(text) {
  const normalised = String(text || '').trim().toUpperCase().replace(/[^\p{L}\p{M} ]/gu, '').replace(/\s+/g, ' ').trim();
  return STOP_WORDS.has(normalised);
}

const MEDIA_LABELS = {
  image: 'Photo received', audio: 'Voice note received', video: 'Video received', document: 'Document received',
  sticker: 'Sticker received', location: 'Location received', contacts: 'Contact card received',
};

// The statuses a webhook may move a message to, and what it may come from.
const FORWARD = {
  delivered: ['sending', 'sent'],
  read: ['sending', 'sent', 'delivered'],
  failed: ['sending', 'sent', 'delivered'],
};

async function connectionForNumber(db, phoneNumberId) {
  if (!phoneNumberId) return null;
  const result = await db.execute({ sql: "SELECT * FROM crm_wa_connections WHERE phone_number_id = ? AND status = 'connected'", args: [String(phoneNumberId)] });
  return result.rows[0] || null;
}

const tsIso = (seconds, fallback) => {
  const ms = Number(seconds) * 1000;
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : fallback;
};

async function applyStatus(db, connection, status, now) {
  const next = String(status.status || '').toLowerCase();
  const from = FORWARD[next];
  if (!from || !status.id) return;
  const at = tsIso(status.timestamp, now);
  const pricing = status.pricing || null;
  const sets = ['status = ?', 'updated_at = ?'];
  const args = [next, now];
  if (next === 'delivered') { sets.push('delivered_at = COALESCE(delivered_at, ?)'); args.push(at); }
  if (next === 'read') { sets.push('read_at = COALESCE(read_at, ?)', 'delivered_at = COALESCE(delivered_at, ?)'); args.push(at, at); }
  let problem = null;
  if (next === 'failed') {
    problem = classifyMetaError(status.errors?.[0] || {}, 400);
    sets.push('status_code = ?', 'status_reason = ?', 'failed_at = ?');
    args.push(problem.code, problem.reason, at);
  }
  if (pricing?.category) { sets.push('pricing_category = ?'); args.push(String(pricing.category).toLowerCase()); }
  if (pricing && pricing.billable === false) sets.push('cost_millipaise = 0');
  const statements = [{
    sql: `UPDATE crm_comms_messages SET ${sets.join(', ')}
          WHERE provider_message_id = ? AND school_id = ? AND status IN (${from.map(() => '?').join(', ')})`,
    args: [...args, String(status.id), connection.school_id, ...from],
  }];
  if (problem?.kind === 'class') statements.push(...blockStatements(connection, { code: problem.code, reason: problem.reason }, now));
  await db.batch(statements, 'write');
}

async function senderName(db, schoolId) {
  const settings = (await db.execute({ sql: 'SELECT sender_name, language FROM crm_wa_settings WHERE school_id = ?', args: [schoolId] })).rows[0];
  const school = (await db.execute({ sql: 'SELECT display_name FROM schools WHERE id = ?', args: [schoolId] })).rows[0];
  return { name: settings?.sender_name || school?.display_name || 'the class', language: settings?.language || 'en' };
}

export function stopAcknowledgement(name, language) {
  return language === 'hi'
    ? `आपको अब ${name} से WhatsApp अपडेट नहीं मिलेंगे। इन्हें फिर से शुरू करने के लिए क्लास से संपर्क करें।`
    : `You won’t receive more WhatsApp updates from ${name}. To start them again, please ask the class.`;
}

/** Withdraws consent for every contact with this phone, cancels what's waiting, and acknowledges once. */
async function applyStop(db, connection, phone, inboundId, now) {
  const contacts = (await db.execute({
    sql: 'SELECT id FROM crm_contacts WHERE school_id = ? AND phone_e164 = ? AND anonymised_at IS NULL AND whatsapp_opted_in = 1',
    args: [connection.school_id, phone],
  })).rows;
  const scope = systemScope(connection.school_id);
  const statements = [];
  for (const contact of contacts) {
    statements.push({
      sql: `UPDATE crm_contacts SET whatsapp_opted_in = 0, consent_at = ?, consent_source = 'whatsapp_stop', updated_at = ?, version = version + 1
            WHERE id = ? AND school_id = ? AND whatsapp_opted_in = 1`,
      args: [now, now, contact.id, connection.school_id],
    });
    statements.push(auditStatement(scope, { action: 'contact.consent_changed', entityId: contact.id, summary: { optedIn: false, source: 'whatsapp_stop' }, onlyIfChanged: true, now }));
  }
  statements.push({
    sql: `UPDATE crm_comms_messages SET status = 'cancelled', status_reason = 'The parent replied STOP', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE school_id = ? AND phone_e164 = ? AND status IN ('queued', 'held') AND kind != 'stop_ack'`,
    args: [now, connection.school_id, phone],
  });
  const sender = await senderName(db, connection.school_id);
  // The confirmation shows on the timelines of the students these contacts look after.
  const students = contacts.length ? (await db.execute({
    sql: `SELECT DISTINCT student_id FROM crm_guardian_links WHERE school_id = ? AND status = 'active' AND contact_id IN (${contacts.map(() => '?').join(', ')})`,
    args: [connection.school_id, ...contacts.map((contact) => contact.id)],
  })).rows.map((row) => ({ entityType: 'student', entityId: row.student_id })) : [];
  const ack = messageStatements({
    schoolId: connection.school_id, via: 'api', kind: 'stop_ack', connectionId: connection.id, contactId: contacts[0]?.id || null, phone,
    bodyText: stopAcknowledgement(sender.name, sender.language), dedupKey: `stop_ack:${createHash('sha256').update(phone).digest('hex').slice(0, 16)}:${now.slice(0, 10)}`, refType: 'inbound', refId: inboundId, now,
  }, students);
  statements.push(...ack.statements);
  await db.batch(statements, 'write');
}

async function applyInbound(db, connection, message, now) {
  if (!message.id || !message.from) return;
  const phone = `+${String(message.from).replace(/\D/g, '')}`;
  const type = String(message.type || 'unknown');
  let kind = 'other';
  let body = null;
  let mediaLabel = null;
  if (type === 'text') { kind = 'text'; body = message.text?.body || ''; }
  else if (type === 'button') { kind = 'button'; body = message.button?.text || ''; }
  else if (type === 'interactive') { kind = 'button'; body = message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || ''; }
  else if (MEDIA_LABELS[type]) { kind = 'media'; mediaLabel = MEDIA_LABELS[type]; body = message[type]?.caption || null; }
  else mediaLabel = 'Message received';
  const contact = (await db.execute({
    sql: 'SELECT id FROM crm_contacts WHERE school_id = ? AND phone_e164 = ? AND anonymised_at IS NULL ORDER BY created_at LIMIT 1',
    args: [connection.school_id, phone],
  })).rows[0];
  const stop = kind !== 'media' && isStop(body);
  const id = `inb_${randomUUID()}`;
  const inserted = await db.execute({
    sql: `INSERT OR IGNORE INTO crm_comms_inbound (id, school_id, connection_id, provider_message_id, from_phone, contact_id, kind, body_text, media_label, is_stop, received_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [id, connection.school_id, connection.id, String(message.id), phone, contact?.id || null, kind, body ? String(body).slice(0, 4000) : null, mediaLabel, stop ? 1 : 0,
      tsIso(message.timestamp, now), now, now],
  });
  // Meta retries webhooks: a repeat of the same message does nothing more.
  if (!Number(inserted.rowsAffected) || !stop) return;
  await applyStop(db, connection, phone, id, now);
}

/** The `messages` field: statuses and incoming messages for one class number. */
export async function applyMessagesChange(db, wabaId, value, now) {
  const connection = await connectionForNumber(db, value.metadata?.phone_number_id);
  if (!connection) return;
  for (const status of value.statuses || []) await applyStatus(db, connection, status, now);
  for (const message of value.messages || []) await applyInbound(db, connection, message, now);
}
