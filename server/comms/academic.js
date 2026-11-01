// Absence alerts and report-ready messages (CRM M2 phase 2 S4, D3/D5/D10/D13).
// Both go to every guardian who agreed to WhatsApp (not just the fee payer),
// one copy per phone per student and event.
//
// Absent today: queued about 10 minutes after a student is marked absent, so
// a quick correction to Present means nothing is sent; re-checked before
// sending. Report ready: when a student's report is first published, with a
// secure link to the parent report page. The CRM only reads the assessment
// tables (CRM_CONTRACTS §1.10).
import { renderTemplate } from '../../shared/crm/waTemplates.js';
import { localDate } from '../../shared/crm/time.js';
import { registerKind } from './dispatcher.js';
import { longDate, schoolContext } from './fees.js';
import { createLink } from './links.js';
import { byPhone, guardianRows, messageStatements, queueBatch } from './outbox.js';
import { registerPlanner } from './runner.js';

export const ABSENT_GRACE_MS = 10 * 60 * 1000;
const LOOKBACK_MS = 48 * 60 * 60 * 1000;
const on = (value) => Number(value) === 1;

async function crmSchools(db) {
  const result = await db.execute("SELECT school_id FROM school_feature_flags WHERE feature_key = 'crm' AND enabled = 1");
  return result.rows.map((row) => row.school_id);
}

function baseVars(context) {
  return { senderName: context.senderName, contactLine: context.settings.contact_line || '' };
}

/**
 * Statements queuing one templated message per consenting guardian phone of
 * one student, or a skipped note (at most once a day) when the class isn't
 * connected or nobody agreed to WhatsApp.
 */
async function queueForGuardians(db, context, { kind, templateKey, studentId, vars, ref, dedup, today, now }) {
  const skip = (reason) => messageStatements({
    schoolId: context.schoolId, kind, status: 'skipped', statusReason: reason, dedupKey: `skip:${kind}:${studentId}:${today}`, now,
  }, [{ entityType: 'student', entityId: studentId }]).statements;
  if (!context.connection) return skip('Not sent: WhatsApp isn’t connected');
  const { recipients } = byPhone(await guardianRows(db, context.schoolId, [studentId]));
  if (!recipients.length) return skip('Not sent: no guardian has agreed to WhatsApp');
  const statements = [];
  for (const recipient of recipients) {
    const filled = { ...vars, guardianName: recipient.name || '' };
    statements.push(...messageStatements({
      schoolId: context.schoolId, kind, connectionId: context.connection.id, templateKey, language: context.settings.language,
      contactId: recipient.contactId, phone: recipient.phone, recipientName: recipient.name, vars: filled,
      bodyText: renderTemplate(templateKey, context.settings.language, filled), ...ref, dedupKey: `${dedup}:${recipient.contactId}`, now,
    }, [{ entityType: 'student', entityId: studentId }]).statements);
  }
  return statements;
}

/** Students marked absent today, at least 10 minutes ago (and after connecting). */
export async function planSchoolAbsences(db, schoolId, now) {
  const context = await schoolContext(db, schoolId);
  if (!on(context.settings.auto_absent)) return 0;
  const today = localDate(now, context.timeZone);
  const since = new Date(Math.max(now - LOOKBACK_MS, context.connection ? Date.parse(context.connection.connected_at) : 0)).toISOString();
  const marks = await db.execute({
    sql: `SELECT a.id, a.student_id, s.local_date, b.name AS batch_name, st.display_name
          FROM crm_session_attendance a
          JOIN crm_class_sessions s ON s.id = a.session_id AND s.school_id = a.school_id
          JOIN batches b ON b.id = s.batch_id AND b.school_id = s.school_id
          JOIN students st ON st.id = a.student_id AND st.school_id = a.school_id
          WHERE a.school_id = ? AND a.status = 'absent' AND s.local_date = ? AND st.status = 'active'
            AND a.updated_at <= ? AND a.updated_at >= ?`,
    args: [schoolId, today, new Date(now - ABSENT_GRACE_MS).toISOString(), since],
  });
  const nowIso = new Date(now).toISOString();
  const statements = [];
  for (const mark of marks.rows) {
    statements.push(...await queueForGuardians(db, context, {
      kind: 'absent', templateKey: 'absent', studentId: mark.student_id, today, now: nowIso,
      vars: { ...baseVars(context), studentName: mark.display_name, className: mark.batch_name, dates: longDate(mark.local_date, context.settings.language) },
      ref: { refType: 'attendance', refId: mark.id }, dedup: `absent:${mark.id}`,
    }));
  }
  return queueBatch(db, statements);
}

/**
 * Reports that became visible to families in the last two days (and after
 * connecting): first published, and the test released by a teacher. A test
 * released days after grading is announced on release.
 */
export async function planSchoolReports(db, schoolId, now) {
  const context = await schoolContext(db, schoolId);
  if (!on(context.settings.auto_report_ready)) return 0;
  const today = localDate(now, context.timeZone);
  const since = new Date(Math.max(now - LOOKBACK_MS, context.connection ? Date.parse(context.connection.connected_at) : 0)).toISOString();
  const reports = await db.execute({
    sql: `SELECT sub.id AS submission_id, sub.student_id, e.name AS exam_name, st.display_name, MIN(rv.published_at) AS first_published
          FROM report_versions rv
          JOIN submissions sub ON sub.id = rv.submission_id
          JOIN exams e ON e.id = sub.exam_id AND e.school_id = ?
          JOIN students st ON st.id = sub.student_id AND st.school_id = ?
          WHERE rv.status = 'published' AND rv.published_at IS NOT NULL AND st.status = 'active'
            AND e.released_at IS NOT NULL
          GROUP BY sub.id, sub.student_id, e.name, st.display_name, e.released_at
          HAVING MAX(MIN(rv.published_at), e.released_at) >= ?`,
    args: [schoolId, schoolId, since],
  });
  const nowIso = new Date(now).toISOString();
  const statements = [];
  for (const report of reports.rows) {
    statements.push(...await queueForGuardians(db, context, {
      kind: 'report_ready', templateKey: 'report_ready', studentId: report.student_id, today, now: nowIso,
      vars: { ...baseVars(context), studentName: report.display_name, assessmentTitle: report.exam_name || 'the assessment' },
      ref: { refType: 'submission', refId: report.submission_id }, dedup: `report_ready:${report.submission_id}`,
    }));
  }
  return queueBatch(db, statements);
}

export async function planAcademic(db, { now = Date.now() } = {}) {
  let queued = 0;
  for (const schoolId of await crmSchools(db)) {
    queued += await planSchoolAbsences(db, schoolId, now);
    queued += await planSchoolReports(db, schoolId, now);
  }
  return { queued };
}

async function switchedOff(db, message, column) {
  const context = await schoolContext(db, message.school_id);
  return on(context.settings[column]) ? null : 'This automatic message was switched off';
}

registerKind('absent', {
  async relevant(db, message) {
    const mark = (await db.execute({ sql: 'SELECT status FROM crm_session_attendance WHERE id = ? AND school_id = ?', args: [message.ref_id, message.school_id] })).rows[0];
    if (!mark || mark.status !== 'absent') return 'The attendance was corrected';
    return switchedOff(db, message, 'auto_absent');
  },
});

registerKind('report_ready', {
  async relevant(db, message) {
    const published = await db.execute({ sql: `SELECT 1 FROM report_versions rv JOIN exams e ON e.id = rv.exam_id
      WHERE rv.submission_id = ? AND rv.status = 'published' AND e.released_at IS NOT NULL LIMIT 1`, args: [message.ref_id] });
    if (!published.rows.length) return 'The report is no longer published';
    return switchedOff(db, message, 'auto_report_ready');
  },
  async prepare(db, message, provider, { now }) {
    const subject = (await db.execute({ sql: "SELECT entity_id FROM crm_comms_subjects WHERE message_id = ? AND entity_type = 'student' LIMIT 1", args: [message.id] })).rows[0];
    const linkToken = await createLink(db, {
      schoolId: message.school_id, purpose: 'report', contactId: message.contact_id, studentId: subject?.entity_id || null, submissionId: message.ref_id, messageId: message.id, now,
    });
    return { linkToken };
  },
});

registerPlanner('academic', planAcademic, { everyMs: 60_000 });
