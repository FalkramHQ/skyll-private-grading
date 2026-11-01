import { randomUUID } from 'node:crypto';
import { ACTIVE_RECHECK_STATES, RECHECK_STATES } from '../../shared/workflowLifecycle.js';
import { inActorSchool } from './schoolScope.js';
import { activeRecheckSql, normalizeRecheck } from './rechecks.js';
import { recordUserEvent } from './userEvents.js';

export class RecheckContractError extends Error {
  constructor(status, message, details = {}) {
    super(message);
    this.name = 'RecheckContractError';
    this.status = status;
    this.details = details;
  }
}

function reject(status, message, details) {
  throw new RecheckContractError(status, message, details);
}

function normalizedStatusFilter(value) {
  const status = String(value || 'active');
  if (status === 'all') return null;
  if (status === 'active') return ACTIVE_RECHECK_STATES;
  if (!RECHECK_STATES.includes(status)) reject(400, 'Unsupported recheck status');
  return [status];
}

function normalizeReason(value) {
  if (typeof value !== 'string') reject(400, 'Explain the reason for rechecking in 12 to 800 characters');
  const reason = value.trim().replace(/\s+/g, ' ');
  if (reason.length < 12 || reason.length > 800) {
    reject(400, 'Explain the reason for rechecking in 12 to 800 characters');
  }
  return reason;
}

function questionSelect() {
  // Canonical-only (Phase B). Subject match uses exams → subjects.name.
  return `SELECT v.id AS id,
                 v.submission_id AS submission_id,
                 sc.display_name AS school,
                 e.school_id AS school_id,
                 sub.name AS subject,
                 v.question_number AS question_number,
                 s.student_id AS student_id,
                 st.display_name AS student_name
          FROM submission_questions_v2 v
          JOIN submissions s ON s.id = v.submission_id
          JOIN exams e ON e.id = s.exam_id
          JOIN schools sc ON sc.id = e.school_id
          JOIN subjects sub ON sub.id = e.subject_id
          LEFT JOIN students st ON st.id = s.student_id
          WHERE v.submission_id = ? AND sub.name = ? AND v.question_number = ?
          LIMIT 1`;
}

async function activeRequestForQuestion(db, row) {
  const existing = await db.execute({
    sql: `SELECT * FROM recheck_requests
          WHERE submission_question_id = ?
            AND status IN (${activeRecheckSql})
          LIMIT 1`,
    args: [row.id, ...ACTIVE_RECHECK_STATES],
  });
  if (!existing.rows.length) return null;
  return normalizeRecheck({
    ...row,
    ...existing.rows[0],
    submission_question_id: row.id,
  });
}

function isUniqueConstraint(error) {
  return String(error?.code || '').includes('SQLITE_CONSTRAINT')
    || /unique constraint/i.test(String(error?.message || ''));
}

export async function listRechecks(db, actor, query = {}) {
  const statuses = normalizedStatusFilter(query.status);
  const school = String(query.school || '').trim();
  const subject = String(query.subject || '').trim();
  const clauses = [];
  const args = [];

  if (actor.role === 'student') {
    clauses.push(`EXISTS (
      SELECT 1 FROM report_versions report
      WHERE report.submission_id = r.submission_id
        AND report.username = ?
        AND report.status = 'published'
    )`);
    args.push(actor.username);
  } else if (actor.role === 'skyll_admin') {
    if (school) {
      clauses.push('sc.display_name = ?');
      args.push(school);
    }
  } else if (actor.role === 'admin' || actor.role === 'teacher') {
    if (!actor.school) reject(400, 'School is required');
    clauses.push('sc.display_name = ?');
    args.push(actor.school);
  } else {
    reject(403, 'You do not have permission to view rechecks');
  }

  if (subject) {
    clauses.push('sub.name = ?');
    args.push(subject);
  }
  if (statuses) {
    clauses.push(`r.status IN (${statuses.map(() => '?').join(', ')})`);
    args.push(...statuses);
  }

  const result = await db.execute({
    sql: `SELECT r.*,
                 v.question_number AS question_number,
                 sub.name AS subject,
                 sc.display_name AS school,
                 st.display_name AS student_name
          FROM recheck_requests r
          JOIN submission_questions_v2 v ON v.id = r.submission_question_id
          JOIN submissions s ON s.id = v.submission_id
          JOIN exams e ON e.id = s.exam_id
          JOIN schools sc ON sc.id = e.school_id
          JOIN subjects sub ON sub.id = e.subject_id
          LEFT JOIN students st ON st.id = s.student_id
          WHERE ${clauses.length ? clauses.join(' AND ') : '1 = 1'}
          ORDER BY r.requested_at DESC`,
    args,
  });
  return result.rows.map(normalizeRecheck);
}

export async function createRecheck(db, actor, input = {}, options = {}) {
  if (!['student', 'teacher', 'admin', 'skyll_admin'].includes(actor.role)) {
    reject(403, 'You do not have permission to request a recheck');
  }

  const submissionId = typeof input.submissionId === 'string' ? input.submissionId.trim() : '';
  const subject = typeof input.subject === 'string' ? input.subject.trim() : '';
  const questionNumber = typeof input.questionNumber === 'string' || typeof input.questionNumber === 'number'
    ? String(input.questionNumber).trim()
    : '';
  if (!submissionId || !subject || !questionNumber) {
    reject(400, 'Assessment, subject, and question are required');
  }
  const reason = normalizeReason(input.reason);

  const question = await db.execute({
    sql: questionSelect(),
    args: [submissionId, subject, questionNumber],
  });
  if (!question.rows.length) reject(404, 'This question is not available for this report');
  const row = question.rows[0];

  const published = await db.execute({
    sql: `SELECT username, school FROM report_versions
          WHERE submission_id = ? AND status = 'published'
          ORDER BY version DESC LIMIT 1`,
    args: [row.submission_id],
  });
  if (!published.rows.length) {
    reject(actor.role === 'student' ? 403 : 404, 'Rechecks are available only for published reports');
  }
  const report = published.rows[0];

  if (actor.role === 'student' && report.username !== actor.username) {
    reject(403, 'You can only request a recheck for your own published report');
  }
  if ((actor.role === 'admin' || actor.role === 'teacher')
    && (!(await inActorSchool(db, actor, { schoolId: row.school_id })) || !(await inActorSchool(db, actor, { schoolName: report.school })))) {
    reject(403, 'School access denied');
  }

  const existing = await activeRequestForQuestion(db, row);
  if (existing) reject(409, 'A recheck is already active for this question', { request: existing });

  const now = options.now?.() || new Date().toISOString();
  const uuid = options.uuid || randomUUID;
  const requestId = `recheck_${uuid()}`;
  const eventId = `recheck_event_${uuid()}`;
  const requestedByRole = actor.role;
  try {
    await db.batch([
      {
        sql: `INSERT INTO recheck_requests (
                id, submission_question_id, submission_id, student_id, reason,
                requested_by, requested_by_role, status, requested_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
        args: [requestId, row.id, row.submission_id, row.student_id, reason, actor.username, requestedByRole, now],
      },
      {
        sql: `INSERT INTO recheck_events (
                id, recheck_request_id, actor_user_id, event_type,
                after_json, note, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [
          eventId,
          requestId,
          actor.username,
          actor.role === 'student' ? 'requested_by_student' : 'requested_by_admin',
          JSON.stringify({ status: 'open', requestedByRole }),
          reason,
          now,
        ],
      },
    ], 'write');
  } catch (error) {
    if (!isUniqueConstraint(error)) throw error;
    const raced = await activeRequestForQuestion(db, row);
    if (raced) reject(409, 'A recheck is already active for this question', { request: raced });
    throw error;
  }

  try {
    await recordUserEvent(db, {
      user: actor,
      eventType: 'recheck_requested',
      eventData: {
        submissionId: row.submission_id,
        questionNumber: row.question_number,
        subject: row.subject,
      },
      platform: 'web',
      now,
    });
  } catch {
    // Telemetry must never fail a recheck.
  }

  return normalizeRecheck({
    ...row,
    id: requestId,
    submission_question_id: row.id,
    submission_id: row.submission_id,
    student_id: row.student_id,
    reason,
    requested_by: actor.username,
    requested_by_role: requestedByRole,
    status: 'open',
    requested_at: now,
  });
}
