// Instructor assignment and availability (CRM-014, FLKRM-327 S2, D2/D4).
//
// Assignments: who teaches a canonical batch, optionally for one subject, by
// canonical user_id. Several per batch, one lead. Ending keeps the row.
// Availability: weekly windows plus dated "not available" exceptions, in the
// school's local time. A teacher edits their own; `crm.classes.write` edits
// anyone's. Reading is school-wide for everyone with classes read.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { availabilityBody, exceptionBody, minutesToTime, summarizeWindows, timeToMinutes } from '../../shared/crm/availability.js';
import { addDays, localDate } from '../../shared/crm/time.js';
import { auditStatement } from './audit.js';
import { assertVersionedWrite, expectedVersion } from './concurrency.js';
import { CrmHttpError, crmErrors } from './errors.js';
import { crmMembers } from './members.js';
import { can } from './permissions.js';
import { loadBatchRow } from './batches.js';

const newId = (prefix) => `${prefix}_${randomUUID()}`;
const id = z.string().trim().min(1).max(128);

// Admins teach in small institutes; office staff never do (D2).
const INSTRUCTOR_ROLES = ['admin', 'teacher'];

export { availabilityBody, exceptionBody };
export const batchInstructorsQuery = z.object({ batchId: id });
export const assignInstructorBody = z.object({
  batchId: id,
  userId: id,
  subjectId: id.nullable().optional(),
  isLead: z.boolean().optional(),
}).strict();
export const assignmentBody = z.object({ assignmentId: id, expectedVersion }).strict();
export const availabilityQuery = z.object({ userId: id });
export const removeExceptionBody = z.object({ exceptionId: id }).strict();

/** Active staff who can teach, as `{ userId, name, role }`. */
export async function eligibleInstructors(db, schoolId, userIds = null) {
  return (await crmMembers(db, schoolId, userIds ? { userIds } : {}))
    .filter((member) => INSTRUCTOR_ROLES.includes(member.role))
    .map(({ userId, name, role }) => ({ userId, name, role }));
}

async function assertInstructor(db, scope, userId, path = 'userId') {
  const [member] = await eligibleInstructors(db, scope.schoolId, [userId]);
  if (!member) throw new CrmHttpError(422, 'invalid_instructor', 'Choose an active teacher or admin of this school', [{ path, message: 'Not an eligible instructor' }]);
  return member;
}

/** True when `userId` actively teaches `batchId` (any subject). Used by attendance (D3). */
export async function isAssignedTo(db, scope, userId, batchId) {
  if (!userId) return false;
  const result = await db.execute({
    sql: "SELECT 1 FROM crm_batch_instructors WHERE school_id = ? AND batch_id = ? AND user_id = ? AND status = 'active' LIMIT 1",
    args: [scope.schoolId, batchId, userId],
  });
  return result.rows.length > 0;
}

const ASSIGNMENT_SELECT = `
  SELECT a.*, u.display_name AS user_name, sj.name AS subject_name, b.name AS batch_name, b.status AS batch_status
  FROM crm_batch_instructors a
  JOIN batches b ON b.id = a.batch_id AND b.school_id = a.school_id
  LEFT JOIN users u ON u.id = a.user_id
  LEFT JOIN subjects sj ON sj.id = a.subject_id AND sj.school_id = a.school_id`;

function serializeAssignment(row) {
  return {
    id: row.id,
    batchId: row.batch_id,
    batchName: row.batch_name,
    userId: row.user_id,
    name: row.user_name || null,
    subject: row.subject_id ? { id: row.subject_id, name: row.subject_name || null } : null,
    isLead: Number(row.is_lead) === 1,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at || null,
    version: Number(row.version),
  };
}

async function loadAssignmentRow(db, scope, assignmentId) {
  const result = await db.execute({ sql: `${ASSIGNMENT_SELECT} WHERE a.id = ? AND a.school_id = ?`, args: [assignmentId, scope.schoolId] });
  if (!result.rows[0]) throw crmErrors.notFound();
  return result.rows[0];
}

export async function listBatchInstructors({ db, scope, input }) {
  const { batchId } = input.query;
  await loadBatchRow(db, scope, batchId);
  const result = await db.execute({
    sql: `${ASSIGNMENT_SELECT} WHERE a.school_id = ? AND a.batch_id = ?
          ORDER BY a.status = 'active' DESC, a.is_lead DESC, u.display_name COLLATE NOCASE, a.ended_at DESC`,
    args: [scope.schoolId, batchId],
  });
  return { items: result.rows.map(serializeAssignment), nextCursor: null };
}

function uniqueViolation(error) {
  return /UNIQUE constraint failed/i.test(String(error?.message || error?.cause?.message || ''));
}

export async function assignInstructor({ db, scope, input }) {
  const { batchId, userId, subjectId = null, isLead } = input.body;
  const batch = await loadBatchRow(db, scope, batchId);
  if (batch.status !== 'active') throw new CrmHttpError(422, 'batch_archived', 'This batch is archived');
  await assertInstructor(db, scope, userId);
  if (subjectId) {
    const found = await db.execute({ sql: 'SELECT 1 FROM subjects WHERE id = ? AND school_id = ?', args: [subjectId, scope.schoolId] });
    if (!found.rows.length) throw crmErrors.validation([{ path: 'subjectId', message: 'Choose one of the school\'s subjects' }]);
  }
  const active = await db.execute({
    sql: "SELECT id, user_id, subject_id, is_lead FROM crm_batch_instructors WHERE school_id = ? AND batch_id = ? AND status = 'active'",
    args: [scope.schoolId, batchId],
  });
  if (active.rows.some((row) => row.user_id === userId && (row.subject_id || null) === subjectId)) {
    throw new CrmHttpError(409, 'duplicate_assignment', subjectId ? 'This person already teaches this subject in the batch' : 'This person is already assigned to the batch');
  }
  const currentLead = active.rows.find((row) => Number(row.is_lead) === 1) || null;
  // The first instructor becomes the lead; later ones only when asked.
  const lead = isLead === true || (!currentLead && isLead !== false);
  const assignmentId = newId('bi');
  const now = new Date().toISOString();
  const statements = [];
  if (lead && currentLead) {
    statements.push({
      sql: "UPDATE crm_batch_instructors SET is_lead = 0, version = version + 1, updated_at = ? WHERE id = ? AND status = 'active'",
      args: [now, currentLead.id],
    });
  }
  statements.push(
    {
      sql: `INSERT INTO crm_batch_instructors (id, school_id, batch_id, user_id, subject_id, is_lead, started_at, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [assignmentId, scope.schoolId, batchId, userId, subjectId, lead ? 1 : 0, now, scope.actor.user_id || null, now, now],
    },
    auditStatement(scope, {
      action: 'instructor.changed', entityId: batchId,
      summary: { change: 'assigned', assignmentId, userId, subjectId, isLead: lead, ...(lead && currentLead ? { previousLeadUserId: currentLead.user_id } : {}) },
      now,
    }),
  );
  try {
    await db.batch(statements, 'write');
  } catch (error) {
    if (uniqueViolation(error)) throw new CrmHttpError(409, 'duplicate_assignment', 'This batch changed at the same moment. Reload and try again.');
    throw error;
  }
  return serializeAssignment(await loadAssignmentRow(db, scope, assignmentId));
}

export async function endAssignment({ db, scope, input }) {
  const { assignmentId, expectedVersion: version } = input.body;
  const row = await loadAssignmentRow(db, scope, assignmentId);
  if (row.status !== 'active') throw new CrmHttpError(422, 'invalid_transition', 'This assignment has already ended');
  const now = new Date().toISOString();
  const results = await db.batch([
    {
      sql: `UPDATE crm_batch_instructors SET status = 'ended', is_lead = 0, ended_at = ?, version = version + 1, updated_at = ?
            WHERE id = ? AND school_id = ? AND status = 'active' AND version = ?`,
      args: [now, now, row.id, scope.schoolId, version],
    },
    auditStatement(scope, {
      action: 'instructor.changed', entityId: row.batch_id,
      summary: { change: 'ended', assignmentId: row.id, userId: row.user_id, subjectId: row.subject_id || null }, onlyIfChanged: true, now,
    }),
  ], 'write');
  await assertVersionedWrite(results, 0, async () => (await loadAssignmentRow(db, scope, row.id)).version);
  return serializeAssignment(await loadAssignmentRow(db, scope, row.id));
}

export async function makeLead({ db, scope, input }) {
  const { assignmentId, expectedVersion: version } = input.body;
  const row = await loadAssignmentRow(db, scope, assignmentId);
  if (row.status !== 'active') throw new CrmHttpError(422, 'invalid_transition', 'This assignment has ended');
  if (Number(row.is_lead) === 1) return serializeAssignment(row);
  const previous = await db.execute({
    sql: "SELECT id, user_id FROM crm_batch_instructors WHERE school_id = ? AND batch_id = ? AND status = 'active' AND is_lead = 1",
    args: [scope.schoolId, row.batch_id],
  });
  const now = new Date().toISOString();
  // Both changes are guarded on this assignment still being at `version`.
  const guard = 'EXISTS (SELECT 1 FROM crm_batch_instructors WHERE id = ? AND status = \'active\' AND version = ?)';
  const results = await db.batch([
    {
      sql: `UPDATE crm_batch_instructors SET is_lead = 0, version = version + 1, updated_at = ?
            WHERE school_id = ? AND batch_id = ? AND status = 'active' AND is_lead = 1 AND ${guard}`,
      args: [now, scope.schoolId, row.batch_id, row.id, version],
    },
    {
      sql: `UPDATE crm_batch_instructors SET is_lead = 1, version = version + 1, updated_at = ?
            WHERE id = ? AND school_id = ? AND status = 'active' AND version = ?`,
      args: [now, row.id, scope.schoolId, version],
    },
    auditStatement(scope, {
      action: 'instructor.changed', entityId: row.batch_id,
      summary: { change: 'lead_changed', assignmentId: row.id, userId: row.user_id, previousLeadUserId: previous.rows[0]?.user_id || null },
      onlyIfChanged: true, now,
    }),
  ], 'write');
  await assertVersionedWrite(results, 1, async () => (await loadAssignmentRow(db, scope, row.id)).version);
  return serializeAssignment(await loadAssignmentRow(db, scope, row.id));
}

// ---------------------------------------------------------------- availability --

function serializeWindow(row) {
  return { id: row.id, weekday: Number(row.weekday), start: minutesToTime(row.start_minute), end: minutesToTime(row.end_minute), startMinute: Number(row.start_minute), endMinute: Number(row.end_minute) };
}

function serializeException(row) {
  const timed = row.start_minute !== null && row.start_minute !== undefined;
  return {
    id: row.id,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    start: timed ? minutesToTime(row.start_minute) : null,
    end: timed ? minutesToTime(row.end_minute) : null,
    startMinute: timed ? Number(row.start_minute) : null,
    endMinute: timed ? Number(row.end_minute) : null,
    reason: row.reason,
  };
}

/** Windows and live exceptions for these users, keyed by user (S3 uses this for warnings). */
export async function availabilityFor(db, scope, userIds, { fromDate = null } = {}) {
  const ids = [...new Set(userIds.filter(Boolean))];
  const empty = () => ({ windows: [], exceptions: [] });
  const byUser = Object.fromEntries(ids.map((userId) => [userId, empty()]));
  if (!ids.length) return byUser;
  const placeholders = ids.map(() => '?').join(', ');
  const [windows, exceptions] = await Promise.all([
    db.execute({ sql: `SELECT * FROM crm_availability_windows WHERE school_id = ? AND user_id IN (${placeholders}) ORDER BY weekday, start_minute`, args: [scope.schoolId, ...ids] }),
    db.execute({
      sql: `SELECT * FROM crm_availability_exceptions WHERE school_id = ? AND user_id IN (${placeholders}) AND removed_at IS NULL
              ${fromDate ? 'AND ends_on >= ?' : ''} ORDER BY starts_on, start_minute`,
      args: fromDate ? [scope.schoolId, ...ids, fromDate] : [scope.schoolId, ...ids],
    }),
  ]);
  for (const row of windows.rows) byUser[row.user_id].windows.push(serializeWindow(row));
  for (const row of exceptions.rows) byUser[row.user_id].exceptions.push(serializeException(row));
  return byUser;
}

/** Teachers may edit only their own availability unless they hold classes write. */
function assertCanEditAvailability(scope, userId) {
  if (userId === scope.actor.user_id || can(scope, 'crm.classes.write')) return;
  throw new CrmHttpError(403, 'forbidden', 'You can only change your own availability');
}

function canEditAvailability(scope, userId) {
  return userId === scope.actor.user_id || can(scope, 'crm.classes.write');
}

/** Classes → Instructors: everyone who can teach, their batches and availability. */
export async function listInstructors({ db, scope }) {
  const people = await eligibleInstructors(db, scope.schoolId);
  const today = localDate(Date.now(), scope.timezone);
  const [assignments, availability] = await Promise.all([
    db.execute({
      sql: `${ASSIGNMENT_SELECT} WHERE a.school_id = ? AND a.status = 'active' AND b.status = 'active' ORDER BY b.name COLLATE NOCASE`,
      args: [scope.schoolId],
    }),
    availabilityFor(db, scope, people.map((person) => person.userId), { fromDate: today }),
  ]);
  const byUser = {};
  for (const row of assignments.rows) (byUser[row.user_id] ||= []).push(serializeAssignment(row));
  return {
    items: people.map((person) => {
      const { windows, exceptions } = availability[person.userId];
      return {
        ...person,
        assignments: byUser[person.userId] || [],
        availability: { summary: summarizeWindows(windows), windowCount: windows.length, nextLeave: exceptions[0] || null, leaveCount: exceptions.length },
        canEditAvailability: canEditAvailability(scope, person.userId),
      };
    }),
    nextCursor: null,
  };
}

export async function getAvailability({ db, scope, input }) {
  const { userId } = input.query;
  const person = await assertInstructor(db, scope, userId);
  // Recent leave stays visible for a month, so a mistake can be spotted.
  const since = addDays(localDate(Date.now(), scope.timezone), -30);
  const { windows, exceptions } = (await availabilityFor(db, scope, [userId], { fromDate: since }))[userId];
  return { ...person, windows, exceptions, summary: summarizeWindows(windows), canEdit: canEditAvailability(scope, userId) };
}

/** Replaces the whole weekly pattern (last write wins; it's one person's own calendar). */
export async function setAvailability({ db, scope, input }) {
  const { userId, windows } = input.body;
  assertCanEditAvailability(scope, userId);
  await assertInstructor(db, scope, userId);
  const now = new Date().toISOString();
  await db.batch([
    { sql: 'DELETE FROM crm_availability_windows WHERE school_id = ? AND user_id = ?', args: [scope.schoolId, userId] },
    ...windows.map((window) => ({
      sql: `INSERT INTO crm_availability_windows (id, school_id, user_id, weekday, start_minute, end_minute, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [newId('aw'), scope.schoolId, userId, window.weekday, timeToMinutes(window.start), timeToMinutes(window.end), scope.actor.user_id || null, now, now],
    })),
    auditStatement(scope, { action: 'availability.changed', entityId: userId, summary: { change: 'windows_updated', windowCount: windows.length }, now }),
  ], 'write');
  return getAvailability({ db, scope, input: { query: { userId } } });
}

export async function addException({ db, scope, input }) {
  const { userId, startsOn, endsOn, start = null, end = null, reason } = input.body;
  assertCanEditAvailability(scope, userId);
  await assertInstructor(db, scope, userId);
  const exceptionId = newId('ax');
  const now = new Date().toISOString();
  await db.batch([
    {
      sql: `INSERT INTO crm_availability_exceptions (id, school_id, user_id, starts_on, ends_on, start_minute, end_minute, reason, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [exceptionId, scope.schoolId, userId, startsOn, endsOn, start ? timeToMinutes(start) : null, end ? timeToMinutes(end) : null, reason, scope.actor.user_id || null, now, now],
    },
    auditStatement(scope, { action: 'availability.changed', entityId: userId, summary: { change: 'exception_added', exceptionId, startsOn, endsOn }, now }),
  ], 'write');
  return getAvailability({ db, scope, input: { query: { userId } } });
}

export async function removeException({ db, scope, input }) {
  const found = await db.execute({
    sql: 'SELECT id, user_id, starts_on, ends_on, removed_at FROM crm_availability_exceptions WHERE id = ? AND school_id = ?',
    args: [input.body.exceptionId, scope.schoolId],
  });
  const row = found.rows[0];
  if (!row) throw crmErrors.notFound();
  assertCanEditAvailability(scope, row.user_id);
  if (row.removed_at) throw new CrmHttpError(422, 'invalid_transition', 'This entry was already removed');
  const now = new Date().toISOString();
  await db.batch([
    { sql: 'UPDATE crm_availability_exceptions SET removed_at = ?, updated_at = ? WHERE id = ? AND removed_at IS NULL', args: [now, now, row.id] },
    auditStatement(scope, {
      action: 'availability.changed', entityId: row.user_id,
      summary: { change: 'exception_removed', exceptionId: row.id, startsOn: row.starts_on, endsOn: row.ends_on }, onlyIfChanged: true, now,
    }),
  ], 'write');
  return getAvailability({ db, scope, input: { query: { userId: row.user_id } } });
}
