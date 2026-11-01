// Who a staff member may message (D11). Admins and office staff with comms
// access reach the whole school. Teachers, once granted comms access, reach
// only students in batches they teach or are assigned to.
import { crmErrors } from './errors.js';

export function commsOwnOnly(scope) {
  return scope.actor?.role === 'teacher' && !scope.support;
}

/** Batches a teacher teaches (a session) or is assigned to. */
export async function ownBatchIds(db, scope) {
  const userId = scope.actor.user_id || '';
  const result = await db.execute({
    sql: `SELECT batch_id FROM crm_batch_instructors WHERE school_id = ? AND user_id = ? AND status = 'active'
          UNION
          SELECT DISTINCT batch_id FROM crm_class_sessions WHERE school_id = ? AND instructor_user_id = ?`,
    args: [scope.schoolId, userId, scope.schoolId, userId],
  });
  return result.rows.map((row) => row.batch_id);
}

/** SQL (and args) limiting `<alias>.student_id`-style columns to a teacher's own students. */
export async function ownStudentFilter(db, scope, column) {
  if (!commsOwnOnly(scope)) return null;
  const batches = await ownBatchIds(db, scope);
  if (!batches.length) return { sql: '0', args: [] };
  return {
    sql: `${column} IN (SELECT m.student_id FROM batch_memberships m WHERE m.status = 'active' AND m.batch_id IN (${batches.map(() => '?').join(', ')}))`,
    args: batches,
  };
}

export async function assertStudentsInCommsScope(db, scope, studentIds) {
  if (!commsOwnOnly(scope)) return;
  const filter = await ownStudentFilter(db, scope, 's.id');
  const result = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM students s WHERE s.school_id = ? AND s.id IN (${studentIds.map(() => '?').join(', ')}) AND ${filter.sql}`,
    args: [scope.schoolId, ...studentIds, ...filter.args],
  });
  if (Number(result.rows[0].n) !== new Set(studentIds).size) throw crmErrors.forbidden();
}

export async function assertBatchInCommsScope(db, scope, batchId) {
  if (!commsOwnOnly(scope)) return;
  if (!(await ownBatchIds(db, scope)).includes(batchId)) throw crmErrors.forbidden();
}
