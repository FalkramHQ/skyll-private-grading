// The message outbox (CRM-020, D5/D8/D12): who receives a message, the
// allowlisted text, the dedup key and the estimated cost. Producers (API
// routes, the planner) only insert rows here; the worker's dispatcher sends.
import { randomUUID } from 'node:crypto';
import { WA_TEMPLATES, renderTemplate } from '../../shared/crm/waTemplates.js';
import { WA_FREE_SERVICE_PER_MONTH, WA_PRICES_MILLIPAISE } from '../../shared/crm/waPricing.js';
import { DEFAULT_TIMEZONE, zonedParts, zonedTimeToUtcMs } from '../../shared/crm/time.js';

export const WINDOW_MS = 24 * 60 * 60 * 1000;
export const newMessageId = () => `msg_${randomUUID()}`;

/**
 * Consenting, active guardians of these students, with their roles (D5).
 * Returns rows `{ studentId, contactId, name, phone, isPrimary, isFeePayer }`.
 */
export async function guardianRows(db, schoolId, studentIds) {
  if (!studentIds.length) return [];
  const result = await db.execute({
    sql: `SELECT g.student_id, c.id AS contact_id, c.full_name, c.phone_e164, c.whatsapp_opted_in, g.is_primary, g.is_fee_payer
          FROM crm_guardian_links g
          JOIN crm_contacts c ON c.id = g.contact_id AND c.school_id = g.school_id
          WHERE g.school_id = ? AND g.status = 'active' AND c.archived_at IS NULL AND c.anonymised_at IS NULL
            AND g.student_id IN (${studentIds.map(() => '?').join(', ')})
          ORDER BY g.is_primary DESC, c.created_at`,
    args: [schoolId, ...studentIds],
  });
  return result.rows.map((row) => ({
    studentId: row.student_id,
    contactId: row.contact_id,
    name: row.full_name || null,
    phone: row.phone_e164 || null,
    optedIn: Number(row.whatsapp_opted_in) === 1,
    isPrimary: Number(row.is_primary) === 1,
    isFeePayer: Number(row.is_fee_payer) === 1,
  }));
}

/** The guardian fee messages go to: the fee payer, else the primary guardian (D5). */
export function feeRecipient(rows, studentId) {
  const mine = rows.filter((row) => row.studentId === studentId);
  return mine.find((row) => row.isFeePayer) || mine.find((row) => row.isPrimary) || null;
}

/**
 * Groups guardians by phone so one phone gets one copy (D5). Each group keeps
 * every student it covers. Rows without a phone are dropped; rows without
 * consent are returned separately.
 */
export function byPhone(rows) {
  const groups = new Map();
  const noConsent = [];
  for (const row of rows) {
    if (!row.phone) continue;
    if (!row.optedIn) { noConsent.push(row); continue; }
    const group = groups.get(row.phone) || { phone: row.phone, contactId: row.contactId, name: row.name, studentIds: [] };
    if (!group.studentIds.includes(row.studentId)) group.studentIds.push(row.studentId);
    groups.set(row.phone, group);
  }
  return { recipients: [...groups.values()], noConsent };
}

/** True when this phone messaged the connection in the last 24 hours (Meta's service window). */
export async function windowOpen(db, schoolId, connectionId, phone, now = Date.now()) {
  if (!connectionId || !phone) return false;
  const result = await db.execute({
    sql: `SELECT 1 FROM crm_comms_inbound WHERE school_id = ? AND connection_id = ? AND from_phone = ? AND received_at > ? LIMIT 1`,
    args: [schoolId, connectionId, phone, new Date(now - WINDOW_MS).toISOString()],
  });
  return result.rows.length > 0;
}

/** Start of the school-local month as an ISO instant. */
export function monthStartIso(now = Date.now(), timeZone = DEFAULT_TIMEZONE) {
  const { year, month } = zonedParts(now, timeZone);
  return new Date(zonedTimeToUtcMs({ year, month, day: 1 }, timeZone)).toISOString();
}

/** This month's sent messages and estimated cost (millipaise, before GST). */
export async function monthUsage(db, schoolId, { now = Date.now(), timeZone = DEFAULT_TIMEZONE } = {}) {
  const result = await db.execute({
    sql: `SELECT COALESCE(pricing_category, 'utility') AS category, COUNT(*) AS n, COALESCE(SUM(cost_millipaise), 0) AS cost
          FROM crm_comms_messages
          WHERE school_id = ? AND via = 'api' AND sent_at >= ? AND status IN ('sent', 'delivered', 'read')
          GROUP BY COALESCE(pricing_category, 'utility')`,
    args: [schoolId, monthStartIso(now, timeZone)],
  });
  const counts = { utility: 0, service: 0 };
  let costMillipaise = 0;
  for (const row of result.rows) {
    counts[row.category] = (counts[row.category] || 0) + Number(row.n);
    costMillipaise += Number(row.cost);
  }
  return { counts, costMillipaise };
}

/** Estimated cost of one message: templates are utility; free text is free until the month's allowance runs out. */
export function messageCost(templateKey, usage) {
  if (templateKey) return { category: 'utility', millipaise: WA_PRICES_MILLIPAISE.utility };
  const service = usage?.counts?.service || 0;
  return { category: 'service', millipaise: service >= WA_FREE_SERVICE_PER_MONTH ? WA_PRICES_MILLIPAISE.service : 0 };
}

/**
 * The INSERT for one outbox row plus its timeline subjects. A row whose dedup
 * key already exists (and isn't cancelled) is silently skipped, and so are its
 * subjects, so producers can repeat themselves safely.
 */
export function messageStatements(message, subjects = []) {
  const now = message.now || new Date().toISOString();
  const id = message.id || newMessageId();
  const definition = message.templateKey ? WA_TEMPLATES[message.templateKey] : null;
  const statements = [{
    sql: `INSERT OR IGNORE INTO crm_comms_messages (id, school_id, channel, via, kind, connection_id, template_key, template_language, template_version, contact_id, phone_e164,
            recipient_name, vars_json, body_text, ref_type, ref_id, ref_json, finance, status, status_code, status_reason, next_attempt_at, dedup_key, group_id,
            pricing_category, cost_millipaise, created_by, created_at, updated_at, sent_at)
          VALUES (?, ?, 'whatsapp', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id, message.schoolId, message.via || 'api', message.kind, message.connectionId || null, message.templateKey || null, message.language || null,
      definition ? definition.version : null, message.contactId || null, message.phone || null, message.recipientName || null,
      message.vars ? JSON.stringify(message.vars) : null, message.bodyText || null, message.refType || null, message.refId || null,
      message.ref ? JSON.stringify(message.ref) : null, (message.finance ?? definition?.finance) ? 1 : 0, message.status || 'queued', message.statusCode || null,
      message.statusReason || null, message.nextAttemptAt || null, message.dedupKey, message.groupId || null, message.pricingCategory || null,
      message.costMillipaise || 0, message.createdBy || null, now, now, message.sentAt || null,
    ],
  }];
  for (const subject of subjects) {
    statements.push({
      sql: `INSERT OR IGNORE INTO crm_comms_subjects (message_id, school_id, entity_type, entity_id, created_at)
            SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM crm_comms_messages WHERE id = ?)`,
      args: [id, message.schoolId, subject.entityType, subject.entityId, now, id],
    });
  }
  return { id, statements };
}

/** The allowlisted variables and rendered text for a template message. */
export function templateText(templateKey, language, vars) {
  return renderTemplate(templateKey, language, vars);
}

/** First names for "Arjun and Diya" style blanks. */
export function joinNames(names) {
  const list = [...new Set(names.filter(Boolean))];
  if (list.length <= 1) return list[0] || '';
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/** Runs queueing statements in one batch and returns how many new messages were queued (repeats are ignored). */
export async function queueBatch(db, statements) {
  if (!statements.length) return 0;
  const results = await db.batch(statements, 'write');
  return statements.reduce((count, statement, index) => (
    statement.sql.startsWith('INSERT OR IGNORE INTO crm_comms_messages') ? count + Number(results[index]?.rowsAffected || 0) : count
  ), 0);
}
