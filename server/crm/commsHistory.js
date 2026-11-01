// Communications page (CRM M2 phase 2 S5, D8/D9/D11/D12): every message and
// its status, parents' replies (and replies from unknown numbers), and class
// notices to a filtered group. Teachers granted comms access see and message
// only their own batches; fee message text needs finance access.
import { z } from 'zod';
import { RETRYABLE_STATUS_CODES } from '../../shared/crm/comms.js';
import { WA_NOTICE_KEYS, WA_TEMPLATES } from '../../shared/crm/waTemplates.js';
import { localDate } from '../../shared/crm/time.js';
import { guardianRows, monthUsage, windowOpen } from '../comms/outbox.js';
import { commsOwnOnly, ownBatchIds, ownStudentFilter } from './commsScope.js';
import { crmErrors } from './errors.js';
import { decodeCursor, toPage } from './pagination.js';
import { PAID_SQL } from './ledger.js';
import { previewFor, queueNotice } from './messages.js';
import { can } from './permissions.js';
import { activeConnection, waSettings } from './whatsapp.js';

const RETRYABLE = new Set(RETRYABLE_STATUS_CODES);
const id = z.string().trim().min(1).max(128);
const KINDS = ['fee', 'receipt', 'report_ready', 'absent', 'notice', 'free_text'];
const STATUS_FILTERS = ['attention', 'failed', 'held', 'sent', 'skipped'];

export const historyQuery = z.object({
  kind: z.enum(KINDS).optional(),
  status: z.enum(STATUS_FILTERS).optional(),
  batchId: id.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(512).optional(),
});

const KIND_SQL = {
  fee: "m.kind IN ('fee_due', 'fee_overdue', 'fee_manual')",
  receipt: "m.kind = 'receipt'",
  report_ready: "m.kind = 'report_ready'",
  absent: "m.kind = 'absent'",
  notice: "m.kind = 'notice'",
  free_text: "m.kind IN ('free_text', 'stop_ack')",
};
const STATUS_SQL = {
  attention: "m.status IN ('failed', 'held')",
  failed: "m.status = 'failed'",
  held: "m.status = 'held'",
  sent: "m.status IN ('sent', 'delivered', 'read')",
  skipped: "m.status IN ('skipped', 'cancelled')",
};

/** Names of the students and leads each message is about. */
async function subjectsFor(db, scope, messageIds) {
  if (!messageIds.length) return new Map();
  const result = await db.execute({
    sql: `SELECT ms.message_id, ms.entity_type, ms.entity_id, COALESCE(st.display_name, l.learner_name) AS name
          FROM crm_comms_subjects ms
          LEFT JOIN students st ON ms.entity_type = 'student' AND st.id = ms.entity_id AND st.school_id = ms.school_id
          LEFT JOIN crm_leads l ON ms.entity_type = 'lead' AND l.id = ms.entity_id AND l.school_id = ms.school_id
          WHERE ms.school_id = ? AND ms.message_id IN (${messageIds.map(() => '?').join(', ')})`,
    args: [scope.schoolId, ...messageIds],
  });
  const byMessage = new Map();
  for (const row of result.rows) {
    const list = byMessage.get(row.message_id) || [];
    list.push({ entityType: row.entity_type, entityId: row.entity_id, name: row.name || null });
    byMessage.set(row.message_id, list);
  }
  return byMessage;
}

export async function listMessages({ db, scope, input }) {
  const { kind, status, batchId, limit, cursor } = input.query;
  const clauses = ['m.school_id = ?'];
  const args = [scope.schoolId];
  if (kind) clauses.push(KIND_SQL[kind]);
  if (status) clauses.push(STATUS_SQL[status]);
  if (batchId) {
    clauses.push(`EXISTS (SELECT 1 FROM crm_comms_subjects ms JOIN batch_memberships bm ON bm.student_id = ms.entity_id AND bm.batch_id = ?
                    WHERE ms.message_id = m.id AND ms.entity_type = 'student')`);
    args.push(batchId);
  }
  const own = await ownStudentFilter(db, scope, 'ms.entity_id');
  if (own) {
    clauses.push(`EXISTS (SELECT 1 FROM crm_comms_subjects ms WHERE ms.message_id = m.id AND ms.entity_type = 'student' AND ${own.sql})`);
    args.push(...own.args);
  }
  const after = decodeCursor(cursor, 2);
  if (after) { clauses.push('(m.created_at < ? OR (m.created_at = ? AND m.id < ?))'); args.push(after[0], after[0], after[1]); }
  const result = await db.execute({
    sql: `SELECT m.id, m.kind, m.via, m.status, m.status_code, m.status_reason, m.body_text, m.finance, m.recipient_name, m.created_at,
                 m.sent_at, m.delivered_at, m.read_at, m.cost_millipaise, m.text_purged_at, m.anonymised_at, u.display_name AS actor_name
          FROM crm_comms_messages m LEFT JOIN users u ON u.id = m.created_by
          WHERE ${clauses.join(' AND ')}
          ORDER BY m.created_at DESC, m.id DESC LIMIT ?`,
    args: [...args, limit + 1],
  });
  const page = toPage(result.rows, limit, (row) => [row.created_at, row.id]);
  const subjects = await subjectsFor(db, scope, page.items.map((row) => row.id));
  const finance = can(scope, 'crm.finance.read');
  const contacts = can(scope, 'crm.contacts.read');
  return {
    items: page.items.map((row) => {
      const hidden = Number(row.finance) === 1 && !finance;
      return {
        id: row.id,
        at: row.created_at,
        kind: row.kind,
        via: row.via,
        status: row.status,
        statusReason: row.status_reason || null,
        retryable: row.status === 'failed' && RETRYABLE.has(String(row.status_code)),
        recipientName: contacts && !row.anonymised_at ? row.recipient_name || null : null,
        actorName: row.actor_name || null,
        body: hidden || row.text_purged_at || row.anonymised_at ? null : row.body_text,
        amountsHidden: hidden,
        subjects: subjects.get(row.id) || [],
        deliveredAt: row.delivered_at || null,
        readAt: row.read_at || null,
      };
    }),
    nextCursor: page.nextCursor,
  };
}

export const repliesQuery = z.object({
  view: z.enum(['matched', 'unknown']).default('matched'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(512).optional(),
});

/**
 * Parents' replies with the students (or leads) they belong to, newest first;
 * `unknown` lists numbers that match no contact (D9). Teachers see only
 * replies about their own students, and never unknown numbers.
 */
export async function listReplies({ db, scope, input }) {
  const { view, limit, cursor } = input.query;
  if (view === 'unknown' && commsOwnOnly(scope)) return { items: [], nextCursor: null };
  const connection = await activeConnection(db, scope.schoolId);
  const clauses = ['i.school_id = ?', view === 'unknown' ? 'i.contact_id IS NULL' : 'i.contact_id IS NOT NULL'];
  const args = [scope.schoolId];
  const own = await ownStudentFilter(db, scope, 'g.student_id');
  if (own) {
    clauses.push(`EXISTS (SELECT 1 FROM crm_guardian_links g WHERE g.school_id = i.school_id AND g.contact_id = i.contact_id AND g.status = 'active' AND ${own.sql})`);
    args.push(...own.args);
  }
  const after = decodeCursor(cursor, 2);
  if (after) { clauses.push('(i.received_at < ? OR (i.received_at = ? AND i.id < ?))'); args.push(after[0], after[0], after[1]); }
  const result = await db.execute({
    sql: `SELECT i.id, i.contact_id, i.from_phone, i.kind, i.body_text, i.media_label, i.is_stop, i.received_at, i.text_purged_at, i.anonymised_at, c.full_name
          FROM crm_comms_inbound i LEFT JOIN crm_contacts c ON c.id = i.contact_id AND c.school_id = i.school_id
          WHERE ${clauses.join(' AND ')}
          ORDER BY i.received_at DESC, i.id DESC LIMIT ?`,
    args: [...args, limit + 1],
  });
  const page = toPage(result.rows, limit, (row) => [row.received_at, row.id]);
  const contactIds = [...new Set(page.items.map((row) => row.contact_id).filter(Boolean))];
  const records = new Map();
  if (contactIds.length) {
    const linked = await db.execute({
      sql: `SELECT g.contact_id, 'student' AS entity_type, s.id AS entity_id, s.display_name AS name
            FROM crm_guardian_links g JOIN students s ON s.id = g.student_id AND s.school_id = g.school_id
            WHERE g.school_id = ? AND g.status = 'active' AND s.status != 'archived' AND g.contact_id IN (${contactIds.map(() => '?').join(', ')})
            UNION ALL
            SELECT l.primary_contact_id, 'lead', l.id, l.learner_name FROM crm_leads l
            WHERE l.school_id = ? AND l.archived_at IS NULL AND l.converted_student_id IS NULL AND l.primary_contact_id IN (${contactIds.map(() => '?').join(', ')})`,
      args: [scope.schoolId, ...contactIds, scope.schoolId, ...contactIds],
    });
    for (const row of linked.rows) {
      const list = records.get(row.contact_id) || [];
      list.push({ entityType: row.entity_type, entityId: row.entity_id, name: row.name });
      records.set(row.contact_id, list);
    }
  }
  const contacts = can(scope, 'crm.contacts.read');
  const items = [];
  for (const row of page.items) {
    items.push({
      id: row.id,
      at: row.received_at,
      contactId: row.contact_id || null,
      fromName: contacts && !row.anonymised_at ? row.full_name || null : null,
      fromPhone: contacts && !row.anonymised_at ? row.from_phone : null,
      body: row.text_purged_at || row.anonymised_at ? null : row.body_text,
      mediaLabel: row.media_label || null,
      isStop: Number(row.is_stop) === 1,
      records: records.get(row.contact_id) || [],
      windowOpen: Boolean(connection) && Date.parse(row.received_at) > Date.now() - 24 * 3600_000
        && await windowOpen(db, scope.schoolId, connection.id, row.from_phone),
    });
  }
  return { items, nextCursor: page.nextCursor };
}

// ------------------------------------------------------- group notices --

const csv = z.string().trim().max(3000).optional().transform((value) => (value ? value.split(',').map((item) => item.trim()).filter(Boolean).slice(0, 20) : []));
export const groupFiltersQuery = z.object({
  batchIds: csv,
  courseId: id.optional(),
  overdueOnly: z.enum(['true', 'false']).optional().transform((value) => value === 'true'),
});
export const groupSendBody = z.object({
  filters: z.object({ batchIds: z.array(id).max(20).default([]), courseId: id.optional(), overdueOnly: z.boolean().default(false) }).strict(),
  templateKey: z.enum(WA_NOTICE_KEYS),
  fields: z.record(z.string(), z.string().max(200)).optional(),
}).strict();

/** Active students matching the filters, within a teacher's own batches. */
async function studentsForFilters(db, scope, { batchIds = [], courseId, overdueOnly }) {
  if (!batchIds.length && !courseId && !overdueOnly) throw crmErrors.validation([{ path: 'filters', message: 'Choose at least one batch, a course, or overdue fees' }]);
  if (overdueOnly && !can(scope, 'crm.finance.read')) throw crmErrors.forbidden();
  const clauses = ["s.school_id = ?", "s.status = 'active'"];
  const args = [scope.schoolId];
  let batches = batchIds;
  if (commsOwnOnly(scope)) {
    const own = await ownBatchIds(db, scope);
    batches = batches.length ? batches.filter((batch) => own.includes(batch)) : own;
    if (!batches.length) throw crmErrors.forbidden();
  }
  if (batches.length) {
    clauses.push(`EXISTS (SELECT 1 FROM batch_memberships m JOIN batches b ON b.id = m.batch_id AND b.school_id = s.school_id
                   WHERE m.student_id = s.id AND m.status = 'active' AND m.batch_id IN (${batches.map(() => '?').join(', ')}))`);
    args.push(...batches);
  }
  if (courseId) {
    clauses.push(`EXISTS (SELECT 1 FROM batch_memberships m JOIN crm_batch_settings bs ON bs.batch_id = m.batch_id AND bs.school_id = s.school_id
                   WHERE m.student_id = s.id AND m.status = 'active' AND bs.course_id = ?)`);
    args.push(courseId);
  }
  if (overdueOnly) {
    clauses.push(`EXISTS (SELECT 1 FROM crm_invoices i WHERE i.school_id = s.school_id AND i.student_id = s.id AND i.status = 'issued' AND i.due_date < ? AND i.total_paise > ${PAID_SQL})`);
    args.push(localDate(Date.now(), scope.timezone));
  }
  const result = await db.execute({ sql: `SELECT s.id, s.display_name FROM students s WHERE ${clauses.join(' AND ')} ORDER BY s.display_name LIMIT 2000`, args });
  return { students: result.rows, batches };
}

export async function previewGroup({ db, scope, input }) {
  const { students } = await studentsForFilters(db, scope, input.query);
  const [connection, settings] = await Promise.all([activeConnection(db, scope.schoolId), waSettings(db, scope)]);
  const usage = await monthUsage(db, scope.schoolId, { timeZone: scope.timezone });
  return {
    target: { entityType: 'group', label: `${students.length} students`, studentCount: students.length },
    connection: connection ? { displayPhone: connection.display_phone, health: connection.health, healthReason: connection.health_reason || null, mode: connection.mode } : null,
    language: settings.language,
    senderName: settings.senderName,
    contactLine: settings.contactLine,
    notices: WA_NOTICE_KEYS.map((key) => ({ key, label: WA_TEMPLATES[key].label, fields: WA_TEMPLATES[key].fields })),
    ...await previewFor(db, scope, students, { connection, usage }),
  };
}

export async function sendGroup({ db, scope, input }) {
  const { filters, templateKey, fields } = input.body;
  const { students, batches } = await studentsForFilters(db, scope, filters);
  const [connection, settings] = await Promise.all([activeConnection(db, scope.schoolId), waSettings(db, scope)]);
  const rows = await guardianRows(db, scope.schoolId, students.map((student) => student.id));
  const names = new Map(students.map((student) => [student.id, student.display_name]));
  return queueNotice(db, scope, {
    connection, settings, rows, names, templateKey, fields, now: new Date().toISOString(), refType: 'group', refId: null, batchIds: batches, audit: true,
  });
}

// ------------------------------------------------------ page support --

/** The banner at the top of Communications (D12, D13): connection, health and what needs attention. */
export async function commsStatus({ db, scope }) {
  const connection = await activeConnection(db, scope.schoolId);
  const counts = await db.execute({
    sql: "SELECT status, COUNT(*) AS n FROM crm_comms_messages WHERE school_id = ? AND status IN ('held', 'failed', 'queued') AND created_at > ? GROUP BY status",
    args: [scope.schoolId, new Date(Date.now() - 7 * 86_400_000).toISOString()],
  });
  const count = (status) => Number(counts.rows.find((row) => row.status === status)?.n || 0);
  return {
    connection: connection ? { displayPhone: connection.display_phone, health: connection.health, healthReason: connection.health_reason || null, mode: connection.mode } : null,
    held: count('held'),
    failedThisWeek: count('failed'),
    queued: count('queued'),
    canManage: can(scope, 'crm.settings.manage'),
  };
}

/** Batches and courses to filter a group notice by (teachers: their own batches). */
export async function groupOptions({ db, scope }) {
  const own = commsOwnOnly(scope) ? await ownBatchIds(db, scope) : null;
  const batches = await db.execute({
    sql: `SELECT b.id, b.name, (SELECT COUNT(*) FROM batch_memberships m WHERE m.batch_id = b.id AND m.status = 'active') AS students
          FROM batches b WHERE b.school_id = ? AND b.status = 'active' ${own ? `AND b.id IN (${own.map(() => '?').join(', ') || "''"})` : ''}
          ORDER BY b.name`,
    args: [scope.schoolId, ...(own || [])],
  });
  const courses = own ? { rows: [] } : await db.execute({
    sql: "SELECT id, name FROM crm_courses WHERE school_id = ? AND status = 'active' ORDER BY name", args: [scope.schoolId],
  });
  return {
    batches: batches.rows.filter((row) => Number(row.students) > 0).map((row) => ({ id: row.id, name: row.name, students: Number(row.students) })),
    courses: courses.rows.map((row) => ({ id: row.id, name: row.name })),
    canFilterOverdue: can(scope, 'crm.finance.read'),
  };
}
