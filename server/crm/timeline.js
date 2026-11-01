// Activity timeline for a lead or student (CRM-007, FLKRM-326 S3, D13): one
// newest-first feed merged from records that already exist — stage events,
// notes, task events and the CRM audit log — with no timeline table of its own.
// Items the viewer may not see are left out (e.g. tasks without task access).
import { z } from 'zod';
import { RETRYABLE_STATUS_CODES } from '../../shared/crm/comms.js';
import { NOTE_ENTITY_TYPES } from '../../shared/crm/notes.js';
import { can } from './permissions.js';
import { assertRecord } from './records.js';
import { taskScope } from './tasks.js';
import { commsOwnOnly, ownStudentFilter } from './commsScope.js';

const MAX_ITEMS = 200;

export const timelineQuery = z.object({
  entityType: z.enum(NOTE_ENTITY_TYPES),
  entityId: z.string().min(1).max(128),
  limit: z.coerce.number().int().min(1).max(MAX_ITEMS).default(100),
}).strict();

// Audit actions that describe something on the record itself. Stage changes
// come from crm_lead_stage_events (they carry the reason) and note text from
// crm_notes, so those audit rows are not repeated here.
const AUDIT_ACTIONS = ['lead.owner_changed', 'lead.updated', 'lead.converted', 'note.changed', 'record.tagged', 'student.owner_changed', 'guardian.changed', 'attendance.corrected'];

async function stageItems(db, scope, leadId, limit) {
  const result = await db.execute({
    sql: `SELECT e.id, e.reason, e.created_at, u.display_name AS actor_name,
                 fs.name AS from_name, fs.category AS from_category, ts.name AS to_name, ts.category AS to_category
          FROM crm_lead_stage_events e
          LEFT JOIN crm_pipeline_stages fs ON fs.id = e.from_stage_id AND fs.school_id = e.school_id
          LEFT JOIN crm_pipeline_stages ts ON ts.id = e.to_stage_id AND ts.school_id = e.school_id
          LEFT JOIN users u ON u.id = e.actor_user_id
          WHERE e.school_id = ? AND e.lead_id = ?
          ORDER BY e.created_at DESC, e.rowid DESC LIMIT ?`,
    args: [scope.schoolId, leadId, limit],
  });
  return result.rows.map((row) => (row.from_name
    ? {
      id: `stage:${row.id}`, kind: 'stage', at: row.created_at, actorName: row.actor_name || null,
      from: { name: row.from_name, category: row.from_category }, to: { name: row.to_name, category: row.to_category }, reason: row.reason || null,
    }
    : { id: `stage:${row.id}`, kind: 'created', at: row.created_at, actorName: row.actor_name || null, to: { name: row.to_name, category: row.to_category } }));
}

async function noteItems(db, scope, entityType, entityId, limit) {
  const result = await db.execute({
    sql: `SELECT n.id, n.body, n.version, n.created_at, u.display_name AS author_name
          FROM crm_notes n LEFT JOIN users u ON u.id = n.author_user_id
          WHERE n.school_id = ? AND n.entity_type = ? AND n.entity_id = ? AND n.archived_at IS NULL AND n.anonymised_at IS NULL
          ORDER BY n.created_at DESC LIMIT ?`,
    args: [scope.schoolId, entityType, entityId, limit],
  });
  return result.rows.map((row) => ({
    id: `note:${row.id}`, kind: 'note', at: row.created_at, actorName: row.author_name || null, noteId: row.id, body: row.body, edited: Number(row.version) > 1,
  }));
}

async function taskItems(db, scope, entityType, entityId, limit) {
  if (!can(scope, 'crm.tasks.read')) return [];
  const own = taskScope(scope) === 'own';
  const result = await db.execute({
    sql: `SELECT e.id, e.event_type, e.from_value, e.to_value, e.created_at, t.title, u.display_name AS actor_name,
                 fu.display_name AS from_name, tu.display_name AS to_name
          FROM crm_task_events e
          JOIN crm_tasks t ON t.id = e.task_id AND t.school_id = e.school_id
          LEFT JOIN users u ON u.id = e.actor_user_id
          LEFT JOIN users fu ON e.event_type = 'reassigned' AND fu.id = e.from_value
          LEFT JOIN users tu ON e.event_type IN ('reassigned', 'created') AND tu.id = e.to_value
          WHERE e.school_id = ? AND t.related_type = ? AND t.related_id = ? ${own ? 'AND t.owner_user_id = ?' : ''}
          ORDER BY e.created_at DESC, e.rowid DESC LIMIT ?`,
    args: [scope.schoolId, entityType, entityId, ...(own ? [scope.actor.user_id || ''] : []), limit],
  });
  return result.rows.map((row) => ({
    id: `task:${row.id}`,
    kind: 'task',
    at: row.created_at,
    actorName: row.actor_name || null,
    event: row.event_type,
    title: row.title,
    // Owner names for created/reassigned; due times for rescheduled.
    ...(row.event_type === 'rescheduled' ? { fromDueAt: row.from_value, toDueAt: row.to_value } : {}),
    ...(row.event_type === 'reassigned' ? { fromName: row.from_name || null, toName: row.to_name || null } : {}),
    ...(row.event_type === 'created' ? { toName: row.to_name || null } : {}),
  }));
}

async function auditItems(db, scope, entityType, entityId, limit) {
  const result = await db.execute({
    sql: `SELECT a.id, a.action, a.summary_json, a.created_at, u.display_name AS actor_name
          FROM crm_audit_events a LEFT JOIN users u ON u.id = a.actor_user_id
          WHERE a.school_id = ? AND a.entity_type = ? AND a.entity_id = ? AND a.action IN (${AUDIT_ACTIONS.map(() => '?').join(', ')})
          ORDER BY a.id DESC LIMIT ?`,
    args: [scope.schoolId, entityType, entityId, ...AUDIT_ACTIONS, limit],
  });
  const rows = result.rows.map((row) => ({ ...row, summary: JSON.parse(row.summary_json || '{}') }));
  const userIds = [...new Set(rows.filter((row) => row.action.endsWith('.owner_changed'))
    .flatMap((row) => [row.summary.fromOwnerUserId, row.summary.toOwnerUserId]).filter(Boolean))];
  const names = new Map();
  if (userIds.length) {
    const users = await db.execute({ sql: `SELECT id, display_name FROM users WHERE id IN (${userIds.map(() => '?').join(', ')})`, args: userIds });
    for (const user of users.rows) names.set(user.id, user.display_name);
  }
  const items = [];
  for (const row of rows) {
    const base = { id: `audit:${row.id}`, at: row.created_at, actorName: row.actor_name || null };
    const s = row.summary;
    if (row.action === 'lead.owner_changed' || row.action === 'student.owner_changed') {
      items.push({ ...base, kind: 'owner', fromName: names.get(s.fromOwnerUserId) || null, toName: names.get(s.toOwnerUserId) || null });
    } else if (row.action === 'lead.updated') {
      items.push({ ...base, kind: 'updated', fields: s.fields || [] });
    } else if (row.action === 'lead.converted') {
      items.push({ ...base, kind: 'converted', studentId: s.studentId, mode: s.mode });
    } else if (row.action === 'record.tagged') {
      items.push({ ...base, kind: 'tag', change: s.change, label: s.label });
    } else if (row.action === 'guardian.changed') {
      // Who the guardian is, is contact data; without contact access only the change shows.
      if (s.change === 'updated' && !(s.fields || []).length) continue;
      items.push({ ...base, kind: 'guardian', change: s.change, contactId: s.contactId, fields: s.fields || [] });
    } else if (row.action === 'attendance.corrected') {
      // Only people who can read attendance see corrections (D11).
      if (!can(scope, 'crm.attendance.read')) continue;
      items.push({ ...base, kind: 'attendance', sessionId: s.sessionId, from: s.from, to: s.to, reason: s.reason });
    } else if (row.action === 'note.changed' && s.change === 'removed') {
      // Added notes appear as themselves; edits show as "edited" on the note.
      items.push({ ...base, kind: 'note_removed' });
    }
  }
  return items;
}

const RETRYABLE_CODES = new Set(RETRYABLE_STATUS_CODES);

// The timeline keeps working on a database without migration 086 (no outbox yet).
let outboxExists = false;
async function hasOutbox(db) {
  if (outboxExists) return true;
  const result = await db.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'crm_comms_messages'");
  outboxExists = result.rows.length > 0;
  return outboxExists;
}

/** May this viewer see messages on this record? (D11: comms read; teachers only their own batches.) */
async function commsVisible(db, scope, entityType, entityId) {
  if (!can(scope, 'crm.comms.read')) return false;
  if (!(await hasOutbox(db))) return false;
  if (!commsOwnOnly(scope)) return true;
  if (entityType !== 'student') return false;
  const filter = await ownStudentFilter(db, scope, 's.id');
  const result = await db.execute({ sql: `SELECT 1 FROM students s WHERE s.id = ? AND s.school_id = ? AND ${filter.sql}`, args: [entityId, scope.schoolId, ...filter.args] });
  return result.rows.length > 0;
}

/**
 * WhatsApp messages about this record (D8/D11). Fee messages show their text
 * only with finance access; recipients' names only with contact access.
 */
async function messageItems(db, scope, entityType, entityId, limit) {
  const result = await db.execute({
    sql: `SELECT m.id, m.kind, m.via, m.status, m.status_code, m.status_reason, m.body_text, m.finance, m.recipient_name, m.template_key, m.created_at,
                 m.sent_at, m.delivered_at, m.read_at, m.text_purged_at, m.anonymised_at, u.display_name AS actor_name
          FROM crm_comms_subjects ms
          JOIN crm_comms_messages m ON m.id = ms.message_id AND m.school_id = ms.school_id
          LEFT JOIN users u ON u.id = m.created_by
          WHERE ms.school_id = ? AND ms.entity_type = ? AND ms.entity_id = ?
          ORDER BY m.created_at DESC LIMIT ?`,
    args: [scope.schoolId, entityType, entityId, limit],
  });
  const finance = can(scope, 'crm.finance.read');
  const contacts = can(scope, 'crm.contacts.read');
  return result.rows.map((row) => {
    const hidden = Number(row.finance) === 1 && !finance;
    return {
      id: `msg:${row.id}`,
      kind: 'message',
      at: row.created_at,
      actorName: row.actor_name || null,
      messageId: row.id,
      messageKind: row.kind,
      via: row.via,
      status: row.status,
      statusReason: row.status_reason || null,
      body: hidden || row.text_purged_at || row.anonymised_at ? null : row.body_text,
      amountsHidden: hidden,
      recipientName: contacts && !row.anonymised_at ? row.recipient_name || null : null,
      deliveredAt: row.delivered_at || null,
      readAt: row.read_at || null,
      retryable: row.status === 'failed' && RETRYABLE_CODES.has(String(row.status_code)),
    };
  });
}

/** What the record's guardians (or the lead's contact) sent to the class's number (D9). */
async function replyItems(db, scope, entityType, entityId, limit) {
  const contactSql = entityType === 'lead'
    ? 'SELECT primary_contact_id FROM crm_leads WHERE id = ? AND school_id = ?'
    : "SELECT contact_id FROM crm_guardian_links WHERE student_id = ? AND school_id = ? AND status = 'active'";
  const result = await db.execute({
    sql: `SELECT i.id, i.kind, i.body_text, i.media_label, i.is_stop, i.received_at, i.text_purged_at, i.anonymised_at, c.full_name, c.id AS contact_id
          FROM crm_comms_inbound i LEFT JOIN crm_contacts c ON c.id = i.contact_id AND c.school_id = i.school_id
          WHERE i.school_id = ? AND i.contact_id IN (${contactSql})
          ORDER BY i.received_at DESC LIMIT ?`,
    args: [scope.schoolId, entityId, scope.schoolId, limit],
  });
  const contacts = can(scope, 'crm.contacts.read');
  return result.rows.map((row) => ({
    id: `reply:${row.id}`,
    kind: 'reply',
    at: row.received_at,
    actorName: null,
    contactId: row.contact_id,
    fromName: contacts && !row.anonymised_at ? row.full_name || 'Guardian' : null,
    body: row.text_purged_at || row.anonymised_at ? null : row.body_text,
    mediaLabel: row.media_label || null,
    isStop: Number(row.is_stop) === 1,
  }));
}

/** Adds the class (batch and date) to attendance corrections. */
async function nameSessions(db, scope, items) {
  const ids = [...new Set(items.filter((item) => item.kind === 'attendance' && item.sessionId).map((item) => item.sessionId))];
  if (!ids.length) return items;
  const result = await db.execute({
    sql: `SELECT s.id, s.local_date, b.name FROM crm_class_sessions s JOIN batches b ON b.id = s.batch_id AND b.school_id = s.school_id
          WHERE s.school_id = ? AND s.id IN (${ids.map(() => '?').join(', ')})`,
    args: [scope.schoolId, ...ids],
  });
  const sessions = new Map(result.rows.map((row) => [row.id, { batchName: row.name, localDate: row.local_date }]));
  return items.map((item) => (item.kind === 'attendance' ? { ...item, ...sessions.get(item.sessionId) } : item));
}

/** Batch joins and leaves for a student, from canonical batch_memberships. */
async function batchItems(db, scope, studentId, limit) {
  const result = await db.execute({
    sql: `SELECT m.id, m.joined_at, m.left_at, b.name FROM batch_memberships m
          JOIN batches b ON b.id = m.batch_id AND b.school_id = ?
          WHERE m.student_id = ? ORDER BY m.joined_at DESC LIMIT ?`,
    args: [scope.schoolId, studentId, limit],
  });
  const items = [];
  for (const row of result.rows) {
    items.push({ id: `batch:${row.id}:joined`, kind: 'batch', change: 'joined', batchName: row.name, at: row.joined_at, actorName: null });
    if (row.left_at) items.push({ id: `batch:${row.id}:left`, kind: 'batch', change: 'left', batchName: row.name, at: row.left_at, actorName: null });
  }
  return items;
}

/** Adds guardian names to guardian items, only for people who may see contacts. */
async function nameGuardians(db, scope, items) {
  const guardianItems = items.filter((item) => item.kind === 'guardian');
  if (!guardianItems.length) return items;
  if (!can(scope, 'crm.contacts.read')) return items.map((item) => (item.kind === 'guardian' ? { ...item, contactId: undefined } : item));
  const ids = [...new Set(guardianItems.map((item) => item.contactId))];
  const result = await db.execute({
    sql: `SELECT id, full_name FROM crm_contacts WHERE school_id = ? AND anonymised_at IS NULL AND id IN (${ids.map(() => '?').join(', ')})`,
    args: [scope.schoolId, ...ids],
  });
  const names = new Map(result.rows.map((row) => [row.id, row.full_name]));
  return items.map((item) => (item.kind === 'guardian' ? { ...item, guardianName: names.get(item.contactId) || null, contactId: undefined } : item));
}

export async function getTimeline({ db, scope, input }) {
  const { entityType, entityId, limit } = input.query;
  await assertRecord(db, scope, entityType, entityId, 'read');
  const comms = await commsVisible(db, scope, entityType, entityId);
  const sources = await Promise.all([
    entityType === 'lead' ? stageItems(db, scope, entityId, limit) : batchItems(db, scope, entityId, limit),
    noteItems(db, scope, entityType, entityId, limit),
    taskItems(db, scope, entityType, entityId, limit),
    auditItems(db, scope, entityType, entityId, limit),
    comms ? messageItems(db, scope, entityType, entityId, limit) : [],
    comms ? replyItems(db, scope, entityType, entityId, limit) : [],
  ]);
  const items = sources.flat().sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, limit);
  return { items: await nameSessions(db, scope, await nameGuardians(db, scope, items)), nextCursor: null };
}
