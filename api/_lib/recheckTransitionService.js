import { randomUUID } from 'node:crypto';
import { inActorSchool } from './schoolScope.js';
import { normalizeRecheck } from './rechecks.js';
import { RecheckContractError } from './recheckCollectionService.js';

const STAFF_TRANSITIONS = Object.freeze({
  open: new Set(['in_review', 'declined', 'cancelled']),
  in_review: new Set(['declined', 'cancelled']),
});

function reject(status, message) {
  throw new RecheckContractError(status, message);
}

function transitionAllowed(from, to) {
  return STAFF_TRANSITIONS[from]?.has(to) || false;
}

export async function transitionRecheck(db, actor, requestId, input = {}, options = {}) {
  if (!['teacher', 'admin', 'skyll_admin'].includes(actor.role)) {
    reject(403, 'Reviewer access required');
  }
  if (typeof requestId !== 'string' || !requestId.trim()) {
    reject(404, 'Recheck request not found');
  }

  const targetStatus = typeof input.status === 'string' ? input.status.trim() : '';
  const result = await db.execute({
    sql: `SELECT r.*,
                 sc.display_name AS school,
                 e.school_id AS school_id,
                 sub.name AS subject,
                 v.question_number AS question_number,
                 st.display_name AS student_name
          FROM recheck_requests r
          JOIN submission_questions_v2 v ON v.id = r.submission_question_id
          JOIN submissions s ON s.id = v.submission_id
          JOIN exams e ON e.id = s.exam_id
          JOIN schools sc ON sc.id = e.school_id
          JOIN subjects sub ON sub.id = e.subject_id
          LEFT JOIN students st ON st.id = s.student_id
          WHERE r.id = ?`,
    args: [requestId],
  });
  if (!result.rows.length) reject(404, 'Recheck request not found');
  const current = result.rows[0];

  if (actor.role !== 'skyll_admin' && !(await inActorSchool(db, actor, { schoolId: current.school_id }))) {
    reject(403, 'School access denied');
  }
  if (!transitionAllowed(current.status, targetStatus)) {
    reject(400, `Cannot move a recheck from ${current.status} to ${targetStatus || 'an unknown status'}`);
  }

  const isTerminal = ['declined', 'cancelled'].includes(targetStatus);
  const suppliedNote = typeof input.resolutionNote === 'string' ? input.resolutionNote.trim() : '';
  const note = suppliedNote
    || (targetStatus === 'declined' ? 'Reviewed; the original grade remains unchanged.' : null);
  if (isTerminal && !note) reject(400, 'A resolution note is required');

  const now = options.now?.() || new Date().toISOString();
  const uuid = options.uuid || randomUUID;
  const eventId = `recheck_event_${uuid()}`;
  const update = await db.batch([
    {
      sql: `UPDATE recheck_requests
            SET status = ?,
                taken_by = CASE WHEN ? = 'in_review' THEN ? ELSE taken_by END,
                taken_at = CASE WHEN ? = 'in_review' THEN ? ELSE taken_at END,
                resolved_by = CASE WHEN ? THEN ? ELSE resolved_by END,
                resolved_at = CASE WHEN ? THEN ? ELSE resolved_at END,
                resolution_note = CASE WHEN ? THEN ? ELSE resolution_note END
            WHERE id = ? AND status = ?`,
      args: [
        targetStatus,
        targetStatus,
        actor.username,
        targetStatus,
        now,
        isTerminal ? 1 : 0,
        actor.username,
        isTerminal ? 1 : 0,
        now,
        isTerminal ? 1 : 0,
        note,
        requestId,
        current.status,
      ],
    },
    {
      sql: `INSERT INTO recheck_events (
              id, recheck_request_id, actor_user_id, event_type,
              before_json, after_json, note, created_at
            )
            SELECT ?, ?, ?, ?, ?, ?, ?, ?
            WHERE changes() = 1`,
      args: [
        eventId,
        requestId,
        actor.username,
        `status_${targetStatus}`,
        JSON.stringify({ status: current.status }),
        JSON.stringify({ status: targetStatus }),
        note,
        now,
      ],
    },
  ], 'write');

  if (Number(update[0].rowsAffected) !== 1) {
    reject(409, 'Recheck request changed while it was being reviewed');
  }

  return normalizeRecheck({
    ...current,
    status: targetStatus,
    resolution_note: isTerminal ? note : current.resolution_note,
    taken_by: targetStatus === 'in_review' ? actor.username : current.taken_by,
    taken_at: targetStatus === 'in_review' ? now : current.taken_at,
    resolved_by: isTerminal ? actor.username : current.resolved_by,
    resolved_at: isTerminal ? now : current.resolved_at,
  });
}
