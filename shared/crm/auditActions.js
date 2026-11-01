// CRM audit actions (CRM-006). Each action declares the only summary fields it
// may store. Audit rows hold IDs and redacted summaries, never raw personal
// data, so erasing a person never requires editing the audit log.
import { z } from 'zod';

export class CrmAuditError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CrmAuditError';
  }
}

const id = z.string().min(1).max(128);
const state = z.string().min(1).max(64);
// Business justification only; the UI asks staff not to include personal details.
const reason = z.string().trim().max(280);
const paise = z.number().int().nonnegative();

const transition = { from: state, to: state, reason: reason.optional() };

export const AUDIT_ACTIONS = Object.freeze({
  'lead.stage_changed': {
    entityType: 'lead',
    summary: z.object({
      fromStageId: id.nullable(),
      toStageId: id,
      fromCategory: state.nullable(),
      toCategory: state,
      lostReasonKey: state.optional(),
      reason: reason.optional(),
    }),
  },
  'lead.created': {
    entityType: 'lead',
    summary: z.object({
      stageId: id,
      channel: z.enum(['manual', 'public_form']),
      sourceKey: state.optional(),
      // Staff saw a possible-duplicate warning and chose to create anyway.
      duplicateOverride: z.boolean(),
    }),
  },
  'lead.updated': {
    entityType: 'lead',
    // Field names only; the values may be personal data.
    summary: z.object({ fields: z.array(z.enum(['learnerName', 'learnerGrade', 'sourceKey', 'interest'])).min(1) }),
  },
  'lead.converted': {
    entityType: 'lead',
    summary: z.object({ studentId: id, mode: z.enum(['linked', 'created']) }),
  },
  'lead.owner_changed': {
    entityType: 'lead',
    summary: z.object({ fromOwnerUserId: id.nullable(), toOwnerUserId: id.nullable() }),
  },
  'task.changed': {
    entityType: 'task',
    // Titles and details can name people, so only ids, times and the change are kept.
    summary: z.object({
      change: z.enum(['created', 'completed', 'reopened', 'cancelled', 'rescheduled', 'reassigned']),
      relatedType: z.enum(['lead', 'student']).optional(),
      relatedId: id.optional(),
      ownerUserId: id.nullable().optional(),
      fromDueAt: z.string().max(40).optional(),
      toDueAt: z.string().max(40).optional(),
      fromOwnerUserId: id.nullable().optional(),
      toOwnerUserId: id.nullable().optional(),
      auto: z.boolean().optional(),
    }),
  },
  // Written against the lead or student the note belongs to, so it shows on
  // that record's timeline. Never the note text.
  'note.changed': {
    entityType: 'lead',
    summary: z.object({ change: z.enum(['added', 'edited', 'removed']), noteId: id }),
  },
  // Written against the tagged record. Tag labels are school configuration.
  'record.tagged': {
    entityType: 'lead',
    summary: z.object({ change: z.enum(['added', 'removed']), tagId: id, label: z.string().max(40) }),
  },
  'tag.changed': {
    entityType: 'tag',
    summary: z.object({
      change: z.enum(['created', 'renamed', 'recolored', 'archived', 'restored']),
      fromLabel: z.string().max(40).optional(),
      toLabel: z.string().max(40).optional(),
      color: z.string().max(16).optional(),
    }),
  },
  // Written against the student, so it appears on the student's timeline.
  // Ids only: guardian names and phones are contact data.
  'guardian.changed': {
    entityType: 'student',
    summary: z.object({
      change: z.enum(['added', 'restored', 'updated', 'primary_changed', 'removed']),
      linkId: id,
      contactId: id,
      fields: z.array(z.enum(['relationship', 'isEmergency', 'isFeePayer'])).optional(),
    }),
  },
  'contact.updated': {
    entityType: 'contact',
    summary: z.object({
      fields: z.array(z.enum(['name', 'email', 'phone', 'preferredChannel', 'whatsappOptIn'])).min(1),
      whatsappOptIn: z.boolean().optional(),
    }),
  },
  'student.owner_changed': {
    entityType: 'student',
    summary: z.object({ fromOwnerUserId: id.nullable(), toOwnerUserId: id.nullable() }),
  },
  'enrollment.changed': {
    entityType: 'student',
    summary: z.object({ ...transition, academicYearId: id.optional() }),
  },
  // Written against the student, so corrections show on the student's
  // timeline (FLKRM-327 D9). The reason is the picklist label or "Other: …".
  'attendance.corrected': {
    entityType: 'student',
    summary: z.object({ studentId: id, sessionId: id.optional(), from: state, to: state, reason, reasonKey: state.optional() }),
  },
  // One per save of a class's sheet: counts only, never names (D9).
  'attendance.marked': {
    entityType: 'class_session',
    summary: z.object({
      batchId: id,
      localDate: z.string().max(10),
      firstMarks: z.number().int().nonnegative(),
      corrections: z.number().int().nonnegative(),
      counts: z.object({ present: z.number().int().nonnegative(), absent: z.number().int().nonnegative(), late: z.number().int().nonnegative(), excused: z.number().int().nonnegative() }),
    }),
  },
  // Re-specified for CRM M2 phase 1 (D4): issued, voided (reason) or issued as
  // a correction of another invoice. Invoice numbers are not personal data.
  'invoice.changed': {
    entityType: 'invoice',
    summary: z.object({
      change: z.enum(['issued', 'voided', 'corrected']),
      number: z.string().max(40),
      amountPaise: paise,
      reason: reason.optional(),
      replacesInvoiceId: id.optional(),
    }),
  },
  // Re-specified for CRM M2 phase 1 (D5): never the reference or internal note.
  'payment.changed': {
    entityType: 'payment',
    summary: z.object({
      change: z.enum(['recorded', 'reversed']),
      receiptNumber: z.string().max(40),
      amountPaise: paise,
      method: z.enum(['cash', 'upi', 'bank_transfer', 'cheque', 'card', 'other']),
      allocatedPaise: paise.optional(),
      reason: reason.optional(),
    }),
  },
  // Part of a payment moved between invoices or credit (D5), including credit applied to new invoices.
  'allocation.changed': {
    entityType: 'payment',
    summary: z.object({
      change: z.enum(['allocated', 'released', 'moved']),
      fromInvoiceId: id.optional(),
      toInvoiceId: id.optional(),
      amountPaise: paise,
      reason: reason.optional(),
    }),
  },
  'refund.changed': {
    entityType: 'refund',
    summary: z.object({ ...transition, paymentId: id.optional(), amountPaise: paise.optional() }),
  },
  'permission.granted': {
    entityType: 'user',
    summary: z.object({ capability: state, preset: state.optional() }),
  },
  'permission.revoked': {
    entityType: 'user',
    summary: z.object({ capability: state }),
  },
  'data.exported': {
    entityType: 'export',
    summary: z.object({ exportType: state, rowCount: z.number().int().nonnegative(), filters: z.record(z.string(), z.string().max(128)).optional() }),
  },
  'record.merged': {
    entityType: 'record',
    summary: z.object({ survivorId: id, mergedId: id, mergedEntityType: state }),
  },
  'pipeline.changed': {
    entityType: 'pipeline',
    // Stage names are school configuration, not personal data.
    summary: z.object({
      change: z.enum(['stage_renamed', 'stages_reordered', 'stage_added', 'stage_archived', 'requirements_changed']),
      stageId: id.optional(),
      fromName: z.string().max(60).optional(),
      toName: z.string().max(60).optional(),
      category: state.optional(),
      destinationStageId: id.optional(),
      movedLeads: z.number().int().nonnegative().optional(),
      requirements: z.array(state).optional(),
    }),
  },
  'inquiry_form.changed': {
    entityType: 'school',
    summary: z.object({ enabled: z.boolean(), defaultOwnerUserId: id.nullable() }),
  },
  // Classes (FLKRM-327). Course, batch and room names are school configuration.
  'course.changed': {
    entityType: 'course',
    summary: z.object({
      change: z.enum(['created', 'updated', 'archived', 'restored']),
      name: z.string().max(120).optional(),
      fields: z.array(state).optional(),
    }),
  },
  'batch.changed': {
    entityType: 'batch',
    summary: z.object({
      change: z.enum(['created', 'updated', 'course_linked', 'archived']),
      name: z.string().max(120).optional(),
      fields: z.array(state).optional(),
      courseId: id.nullable().optional(),
      cancelledSessions: z.number().int().nonnegative().optional(),
    }),
  },
  'room.changed': {
    entityType: 'room',
    summary: z.object({
      change: z.enum(['created', 'updated', 'archived', 'restored']),
      name: z.string().max(60).optional(),
      seats: z.number().int().positive().nullable().optional(),
    }),
  },
  // Written against the batch.
  'instructor.changed': {
    entityType: 'batch',
    summary: z.object({
      change: z.enum(['assigned', 'ended', 'lead_changed']),
      assignmentId: id,
      userId: id,
      subjectId: id.nullable().optional(),
      isLead: z.boolean().optional(),
      previousLeadUserId: id.nullable().optional(),
    }),
  },
  // Written against the batch: rule versions and how many sessions each change made.
  'timetable.changed': {
    entityType: 'batch',
    summary: z.object({
      change: z.enum(['created', 'updated', 'ended']),
      ruleId: id,
      seriesId: id,
      previousRuleId: id.optional(),
      applyFrom: z.string().max(10).optional(),
      lastDate: z.string().max(10).optional(),
      sessionsCreated: z.number().int().nonnegative().optional(),
      sessionsRemoved: z.number().int().nonnegative().optional(),
      sessionsKept: z.number().int().nonnegative().optional(),
      conflictOverride: z.boolean().optional(),
    }),
  },
  'session.changed': {
    entityType: 'class_session',
    summary: z.object({
      change: z.enum(['created', 'cancelled', 'restored', 'updated']),
      batchId: id,
      localDate: z.string().max(10),
      reason: reason.optional(),
      fields: z.array(state).optional(),
      fromInstructorUserId: id.optional(),
      toInstructorUserId: id.optional(),
      conflictOverride: z.boolean().optional(),
    }),
  },
  // Fees (CRM M2 phase 1). Plan names and the document prefix are school
  // configuration; amounts are paise. References and internal notes never appear.
  'fee_plan.changed': {
    entityType: 'fee_plan',
    summary: z.object({ change: z.enum(['created', 'updated', 'archived', 'restored']), name: z.string().max(120) }),
  },
  'fee_settings.changed': {
    entityType: 'school',
    summary: z.object({ fields: z.array(state).min(1), prefix: z.string().max(8).optional() }),
  },
  // Holiday labels are school configuration ("Diwali").
  'holiday.changed': {
    entityType: 'school',
    summary: z.object({
      change: z.enum(['added', 'removed']),
      holidayId: id,
      startsOn: z.string().max(10),
      endsOn: z.string().max(10),
      label: z.string().max(60),
      sessionsCancelled: z.number().int().nonnegative().optional(),
    }),
  },
  // Written against the instructor. Leave reasons are short labels ("Leave").
  'availability.changed': {
    entityType: 'user',
    summary: z.object({
      change: z.enum(['windows_updated', 'exception_added', 'exception_removed']),
      windowCount: z.number().int().nonnegative().optional(),
      exceptionId: id.optional(),
      startsOn: z.string().max(10).optional(),
      endsOn: z.string().max(10).optional(),
    }),
  },
  // Written against the student, so batch joins and leaves show on the timeline.
  'membership.changed': {
    entityType: 'student',
    summary: z.object({ change: z.enum(['joined', 'left']), batchId: id, membershipId: id, enrollmentCreated: z.boolean().optional() }),
  },
  // CRM M2 phase 2 (WhatsApp). Never the token, the PIN or any phone number.
  'wa_connection.changed': {
    entityType: 'school',
    summary: z.object({
      change: z.enum(['connected', 'disconnected', 'blocked', 'unblocked']),
      connectionId: id,
      mode: z.enum(['embedded', 'manual', 'test']).optional(),
      coexistence: z.boolean().optional(),
      code: z.string().max(40).optional(),
    }),
  },
  'wa_settings.changed': {
    entityType: 'school',
    summary: z.object({ fields: z.array(state).min(1) }),
  },
  // Written against the contact; the source says who changed it (D4).
  'contact.consent_changed': {
    entityType: 'contact',
    summary: z.object({ optedIn: z.boolean(), source: z.enum(['staff', 'whatsapp_stop', 'public_form']) }),
  },
  // Group sends: counts only, never names or text (D8).
  'message.group_sent': {
    entityType: 'school',
    // `sendId`, not `groupId`: audit keys may not contain "upi".
    summary: z.object({
      sendId: id,
      templateKey: state,
      recipients: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative(),
      batchIds: z.array(id).max(50).optional(),
    }),
  },
  // Written against the student (D7).
  'reminder.paused': {
    entityType: 'student',
    summary: z.object({ change: z.enum(['paused', 'resumed']), untilDate: z.string().max(10).optional() }),
  },
  'access_link.revoked': {
    entityType: 'contact',
    summary: z.object({ linkId: id, purpose: z.enum(['fees', 'report']) }),
  },
  'support.session': {
    entityType: 'school',
    summary: z.object({}),
  },
  'contact.anonymised': {
    entityType: 'contact',
    summary: z.object({ trigger: z.enum(['erasure_request', 'retention_policy']) }),
  },
});

export const AUDIT_ACTION_NAMES = Object.freeze(Object.keys(AUDIT_ACTIONS));

// Keys that must never reach the audit log, even redacted.
const FORBIDDEN_KEY = /token|secret|password|otp|card|upi|account/i;

function assertNoForbiddenKeys(value, path = 'summary') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) throw new CrmAuditError(`Audit summary may not include ${path}.${key}`);
    assertNoForbiddenKeys(child, `${path}.${key}`);
  }
}

export function maskPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length < 6) return 'x'.repeat(digits.length);
  return `${digits.slice(0, 2)}${'x'.repeat(digits.length - 4)}${digits.slice(-2)}`;
}

export function maskEmail(value) {
  const [local = '', domain = ''] = String(value || '').split('@');
  if (!domain) return '***';
  return `${local.slice(0, 1)}***@${domain}`;
}

function maskContactValues(value) {
  if (Array.isArray(value)) return value.map(maskContactValues);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    if (typeof child === 'string' && /phone$/i.test(key)) return [key, maskPhone(child)];
    if (typeof child === 'string' && /email$/i.test(key)) return [key, maskEmail(child)];
    return [key, maskContactValues(child)];
  }));
}

/**
 * Validates and redacts an audit summary for `action`. Unknown keys are
 * dropped, forbidden keys throw, and phone/email values are masked.
 */
export function buildAuditSummary(action, input = {}) {
  const definition = AUDIT_ACTIONS[action];
  if (!definition) throw new CrmAuditError(`Unknown audit action: ${action}`);
  assertNoForbiddenKeys(input);
  const parsed = definition.summary.safeParse(input);
  if (!parsed.success) {
    throw new CrmAuditError(`Invalid ${action} summary: ${parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ')}`);
  }
  return maskContactValues(parsed.data);
}
