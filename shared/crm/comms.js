// WhatsApp communication rules shared by the CRM server and UI (CRM M2
// phase 2, D2–D15). Wording lives in waTemplates.js, prices in waPricing.js.
import { z } from 'zod';
import { WA_LANGUAGES } from './waTemplates.js';

// D4: the single purpose a guardian consents to.
export const CONSENT_PURPOSE = 'WhatsApp updates about the child’s classes, fees and progress';
export const CONSENT_SOURCE_LABELS = Object.freeze({
  staff: 'Recorded by staff',
  public_form: 'Inquiry form',
  roster_import: 'Roster import',
  whatsapp_stop: 'Replied STOP on WhatsApp',
});

// D3: automatic messages and their per-class switches.
export const AUTO_MESSAGES = Object.freeze([
  { key: 'feeDue', column: 'auto_fee_due', label: 'Fee due soon', hint: 'Before each due date, on the schedule below' },
  { key: 'feeOverdue', column: 'auto_fee_overdue', label: 'Fee overdue', hint: 'After a due date while unpaid' },
  { key: 'receipt', column: 'auto_receipt', label: 'Payment receipt', hint: 'When a payment is recorded, with the receipt PDF' },
  { key: 'reportReady', column: 'auto_report_ready', label: 'Report ready', hint: 'When a student’s report is published' },
  { key: 'absent', column: 'auto_absent', label: 'Absent today', hint: 'About 10 minutes after a student is marked absent' },
]);

// D7: fee reminder schedule defaults and limits.
export const SCHEDULE_FIELDS = Object.freeze([
  { key: 'remindDaysBefore', column: 'remind_days_before', min: 0, max: 15, fallback: 3 },
  { key: 'overdueFirstDay', column: 'overdue_first_day', min: 1, max: 30, fallback: 1 },
  { key: 'overdueGapDays', column: 'overdue_gap_days', min: 1, max: 30, fallback: 7 },
  { key: 'overdueCount', column: 'overdue_count', min: 0, max: 5, fallback: 3 },
  { key: 'sendHour', column: 'send_hour', min: 8, max: 20, fallback: 10 },
]);

const optionalText = (max) => z.string().trim().max(max).optional();

export const waSettingsBody = z.object({
  language: z.enum(WA_LANGUAGES),
  senderName: z.string().trim().min(1, 'Enter the name parents will see').max(60),
  contactLine: optionalText(120),
  paymentInstructions: optionalText(200),
  auto: z.object(Object.fromEntries(AUTO_MESSAGES.map((item) => [item.key, z.boolean()]))).strict(),
  schedule: z.object(Object.fromEntries(SCHEDULE_FIELDS.map((field) => [field.key, z.coerce.number().int().min(field.min).max(field.max)]))).strict(),
  // D15: null = no limit. Whole rupees in the UI, paise here.
  monthlyLimitPaise: z.number().int().min(100_00).max(10_000_000_00).nullable(),
  expectedVersion: z.coerce.number().int().min(0),
}).strict();

const metaId = z.string().trim().regex(/^\d{5,30}$/, 'Meta ids are digits only');

export const connectBody = z.object({
  code: z.string().trim().min(10).max(2000),
  wabaId: metaId,
  phoneNumberId: metaId,
  businessId: metaId.optional(),
  // Embedded Signup's FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING event (coexistence).
  coexistence: z.boolean().default(false),
}).strict();

export const connectManualBody = z.object({
  wabaId: metaId,
  phoneNumberId: metaId,
  accessToken: z.string().trim().min(20).max(1000),
}).strict();

export const disconnectBody = z.object({ expectedVersion: z.coerce.number().int().positive() }).strict();

export const CONNECTION_MODE_LABELS = Object.freeze({
  embedded: 'Connected through Meta',
  manual: 'Connected manually (platform staff)',
  test: 'Test provider (no real messages)',
});

export const TEMPLATE_STATUS_LABELS = Object.freeze({
  pending: 'Waiting for Meta',
  approved: 'Approved',
  rejected: 'Rejected',
  paused: 'Paused by Meta',
  disabled: 'Disabled by Meta',
  failed: 'Not submitted',
});

/** Meta's quality rating as staff read it. */
export const QUALITY_LABELS = Object.freeze({ GREEN: 'High', YELLOW: 'Medium', RED: 'Low', UNKNOWN: 'Not rated yet' });

// ---------------------------------------------------------------- sending --

export const MESSAGE_TARGETS = Object.freeze(['student', 'lead', 'batch']);
export const FREE_TEXT_MAX = 1000;

const noticeField = (max) => z.string().trim().min(1, 'Required').max(max);
export const NOTICE_FIELD_SCHEMAS = Object.freeze({
  className: noticeField(80),
  when: noticeField(60),
  newWhen: noticeField(60),
  dates: noticeField(60),
  occasion: noticeField(40),
  item: noticeField(60),
});
export const NOTICE_FIELD_LABELS = Object.freeze({
  className: 'Class',
  when: 'Day and time',
  newWhen: 'New day and time',
  dates: 'Date or dates',
  occasion: 'Occasion',
  item: 'What to bring',
});

export const composeQuery = z.object({
  entityType: z.enum(MESSAGE_TARGETS),
  entityId: z.string().trim().min(1).max(128),
});

export const sendMessageBody = z.object({
  entityType: z.enum(MESSAGE_TARGETS),
  entityId: z.string().trim().min(1).max(128),
  mode: z.enum(['notice', 'text', 'phone']),
  templateKey: z.string().trim().max(40).optional(),
  fields: z.record(z.string(), z.string().max(200)).optional(),
  text: z.string().trim().max(FREE_TEXT_MAX).optional(),
  contactId: z.string().trim().max(128).optional(),
}).strict();

// Failures staff may retry by hand: temporary errors and sends Skyll couldn't confirm (D12).
export const RETRYABLE_STATUS_CODES = Object.freeze(['unconfirmed', 'timeout', 'network', 'temporary', 'template_pending', '131000', '131016', '130429', '131056', '131049', '1', '2', '4', '80007', '133004']);

export const retryBody = z.object({ messageId: z.string().trim().min(1).max(128) }).strict();

// What staff see for each status (D12).
export const MESSAGE_STATUS_LABELS = Object.freeze({
  queued: 'Sending',
  sending: 'Sending',
  held: 'On hold',
  sent: 'Sent',
  delivered: 'Delivered',
  read: 'Read',
  failed: 'Failed',
  cancelled: 'Not sent',
  skipped: 'Not sent',
});

export const MESSAGE_KIND_LABELS = Object.freeze({
  fee_due: 'Fee reminder',
  fee_overdue: 'Overdue fee reminder',
  fee_manual: 'Fee reminder',
  receipt: 'Payment receipt',
  report_ready: 'Report ready',
  absent: 'Absence alert',
  notice: 'Class notice',
  free_text: 'Message',
  stop_ack: 'Opt-out confirmation',
});

/** A wa.me link that opens WhatsApp with the text typed in (Send from my phone, D1). */
export function phoneLink(phoneE164, text) {
  return `https://wa.me/${String(phoneE164 || '').replace(/\D/g, '')}?text=${encodeURIComponent(text || '')}`;
}
