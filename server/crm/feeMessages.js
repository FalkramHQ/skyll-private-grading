// Fee reminders from the Fees screens (CRM M2 phase 2 S3, D7/D10): the
// student's reminder status, the manual Send reminder (once per fee payer per
// day), pausing reminders until a date, and revoking a guardian's fees links.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { dateOnly } from '../../shared/crm/classes.js';
import { phoneLink } from '../../shared/crm/comms.js';
import { localDate } from '../../shared/crm/time.js';
import { manualReminder, manualReminderStatements, pausedUntil } from '../comms/fees.js';
import { createLink } from '../comms/links.js';
import { messageStatements } from '../comms/outbox.js';
import { publicAppUrl } from '../comms/templates.js';
import { auditStatement } from './audit.js';
import { assertStudentsInCommsScope } from './commsScope.js';
import { CrmHttpError, crmErrors } from './errors.js';
import { loadStudent } from './invoices.js';
import { assertCan } from './permissions.js';

const studentId = z.string().trim().min(1).max(128);
export const reminderQuery = z.object({ studentId });
export const sendReminderBody = z.object({ studentId, via: z.enum(['api', 'phone']).default('api') }).strict();
export const pauseBody = z.object({ studentId, untilDate: dateOnly.nullable() }).strict();
export const revokeLinksBody = z.object({ studentId }).strict();

const FEE_KINDS = ['fee_due', 'fee_overdue', 'fee_manual'];

export async function getReminders({ db, scope, input }) {
  const student = await loadStudent(db, scope, input.query.studentId);
  const plan = await manualReminder(db, { schoolId: scope.schoolId, studentId: student.id });
  const [last, sentToday] = await Promise.all([
    db.execute({
      sql: `SELECT m.kind, m.status, m.status_reason, m.created_at, m.via FROM crm_comms_subjects s JOIN crm_comms_messages m ON m.id = s.message_id AND m.school_id = s.school_id
            WHERE s.school_id = ? AND s.entity_type = 'student' AND s.entity_id = ? AND m.kind IN (${FEE_KINDS.map(() => '?').join(', ')})
            ORDER BY m.created_at DESC LIMIT 1`,
      args: [scope.schoolId, student.id, ...FEE_KINDS],
    }),
    plan.dedupKey ? db.execute({ sql: "SELECT 1 FROM crm_comms_messages WHERE school_id = ? AND dedup_key = ? AND status != 'cancelled'", args: [scope.schoolId, plan.dedupKey] }) : { rows: [] },
  ]);
  const row = last.rows[0];
  return {
    connected: Boolean(plan.context.connection),
    payer: plan.payer ? { name: plan.payer.name, consent: plan.payer.optedIn, hasPhone: Boolean(plan.payer.phone) } : null,
    pausedUntil: await pausedUntil(db, scope.schoolId, student.id, plan.today),
    last: row ? { kind: row.kind, status: row.status, statusReason: row.status_reason || null, at: row.created_at, via: row.via } : null,
    sentToday: sentToday.rows.length > 0,
    nothingDue: !plan.unpaid.length,
  };
}

export async function sendReminder({ db, scope, input }) {
  assertCan(scope, 'crm.finance.read');
  const { via } = input.body;
  const student = await loadStudent(db, scope, input.body.studentId);
  await assertStudentsInCommsScope(db, scope, [student.id]);
  const now = Date.now();
  const plan = await manualReminder(db, { schoolId: scope.schoolId, studentId: student.id, now });
  if (!plan.unpaid.length) throw new CrmHttpError(422, 'nothing_due', 'Nothing is due for this student');
  if (!plan.payer?.phone) throw new CrmHttpError(422, 'no_payer_phone', 'The fee payer has no phone number');
  const nowIso = new Date(now).toISOString();

  if (via === 'phone') {
    // From the staff member's own phone: the same text plus a fees link.
    const token = await createLink(db, { schoolId: scope.schoolId, purpose: 'fees', contactId: plan.payer.contactId, now });
    const text = `${plan.text}\n\n${plan.context.settings.language === 'hi' ? 'फ़ीस देखें' : 'View fees'}: ${publicAppUrl()}/f/${token}`;
    const { statements } = messageStatements({
      schoolId: scope.schoolId, via: 'phone', kind: 'fee_manual', contactId: plan.payer.contactId, phone: plan.payer.phone, recipientName: plan.payer.name,
      bodyText: plan.text, finance: true, status: 'sent', sentAt: nowIso, dedupKey: `phone:${randomUUID()}`, createdBy: scope.actor.user_id || null, now: nowIso,
    }, [{ entityType: 'student', entityId: student.id }]);
    await db.batch(statements, 'write');
    return { link: phoneLink(plan.payer.phone, text) };
  }

  if (!plan.context.connection) throw new CrmHttpError(409, 'not_connected', 'WhatsApp isn’t connected for your class. Use Send from my phone.');
  if (!plan.payer.optedIn) throw new CrmHttpError(409, 'no_consent', 'The fee payer hasn’t agreed to WhatsApp messages. Use Send from my phone.');
  const existing = await db.execute({ sql: "SELECT 1 FROM crm_comms_messages WHERE school_id = ? AND dedup_key = ? AND status != 'cancelled'", args: [scope.schoolId, plan.dedupKey] });
  if (existing.rows.length) throw new CrmHttpError(409, 'already_reminded', `${plan.payer.name || 'The fee payer'} was already reminded today`);
  const { id, statements } = manualReminderStatements(plan, { createdBy: scope.actor.user_id || null, now: nowIso });
  await db.batch(statements, 'write');
  return { messageId: id, queued: 1, templateKey: plan.templateKey };
}

export async function pauseReminders({ db, scope, input }) {
  const student = await loadStudent(db, scope, input.body.studentId);
  const { untilDate } = input.body;
  const today = localDate(Date.now(), scope.timezone);
  if (untilDate && (untilDate < today || untilDate > '2100-12-31')) throw crmErrors.validation([{ path: 'untilDate', message: 'Choose a date from today' }]);
  const now = new Date().toISOString();
  const statements = [{
    sql: 'UPDATE crm_reminder_pauses SET ended_at = ?, ended_by = ?, updated_at = ? WHERE school_id = ? AND student_id = ? AND ended_at IS NULL',
    args: [now, scope.actor.user_id || null, now, scope.schoolId, student.id],
  }];
  if (untilDate) {
    statements.push({
      sql: 'INSERT INTO crm_reminder_pauses (id, school_id, student_id, until_date, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [`rp_${randomUUID()}`, scope.schoolId, student.id, untilDate, scope.actor.user_id || null, now, now],
    });
  }
  statements.push(auditStatement(scope, {
    action: 'reminder.paused', entityId: student.id, summary: untilDate ? { change: 'paused', untilDate } : { change: 'resumed' }, now,
  }));
  await db.batch(statements, 'write');
  return { pausedUntil: untilDate };
}

/** Revokes every live fees link sent to this student's fee payer (D10). */
export async function revokeFeeLinks({ db, scope, input }) {
  const student = await loadStudent(db, scope, input.body.studentId);
  const plan = await manualReminder(db, { schoolId: scope.schoolId, studentId: student.id });
  if (!plan.payer) return { revoked: 0 };
  const now = new Date().toISOString();
  const live = await db.execute({
    sql: "SELECT id FROM crm_access_links WHERE school_id = ? AND contact_id = ? AND purpose = 'fees' AND revoked_at IS NULL AND expires_at > ?",
    args: [scope.schoolId, plan.payer.contactId, now],
  });
  if (!live.rows.length) return { revoked: 0 };
  const statements = [];
  for (const link of live.rows) {
    statements.push({ sql: 'UPDATE crm_access_links SET revoked_at = ?, revoked_by = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL', args: [now, scope.actor.user_id || null, now, link.id] });
    statements.push(auditStatement(scope, { action: 'access_link.revoked', entityId: plan.payer.contactId, summary: { linkId: link.id, purpose: 'fees' }, now }));
  }
  await db.batch(statements, 'write');
  return { revoked: live.rows.length };
}
