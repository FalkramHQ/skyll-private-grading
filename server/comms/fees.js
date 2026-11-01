// Fee messages (CRM-019, D3/D5/D7/D10/D13): reminders before and after due
// dates, receipts with the PDF, and the manual Send reminder. Everything goes
// to the student's fee payer (or primary guardian) and only if they agreed.
//
// The planner runs every few minutes and is safe to repeat: each message has
// a dedup key, so a reminder step is queued once. Before sending, the
// dispatcher re-checks it here (paid since? student left? paused?) and
// refreshes the amount, so a parent is never chased for money already paid.
import { renderTemplate } from '../../shared/crm/waTemplates.js';
import { paiseToRupees } from '../../shared/crm/fees.js';
import { DEFAULT_TIMEZONE, addDays, localDate, zonedParts, zonedTimeToUtcMs } from '../../shared/crm/time.js';
import { PAID_SQL } from '../crm/ledger.js';
import { registerKind } from './dispatcher.js';
import { createLink } from './links.js';
import { feeRecipient, guardianRows, messageStatements, newMessageId, queueBatch } from './outbox.js';
import { registerPlanner } from './runner.js';

// ------------------------------------------------------------ context --

const DEFAULT_SETTINGS = {
  language: 'en', sender_name: null, contact_line: null, payment_instructions: null,
  auto_fee_due: 1, auto_fee_overdue: 1, auto_receipt: 1, auto_report_ready: 1, auto_absent: 1,
  remind_days_before: 3, overdue_first_day: 1, overdue_gap_days: 7, overdue_count: 3, send_hour: 10,
};

/** The school's WhatsApp settings (defaults when never saved), timezone, name and connection. */
export async function schoolContext(db, schoolId) {
  const [school, settings, connection, fees] = await Promise.all([
    db.execute({ sql: 'SELECT id, display_name, timezone FROM schools WHERE id = ?', args: [schoolId] }),
    db.execute({ sql: 'SELECT * FROM crm_wa_settings WHERE school_id = ?', args: [schoolId] }),
    db.execute({ sql: "SELECT * FROM crm_wa_connections WHERE school_id = ? AND status = 'connected' LIMIT 1", args: [schoolId] }),
    db.execute({ sql: 'SELECT header_name FROM crm_fee_settings WHERE school_id = ?', args: [schoolId] }),
  ]);
  const row = { ...DEFAULT_SETTINGS, ...(settings.rows[0] || {}) };
  return {
    schoolId,
    timeZone: school.rows[0]?.timezone || DEFAULT_TIMEZONE,
    connection: connection.rows[0] || null,
    settings: row,
    senderName: row.sender_name || fees.rows[0]?.header_name || school.rows[0]?.display_name || 'the class',
  };
}

const on = (value) => Number(value) === 1;

export function longDate(date, language) {
  const [y, m, d] = String(date).split('-').map(Number);
  return new Intl.DateTimeFormat(language === 'hi' ? 'hi-IN' : 'en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
}

function baseVars(context, guardianName) {
  return {
    senderName: context.senderName,
    contactLine: context.settings.contact_line || '',
    paymentInstructions: context.settings.payment_instructions || '',
    guardianName: guardianName || '',
  };
}

// --------------------------------------------------------------- state --

/** A student's unpaid issued invoices (balance > 0), oldest due first, with labels. */
export async function unpaidInvoices(db, schoolId, studentId) {
  const result = await db.execute({
    sql: `SELECT i.id, i.number, i.due_date, i.total_paise, ${PAID_SQL} AS paid_paise,
                 (SELECT l.label FROM crm_invoice_lines l WHERE l.school_id = i.school_id AND l.invoice_id = i.id ORDER BY l.position LIMIT 1) AS first_label,
                 (SELECT COUNT(*) FROM crm_invoice_lines l WHERE l.school_id = i.school_id AND l.invoice_id = i.id) AS line_count
          FROM crm_invoices i
          WHERE i.school_id = ? AND i.student_id = ? AND i.status = 'issued'
          ORDER BY i.due_date, i.seq`,
    args: [schoolId, studentId],
  });
  return result.rows
    .map((row) => ({
      id: row.id,
      number: row.number,
      dueDate: row.due_date,
      balancePaise: Number(row.total_paise) - Number(row.paid_paise),
      label: Number(row.line_count) > 1 ? `${row.first_label} and ${Number(row.line_count) - 1} more` : row.first_label || row.number,
    }))
    .filter((invoice) => invoice.balancePaise > 0);
}

async function studentRow(db, schoolId, studentId) {
  return (await db.execute({ sql: 'SELECT id, display_name, status FROM students WHERE id = ? AND school_id = ?', args: [studentId, schoolId] })).rows[0] || null;
}

export async function pausedUntil(db, schoolId, studentId, today) {
  const row = (await db.execute({
    sql: 'SELECT until_date FROM crm_reminder_pauses WHERE school_id = ? AND student_id = ? AND ended_at IS NULL AND until_date >= ? LIMIT 1',
    args: [schoolId, studentId, today],
  })).rows[0];
  return row?.until_date || null;
}

function overdueDetail(overdue, language) {
  const oldest = longDate(overdue[0].dueDate, language);
  if (overdue.length === 1) return language === 'hi' ? `अंतिम तिथि ${oldest} थी` : `due on ${oldest}`;
  return language === 'hi' ? `${overdue.length} फ़ीस, सबसे पुरानी की अंतिम तिथि ${oldest} थी` : `${overdue.length} fees, the oldest due on ${oldest}`;
}

/** Template variables for a before-due reminder about one invoice. */
export function dueVars(context, { guardianName, studentName, invoice }) {
  const language = context.settings.language;
  return { ...baseVars(context, guardianName), studentName, amount: paiseToRupees(invoice.balancePaise), itemLabel: invoice.label, dueDate: longDate(invoice.dueDate, language) };
}

/** Template variables for an overdue reminder, combined across the student's overdue invoices (D7). */
export function overdueVars(context, { guardianName, studentName, overdue }) {
  const total = overdue.reduce((sum, invoice) => sum + invoice.balancePaise, 0);
  return { ...baseVars(context, guardianName), studentName, amount: paiseToRupees(total), overdueDetail: overdueDetail(overdue, context.settings.language) };
}

const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * Which overdue step (0-based) is due today, or null (D7): the first at
 * `overdue_first_day` days after the oldest due date, then every
 * `overdue_gap_days`, at most `overdue_count`. Only the latest step reached
 * counts, so a long-overdue fee never triggers a burst.
 */
export function overdueStep(settings, oldestDueDate, today) {
  const count = Number(settings.overdue_count);
  if (!count) return null;
  const late = daysBetween(oldestDueDate, today);
  const first = Number(settings.overdue_first_day);
  const gap = Number(settings.overdue_gap_days);
  if (late < first) return null;
  const step = Math.min(count - 1, Math.floor((late - first) / gap));
  return { step, date: addDays(oldestDueDate, first + step * gap) };
}

/** When a reminder for `date` goes out: `send_hour` on that day, school time. */
function sendMoment(date, context) {
  const [year, month, day] = date.split('-').map(Number);
  return zonedTimeToUtcMs({ year, month, day, hour: Number(context.settings.send_hour) }, context.timeZone);
}

// ------------------------------------------------------------- planner --

function skipNote(context, { kind, studentId, today, reason, now }) {
  return messageStatements({
    schoolId: context.schoolId, kind, status: 'skipped', statusReason: reason, dedupKey: `skip:${kind}:${studentId}:${today}`, now,
  }, [{ entityType: 'student', entityId: studentId }]).statements;
}

/** Queues (or notes as skipped) one fee message for a student's fee payer. */
async function queueForPayer(db, context, { kind, templateKey, studentId, studentName, vars, ref, dedup, today, now }) {
  const rows = await guardianRows(db, context.schoolId, [studentId]);
  const payer = feeRecipient(rows, studentId);
  if (!context.connection) return skipNote(context, { kind, studentId, today, reason: 'Not sent: WhatsApp isn’t connected', now });
  if (!payer?.phone) return skipNote(context, { kind, studentId, today, reason: 'Not sent: the fee payer has no phone number', now });
  if (!payer.optedIn) return skipNote(context, { kind, studentId, today, reason: 'Not sent: the fee payer hasn’t agreed to WhatsApp', now });
  const filled = { ...vars, guardianName: payer.name || '', studentName };
  return messageStatements({
    schoolId: context.schoolId, kind, connectionId: context.connection.id, templateKey, language: context.settings.language,
    contactId: payer.contactId, phone: payer.phone, recipientName: payer.name, vars: filled,
    bodyText: renderTemplate(templateKey, context.settings.language, filled), ...ref, dedupKey: `${dedup}:${payer.contactId}`, now,
  }, [{ entityType: 'student', entityId: studentId }]).statements;
}

async function crmSchools(db) {
  const result = await db.execute("SELECT school_id FROM school_feature_flags WHERE feature_key = 'crm' AND enabled = 1");
  return result.rows.map((row) => row.school_id);
}

/** Before-due and overdue reminders for one school, at or after its send hour (D7, D13). */
export async function planSchoolReminders(db, schoolId, now) {
  const context = await schoolContext(db, schoolId);
  const { settings } = context;
  const today = localDate(now, context.timeZone);
  if (zonedParts(now, context.timeZone).hour < Number(settings.send_hour)) return 0;
  // A class that connects starts from the next reminder, never a backlog.
  const after = (date) => !context.connection || sendMoment(date, context) >= Date.parse(context.connection.connected_at);
  const statements = [];
  const nowIso = new Date(now).toISOString();

  if (on(settings.auto_fee_due) && Number(settings.remind_days_before) > 0) {
    const dueDate = addDays(today, Number(settings.remind_days_before));
    const due = await db.execute({
      sql: `SELECT i.id, i.student_id, s.display_name FROM crm_invoices i JOIN students s ON s.id = i.student_id AND s.school_id = i.school_id
            WHERE i.school_id = ? AND i.status = 'issued' AND i.due_date = ? AND s.status = 'active' AND i.total_paise > ${PAID_SQL}`,
      args: [schoolId, dueDate],
    });
    for (const row of due.rows) {
      if (!after(today) || await pausedUntil(db, schoolId, row.student_id, today)) continue;
      const invoice = (await unpaidInvoices(db, schoolId, row.student_id)).find((item) => item.id === row.id);
      if (!invoice) continue;
      statements.push(...await queueForPayer(db, context, {
        kind: 'fee_due', templateKey: 'fee_due', studentId: row.student_id, studentName: row.display_name, today, now: nowIso,
        vars: dueVars(context, { studentName: row.display_name, invoice }), ref: { refType: 'invoice', refId: invoice.id }, dedup: `fee_due:${invoice.id}`,
      }));
    }
  }

  if (on(settings.auto_fee_overdue)) {
    const overdueStudents = await db.execute({
      sql: `SELECT DISTINCT i.student_id, s.display_name FROM crm_invoices i JOIN students s ON s.id = i.student_id AND s.school_id = i.school_id
            WHERE i.school_id = ? AND i.status = 'issued' AND i.due_date < ? AND s.status = 'active' AND i.total_paise > ${PAID_SQL}`,
      args: [schoolId, today],
    });
    for (const row of overdueStudents.rows) {
      if (await pausedUntil(db, schoolId, row.student_id, today)) continue;
      const overdue = (await unpaidInvoices(db, schoolId, row.student_id)).filter((invoice) => invoice.dueDate < today);
      if (!overdue.length) continue;
      const step = overdueStep(settings, overdue[0].dueDate, today);
      if (!step || !after(step.date)) continue;
      statements.push(...await queueForPayer(db, context, {
        kind: 'fee_overdue', templateKey: 'fee_overdue', studentId: row.student_id, studentName: row.display_name, today, now: nowIso,
        vars: overdueVars(context, { studentName: row.display_name, overdue }), ref: { refType: 'student', refId: row.student_id, ref: { invoiceIds: overdue.map((invoice) => invoice.id), step: step.step } },
        dedup: `fee_overdue:${row.student_id}:${overdue[0].id}:${step.step}`,
      }));
    }
  }
  return queueBatch(db, statements);
}

/** Receipts for payments recorded in the last two days (after connecting). */
export async function planSchoolReceipts(db, schoolId, now) {
  const context = await schoolContext(db, schoolId);
  if (!on(context.settings.auto_receipt)) return 0;
  const since = new Date(Math.max(now - 48 * 3600_000, context.connection ? Date.parse(context.connection.connected_at) : 0)).toISOString();
  const payments = await db.execute({
    sql: `SELECT p.id, p.student_id, p.amount_paise, p.received_on, p.receipt_number, s.display_name FROM crm_payments p
          JOIN students s ON s.id = p.student_id AND s.school_id = p.school_id
          WHERE p.school_id = ? AND p.kind = 'payment' AND p.created_at >= ?
            AND NOT EXISTS (SELECT 1 FROM crm_payments r WHERE r.school_id = p.school_id AND r.reverses_payment_id = p.id)`,
    args: [schoolId, since],
  });
  const today = localDate(now, context.timeZone);
  const nowIso = new Date(now).toISOString();
  const statements = [];
  for (const payment of payments.rows) {
    const vars = await receiptVars(db, context, payment, payment.display_name);
    statements.push(...await queueForPayer(db, context, {
      kind: 'receipt', templateKey: 'receipt', studentId: payment.student_id, studentName: payment.display_name, today, now: nowIso,
      vars, ref: { refType: 'payment', refId: payment.id }, dedup: `receipt:${payment.id}`,
    }));
  }
  return queueBatch(db, statements);
}

async function receiptVars(db, context, payment, studentName) {
  const balance = (await unpaidInvoices(db, context.schoolId, payment.student_id)).reduce((sum, invoice) => sum + invoice.balancePaise, 0);
  return {
    ...baseVars(context, ''), studentName, amount: paiseToRupees(payment.amount_paise), paymentDate: longDate(payment.received_on, context.settings.language),
    receiptNumber: payment.receipt_number, balanceDue: paiseToRupees(balance),
  };
}

export async function planFees(db, { now = Date.now() } = {}) {
  let queued = 0;
  for (const schoolId of await crmSchools(db)) {
    queued += await planSchoolReminders(db, schoolId, now);
    queued += await planSchoolReceipts(db, schoolId, now);
  }
  return { queued };
}

// ------------------------------------------------- send-time re-checks --

async function feesLink(db, message, now) {
  return createLink(db, { schoolId: message.school_id, purpose: 'fees', contactId: message.contact_id, messageId: message.id, now });
}

async function checkStudent(db, context, studentId, today, auto) {
  const student = await studentRow(db, context.schoolId, studentId);
  if (!student || student.status !== 'active') return { reason: 'The student is no longer active' };
  if (auto && !on(context.settings[auto])) return { reason: 'This automatic message was switched off' };
  if (await pausedUntil(db, context.schoolId, studentId, today)) return { reason: 'Reminders are paused for this student' };
  return { student };
}

async function studentIdOf(db, message) {
  if (message.ref_type === 'student') return message.ref_id;
  const subject = (await db.execute({ sql: "SELECT entity_id FROM crm_comms_subjects WHERE message_id = ? AND entity_type = 'student' LIMIT 1", args: [message.id] })).rows[0];
  return subject?.entity_id || null;
}

const AUTO_SWITCH = { fee_due: 'auto_fee_due', fee_overdue: 'auto_fee_overdue', fee_manual: null };

async function reminderState(db, message, now) {
  const context = await schoolContext(db, message.school_id);
  const today = localDate(now, context.timeZone);
  const studentId = await studentIdOf(db, message);
  const checked = await checkStudent(db, context, studentId, today, AUTO_SWITCH[message.kind]);
  if (checked.reason) return { reason: checked.reason };
  const unpaid = await unpaidInvoices(db, message.school_id, studentId);
  const vars = JSON.parse(message.vars_json || '{}');
  if (message.template_key === 'fee_due') {
    const invoiceId = message.ref_type === 'invoice' ? message.ref_id : JSON.parse(message.ref_json || '{}').invoiceId;
    const invoice = unpaid.find((item) => item.id === invoiceId);
    if (!invoice) return { reason: 'The fee has been paid, voided or corrected' };
    return { vars: { ...vars, amount: paiseToRupees(invoice.balancePaise) } };
  }
  const overdue = unpaid.filter((invoice) => invoice.dueDate < today);
  if (!overdue.length) return { reason: 'Nothing is overdue any more' };
  return { vars: { ...vars, ...overdueVars(context, { guardianName: vars.guardianName, studentName: vars.studentName, overdue }) } };
}

const reminderHooks = {
  async relevant(db, message, { now }) { return (await reminderState(db, message, now)).reason || null; },
  async prepare(db, message, provider, { now }) {
    const state = await reminderState(db, message, now);
    return { vars: state.vars, linkToken: await feesLink(db, message, now) };
  },
};
registerKind('fee_due', reminderHooks);
registerKind('fee_overdue', reminderHooks);
registerKind('fee_manual', reminderHooks);

async function paymentFor(db, message) {
  return (await db.execute({
    sql: `SELECT p.*, s.display_name, EXISTS (SELECT 1 FROM crm_payments r WHERE r.school_id = p.school_id AND r.reverses_payment_id = p.id) AS reversed
          FROM crm_payments p JOIN students s ON s.id = p.student_id AND s.school_id = p.school_id WHERE p.id = ? AND p.school_id = ?`,
    args: [message.ref_id, message.school_id],
  })).rows[0] || null;
}

registerKind('receipt', {
  async relevant(db, message) {
    const payment = await paymentFor(db, message);
    if (!payment || Number(payment.reversed) === 1) return 'The payment was reversed';
    const context = await schoolContext(db, message.school_id);
    return on(context.settings.auto_receipt) ? null : 'This automatic message was switched off';
  },
  async prepare(db, message, provider, { now }) {
    const { loadPayment } = await import('../crm/payments.js');
    const { renderFeeReceiptPdf, documentFilename } = await import('../crm/feeDocuments.js');
    const { feeSettings } = await import('../crm/feePlans.js');
    const context = await schoolContext(db, message.school_id);
    const scope = { schoolId: message.school_id, timezone: context.timeZone, schoolName: context.senderName };
    const payment = await loadPayment(db, scope, message.ref_id);
    const settings = await feeSettings(db, scope);
    const row = await paymentFor(db, message);
    const balance = (await unpaidInvoices(db, message.school_id, payment.student.id)).reduce((sum, invoice) => sum + invoice.balancePaise, 0);
    const pdf = await renderFeeReceiptPdf(payment, {
      school: { name: settings.headerName, address: settings.headerAddress, phone: settings.headerPhone, gstin: settings.headerGstin, footer: settings.footerNote },
      studentName: row.display_name, balancePaise: balance,
    });
    const documentName = documentFilename(payment.receiptNumber);
    const documentId = await provider.uploadMedia({ data: pdf, mimeType: 'application/pdf', filename: documentName });
    const vars = { ...JSON.parse(message.vars_json || '{}'), balanceDue: paiseToRupees(balance) };
    return { vars, documentId, documentName, linkToken: await feesLink(db, message, now) };
  },
});

registerPlanner('fees', planFees, { everyMs: 5 * 60_000 });

// --------------------------------------------------- manual reminder --

/**
 * The manual Send reminder (D7): the overdue reminder when anything is
 * overdue, otherwise the next unpaid fee. Once per fee payer per day.
 */
export async function manualReminder(db, { schoolId, studentId, now = Date.now() }) {
  const context = await schoolContext(db, schoolId);
  const today = localDate(now, context.timeZone);
  const student = await studentRow(db, schoolId, studentId);
  const unpaid = await unpaidInvoices(db, schoolId, studentId);
  const rows = await guardianRows(db, schoolId, [studentId]);
  const payer = feeRecipient(rows, studentId);
  const overdue = unpaid.filter((invoice) => invoice.dueDate < today);
  const templateKey = overdue.length ? 'fee_overdue' : 'fee_due';
  const vars = overdue.length
    ? overdueVars(context, { guardianName: payer?.name, studentName: student?.display_name, overdue })
    : unpaid.length ? dueVars(context, { guardianName: payer?.name, studentName: student?.display_name, invoice: unpaid[0] }) : null;
  return {
    context, today, student, payer, unpaid, templateKey, vars,
    text: vars ? renderTemplate(templateKey, context.settings.language, vars) : null,
    ref: overdue.length ? { refType: 'student', refId: studentId, ref: { invoiceIds: overdue.map((invoice) => invoice.id) } } : unpaid.length ? { refType: 'invoice', refId: unpaid[0].id } : null,
    dedupKey: payer ? `fee_manual:${studentId}:${today}:${payer.contactId}` : null,
  };
}

export function manualReminderStatements(plan, { createdBy, now }) {
  return messageStatements({
    id: newMessageId(), schoolId: plan.context.schoolId, kind: 'fee_manual', connectionId: plan.context.connection.id, templateKey: plan.templateKey,
    language: plan.context.settings.language, contactId: plan.payer.contactId, phone: plan.payer.phone, recipientName: plan.payer.name, vars: plan.vars,
    bodyText: plan.text, ...plan.ref, dedupKey: plan.dedupKey, createdBy, now,
  }, [{ entityType: 'student', entityId: plan.student.id }]);
}

