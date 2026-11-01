import { randomUUID } from 'node:crypto';
import { ACTIVE_RECHECK_STATES, canTransitionRecheck } from '../../shared/workflowLifecycle.js';

export const activeRecheckSql = ACTIVE_RECHECK_STATES.map(() => '?').join(', ');

export function normalizeRecheck(row) {
  return {
    id: row.id,
    submissionQuestionId: row.submission_question_id,
    submissionId: row.submission_id,
    review_student_id: row.student_id,
    studentId: row.student_id,
    studentName: row.student_name || '',
    school: row.school,
    subject: row.subject,
    question_number: row.question_number,
    questionNumber: row.question_number,
    reason: row.reason,
    requestedBy: row.requested_by || '',
    requestedByRole: row.requested_by_role || 'student',
    status: row.status,
    requestedAt: row.requested_at,
    takenBy: row.taken_by,
    takenAt: row.taken_at,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at,
    resolutionNote: row.resolution_note,
  };
}

export async function appendRecheckEvent(db, { requestId, actorUserId, eventType, before = null, after = null, note = null, createdAt = new Date().toISOString() }) {
  await db.execute({
    sql: `INSERT INTO recheck_events (id, recheck_request_id, actor_user_id, event_type, before_json, after_json, note, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [`recheck_event_${randomUUID()}`, requestId, actorUserId, eventType, before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after), note, createdAt],
  });
}

export function assertRecheckTransition(from, to) {
  if (!canTransitionRecheck(from, to)) throw new Error(`Cannot move a recheck from ${from} to ${to}`);
}
