// Staff messages (CRM-021, D5/D8/D11): the compose preview (who will get it,
// who is skipped and why, the 24-hour window and the estimated cost) and the
// send itself. Sending only queues outbox rows; the worker sends them. "Send
// from my phone" returns a wa.me link and records that it was used.
import { randomUUID } from 'node:crypto';
import {
  NOTICE_FIELD_SCHEMAS, RETRYABLE_STATUS_CODES, composeQuery, phoneLink, retryBody, sendMessageBody,
} from '../../shared/crm/comms.js';
import { WA_NOTICE_KEYS, WA_TEMPLATES } from '../../shared/crm/waTemplates.js';
import { estimateLabel } from '../../shared/crm/waPricing.js';
import { DEFAULT_TIMEZONE } from '../../shared/crm/time.js';
import {
  byPhone, guardianRows, joinNames, messageCost, messageStatements, monthUsage, templateText, windowOpen,
} from '../comms/outbox.js';
import { auditStatement } from './audit.js';
import { assertBatchInCommsScope, assertStudentsInCommsScope } from './commsScope.js';
import { CrmHttpError, crmErrors } from './errors.js';
import { can } from './permissions.js';
import { assertRecord } from './records.js';
import { activeConnection, waSettings } from './whatsapp.js';

export { composeQuery, retryBody, sendMessageBody };

const notConnected = () => new CrmHttpError(409, 'not_connected', 'WhatsApp isn’t connected for your class. Use Send from my phone, or ask an admin to connect it in Settings.');

/** Students a target covers, after access checks. */
async function targetStudents(db, scope, entityType, entityId) {
  if (entityType === 'student') {
    await assertRecord(db, scope, 'student', entityId, 'read');
    await assertStudentsInCommsScope(db, scope, [entityId]);
    const row = (await db.execute({ sql: 'SELECT id, display_name FROM students WHERE id = ? AND school_id = ?', args: [entityId, scope.schoolId] })).rows[0];
    return { students: [row], label: row.display_name, batch: null };
  }
  if (entityType === 'batch') {
    if (!can(scope, 'crm.classes.read') && !can(scope, 'crm.students.read')) throw crmErrors.forbidden();
    const batch = (await db.execute({ sql: "SELECT id, name FROM batches WHERE id = ? AND school_id = ? AND status != 'archived'", args: [entityId, scope.schoolId] })).rows[0];
    if (!batch) throw crmErrors.notFound();
    await assertBatchInCommsScope(db, scope, batch.id);
    const students = await db.execute({
      sql: `SELECT s.id, s.display_name FROM batch_memberships m JOIN students s ON s.id = m.student_id
            WHERE m.batch_id = ? AND m.status = 'active' AND s.school_id = ? AND s.status = 'active' ORDER BY s.display_name`,
      args: [batch.id, scope.schoolId],
    });
    return { students: students.rows, label: batch.name, batch };
  }
  return null;
}

async function leadTarget(db, scope, leadId) {
  await assertRecord(db, scope, 'lead', leadId, 'read');
  const row = (await db.execute({
    sql: `SELECT l.id, l.learner_name, c.id AS contact_id, c.full_name, c.phone_e164, c.whatsapp_opted_in
          FROM crm_leads l LEFT JOIN crm_contacts c ON c.id = l.primary_contact_id AND c.school_id = l.school_id AND c.anonymised_at IS NULL
          WHERE l.id = ? AND l.school_id = ?`,
    args: [leadId, scope.schoolId],
  })).rows[0];
  return row;
}

async function timezone(db, scope) {
  return scope.timezone || (await db.execute({ sql: 'SELECT timezone FROM schools WHERE id = ?', args: [scope.schoolId] })).rows[0]?.timezone || DEFAULT_TIMEZONE;
}

function connectionSummary(connection) {
  if (!connection) return null;
  return { displayPhone: connection.display_phone, health: connection.health, healthReason: connection.health_reason || null, mode: connection.mode };
}

/**
 * Everyone a message on this record would reach. Guardians without consent or
 * a phone are listed as skipped. Phones are shown only with contact access.
 */
export async function getCompose({ db, scope, input }) {
  const { entityType, entityId } = input.query;
  const connection = await activeConnection(db, scope.schoolId);
  const settings = await waSettings(db, scope);
  const showContacts = can(scope, 'crm.contacts.read');
  const now = Date.now();
  const usage = await monthUsage(db, scope.schoolId, { now, timeZone: await timezone(db, scope) });

  if (entityType === 'lead') {
    const lead = await leadTarget(db, scope, entityId);
    const recipients = [];
    const skipped = [];
    if (lead.contact_id && lead.phone_e164) {
      const open = Number(lead.whatsapp_opted_in) === 1 && await windowOpen(db, scope.schoolId, connection?.id, lead.phone_e164, now);
      recipients.push({ contactId: lead.contact_id, name: lead.full_name || 'Lead contact', phone: showContacts ? lead.phone_e164 : null, consent: Number(lead.whatsapp_opted_in) === 1, windowOpen: open, students: [lead.learner_name] });
    } else {
      skipped.push({ name: lead.full_name || 'Lead contact', reason: 'no_phone' });
    }
    return { target: { entityType, entityId, label: lead.learner_name }, connection: connectionSummary(connection), language: settings.language, senderName: settings.senderName,
    contactLine: settings.contactLine, notices: [], recipients, skipped, estimate: null };
  }

  const { students, label, batch } = await targetStudents(db, scope, entityType, entityId);
  const preview = await previewFor(db, scope, students, { connection, usage, now });
  return {
    target: { entityType, entityId, label, batchName: batch?.name || null, studentCount: students.length },
    connection: connectionSummary(connection),
    language: settings.language,
    senderName: settings.senderName,
    contactLine: settings.contactLine,
    notices: WA_NOTICE_KEYS.map((key) => ({ key, label: WA_TEMPLATES[key].label, fields: WA_TEMPLATES[key].fields })),
    ...preview,
  };
}

/**
 * Who a notice to these students would reach (one entry per phone), who is
 * skipped and why, and the estimated cost. Phones only with contact access.
 */
export async function previewFor(db, scope, students, { connection, usage, now = Date.now() }) {
  const showContacts = can(scope, 'crm.contacts.read');
  const rows = await guardianRows(db, scope.schoolId, students.map((student) => student.id));
  const names = new Map(students.map((student) => [student.id, student.display_name]));
  const { recipients, noConsent } = byPhone(rows);
  const recipientsOut = [];
  for (const recipient of recipients) {
    recipientsOut.push({
      contactId: recipient.contactId,
      name: recipient.name || 'Guardian',
      phone: showContacts ? recipient.phone : null,
      consent: true,
      windowOpen: Boolean(connection) && await windowOpen(db, scope.schoolId, connection.id, recipient.phone, now),
      students: recipient.studentIds.map((id) => names.get(id)),
    });
  }
  const withPhone = new Set(rows.filter((row) => row.phone).map((row) => row.studentId));
  const skipped = [
    ...noConsent.filter((row) => !recipients.some((recipient) => recipient.phone === row.phone)).map((row) => ({ name: row.name || 'Guardian', contactId: row.contactId, phone: showContacts ? row.phone : null, reason: 'no_consent', students: [names.get(row.studentId)] })),
    ...students.filter((student) => !withPhone.has(student.id)).map((student) => ({ name: student.display_name, reason: 'no_guardian_phone', students: [student.display_name] })),
  ];
  const cost = messageCost('notice_cancelled', usage);
  return {
    recipients: recipientsOut,
    skipped,
    estimate: { perMessageMillipaise: cost.millipaise, total: estimateLabel(cost.millipaise * recipientsOut.length) },
  };
}

function noticeFields(templateKey, fields = {}) {
  const definition = WA_TEMPLATES[templateKey];
  if (!definition?.notice) throw crmErrors.validation([{ path: 'templateKey', message: 'Choose a notice' }]);
  const values = {};
  const problems = [];
  for (const name of definition.fields) {
    const parsed = NOTICE_FIELD_SCHEMAS[name].safeParse(fields[name] ?? '');
    if (parsed.success) values[name] = parsed.data;
    else problems.push({ path: `fields.${name}`, message: parsed.error.issues[0].message });
  }
  if (problems.length) throw crmErrors.validation(problems);
  return values;
}

function baseVars(settings) {
  return { senderName: settings.senderName, contactLine: settings.contactLine, paymentInstructions: settings.paymentInstructions };
}

async function recordPhoneSend(db, scope, { contactId, phone, name, text, subjects, now }) {
  const { id, statements } = messageStatements({
    schoolId: scope.schoolId, via: 'phone', kind: 'free_text', contactId, phone, recipientName: name, bodyText: text,
    status: 'sent', sentAt: now, dedupKey: `phone:${randomUUID()}`, createdBy: scope.actor.user_id || null, now,
  }, subjects);
  await db.batch(statements, 'write');
  return id;
}

export async function sendMessage({ db, scope, input }) {
  const body = input.body;
  const now = new Date().toISOString();
  const settings = await waSettings(db, scope);
  const connection = await activeConnection(db, scope.schoolId);

  // Leads: free text inside the window, or the phone link (D8).
  if (body.entityType === 'lead') {
    if (body.mode === 'notice') throw crmErrors.validation([{ path: 'mode', message: 'Leads get messages, not class notices' }]);
    const lead = await leadTarget(db, scope, body.entityId);
    if (!lead.contact_id || !lead.phone_e164) throw crmErrors.validation([{ path: 'contactId', message: 'This lead has no phone number' }]);
    return sendText(db, scope, { connection, contact: { id: lead.contact_id, phone: lead.phone_e164, name: lead.full_name, optedIn: Number(lead.whatsapp_opted_in) === 1 }, body, subjects: [{ entityType: 'lead', entityId: lead.id }], now });
  }

  const { students, batch } = await targetStudents(db, scope, body.entityType, body.entityId);
  const rows = await guardianRows(db, scope.schoolId, students.map((student) => student.id));
  const names = new Map(students.map((student) => [student.id, student.display_name]));

  if (body.mode === 'text' || body.mode === 'phone') {
    const row = rows.find((candidate) => candidate.contactId === body.contactId && candidate.phone);
    if (!row) throw crmErrors.validation([{ path: 'contactId', message: 'Choose one of this record’s guardians' }]);
    const studentIds = rows.filter((candidate) => candidate.phone === row.phone).map((candidate) => candidate.studentId);
    const contact = { id: row.contactId, phone: row.phone, name: row.name, optedIn: rows.some((candidate) => candidate.phone === row.phone && candidate.optedIn) };
    const text = body.mode === 'phone' && body.templateKey
      ? templateText(body.templateKey, settings.language, { ...baseVars(settings), ...noticeFields(body.templateKey, body.fields), guardianName: row.name, studentName: joinNames(studentIds.map((id) => names.get(id))) })
      : body.text;
    return sendText(db, scope, { connection, contact, body: { ...body, text }, subjects: [...new Set(studentIds)].map((id) => ({ entityType: 'student', entityId: id })), now });
  }

  // A class notice to every consenting guardian, one copy per phone (D5).
  return queueNotice(db, scope, {
    connection, settings, rows, names, templateKey: body.templateKey, fields: body.fields, now,
    refType: batch ? 'batch' : 'student', refId: body.entityId, batchIds: batch ? [batch.id] : undefined, audit: Boolean(batch),
  });
}

/**
 * Queues a class notice for every consenting guardian in `rows`, one copy per
 * phone, and audits group sends with counts only (D5, D8).
 */
export async function queueNotice(db, scope, { connection, settings, rows, names, templateKey, fields: rawFields, now, refType, refId, batchIds, audit }) {
  if (!connection) throw notConnected();
  const fields = noticeFields(templateKey, rawFields);
  const { recipients, noConsent } = byPhone(rows);
  if (!recipients.length) throw crmErrors.validation([{ path: 'recipients', message: 'Nobody here has agreed to WhatsApp messages yet' }]);
  const groupId = `grp_${randomUUID()}`;
  const statements = [];
  for (const recipient of recipients) {
    const vars = { ...baseVars(settings), ...fields, guardianName: recipient.name, studentName: joinNames(recipient.studentIds.map((id) => names.get(id))) };
    statements.push(...messageStatements({
      schoolId: scope.schoolId, kind: 'notice', connectionId: connection.id, templateKey, language: settings.language,
      contactId: recipient.contactId, phone: recipient.phone, recipientName: recipient.name, vars, bodyText: templateText(templateKey, settings.language, vars),
      dedupKey: `notice:${groupId}:${recipient.contactId}`, groupId, refType, refId, createdBy: scope.actor.user_id || null, now,
    }, recipient.studentIds.map((id) => ({ entityType: 'student', entityId: id }))).statements);
  }
  const skipped = noConsent.filter((row) => !recipients.some((recipient) => recipient.phone === row.phone)).length;
  if (audit || recipients.length > 1) {
    statements.push(auditStatement(scope, {
      action: 'message.group_sent', entityId: scope.schoolId,
      summary: { sendId: groupId, templateKey, recipients: recipients.length, skipped, ...(batchIds?.length ? { batchIds } : {}) }, now,
    }));
  }
  await db.batch(statements, 'write');
  return { groupId, queued: recipients.length, skipped };
}

async function sendText(db, scope, { connection, contact, body, subjects, now }) {
  const text = String(body.text || '').trim();
  if (!text) throw crmErrors.validation([{ path: 'text', message: 'Write a message' }]);
  if (body.mode === 'phone') {
    const messageId = await recordPhoneSend(db, scope, { contactId: contact.id, phone: contact.phone, name: contact.name, text, subjects, now });
    return { messageId, link: phoneLink(contact.phone, text) };
  }
  if (!connection) throw notConnected();
  if (!contact.optedIn) throw new CrmHttpError(409, 'no_consent', 'This parent hasn’t agreed to WhatsApp messages. Use Send from my phone.');
  if (!(await windowOpen(db, scope.schoolId, connection.id, contact.phone))) {
    throw new CrmHttpError(409, 'window_closed', 'It’s been more than 24 hours since this parent last messaged, so WhatsApp only allows approved messages. Use Send from my phone.');
  }
  const { id, statements } = messageStatements({
    schoolId: scope.schoolId, kind: 'free_text', connectionId: connection.id, contactId: contact.id, phone: contact.phone, recipientName: contact.name,
    bodyText: text, dedupKey: `text:${randomUUID()}`, createdBy: scope.actor.user_id || null, now,
  }, subjects);
  await db.batch(statements, 'write');
  return { messageId: id, queued: 1 };
}

const RETRYABLE = new Set(RETRYABLE_STATUS_CODES);

export async function retryMessage({ db, scope, input }) {
  const message = (await db.execute({ sql: 'SELECT * FROM crm_comms_messages WHERE id = ? AND school_id = ?', args: [input.body.messageId, scope.schoolId] })).rows[0];
  if (!message) throw crmErrors.notFound();
  const subjects = (await db.execute({ sql: "SELECT entity_id FROM crm_comms_subjects WHERE message_id = ? AND entity_type = 'student'", args: [message.id] })).rows.map((row) => row.entity_id);
  if (subjects.length) await assertStudentsInCommsScope(db, scope, subjects);
  if (message.status !== 'failed' || !RETRYABLE.has(String(message.status_code))) {
    throw new CrmHttpError(422, 'not_retryable', 'Only messages that failed for a temporary reason can be retried');
  }
  const now = new Date().toISOString();
  await db.execute({
    sql: `UPDATE crm_comms_messages SET status = 'queued', attempts = 0, next_attempt_at = NULL, status_code = NULL, status_reason = NULL, failed_at = NULL, updated_at = ?
          WHERE id = ? AND school_id = ? AND status = 'failed'`,
    args: [now, message.id, scope.schoolId],
  });
  return { messageId: message.id, status: 'queued' };
}
