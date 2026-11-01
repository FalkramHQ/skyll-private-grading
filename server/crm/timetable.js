// Timetable rules and class sessions (CRM-015, FLKRM-327 S3, D5–D7).
//
// A rule is a weekly slot for a batch. Saving it materialises a session for
// every matching date in its range (at most a year), in the school timezone.
// Editing closes the rule version on the day before `applyFrom` and starts a
// new version in the same series: from that date only plain scheduled,
// never hand-edited sessions are replaced. Held, cancelled and edited
// sessions, and everything before `applyFrom`, are never rewritten.
//
// Clashes (same instructor, room or batch at overlapping times) and
// availability problems stop the save with 409 `schedule_conflict` unless the
// caller acknowledges them ("Save anyway"); the override is audited.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { availabilityIssue, timeToMinutes } from '../../shared/crm/availability.js';
import { assertTransition } from '../../shared/crm/lifecycles.js';
import { addDays, zonedParts } from '../../shared/crm/time.js';
import {
  cancelSessionBody, endRuleBody, intervalsOverlap, oneOffSessionBody, restoreSessionBody, ruleBody, ruleDates, sessionWindow, updateRuleBody,
  updateSessionBody,
} from '../../shared/crm/timetable.js';
import { auditStatement } from './audit.js';
import { versionConflict } from './concurrency.js';
import { CrmHttpError, crmErrors } from './errors.js';
import { assertActiveBatch, loadBatchRow } from './batches.js';
import { availabilityFor, eligibleInstructors, isAssignedTo } from './instructors.js';
import { closedDates } from './holidays.js';
import { assertActiveRoom } from './rooms.js';

const newId = (prefix) => `${prefix}_${randomUUID()}`;
const id = z.string().trim().min(1).max(128);
const SAMPLE_DATES = 5;
const MAX_SESSION_RANGE_DAYS = 62;

export { cancelSessionBody, endRuleBody, oneOffSessionBody, restoreSessionBody, ruleBody as createRuleBody, updateRuleBody, updateSessionBody };
export const rulesQuery = z.object({ batchId: id });
export const sessionsQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  batchId: id.optional(),
  instructorId: id.optional(),
  roomId: id.optional(),
  mine: z.enum(['1', 'true']).optional(),
});

async function assertBatchInstructor(db, scope, batchId, userId, path = 'instructorUserId') {
  const [person] = await eligibleInstructors(db, scope.schoolId, [userId]);
  if (!person) throw new CrmHttpError(422, 'invalid_instructor', 'Choose an active teacher or admin of this school', [{ path, message: 'Not an eligible instructor' }]);
  if (!(await isAssignedTo(db, scope, userId, batchId))) {
    throw new CrmHttpError(422, 'not_assigned', `${person.name || 'This person'} isn't assigned to this batch. Assign them on the Instructors tab first.`, [{ path, message: 'Not assigned to this batch' }]);
  }
  return person;
}

async function assertSubject(db, scope, subjectId) {
  if (!subjectId) return;
  const found = await db.execute({ sql: 'SELECT 1 FROM subjects WHERE id = ? AND school_id = ?', args: [subjectId, scope.schoolId] });
  if (!found.rows.length) throw crmErrors.validation([{ path: 'subjectId', message: 'Choose one of the school\'s subjects' }]);
}

/** Room seats, else the batch's capacity, else none (D7). */
function capacityFor(room, batch) {
  if (room?.seats) return Number(room.seats);
  return batch.capacity ? Number(batch.capacity) : null;
}

function labelTime(iso, timeZone) {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

/**
 * Clashes, availability problems and capacity for a set of candidate
 * sessions. `excludeIds` are sessions about to be replaced.
 */
export async function scheduleCheck(db, scope, { candidates, batch, instructorUserId, roomId, excludeIds = [] }) {
  const result = { conflicts: [], availability: [], capacity: null };
  if (!candidates.length) return result;
  const exclude = new Set(excludeIds);
  const first = candidates[0].startsAt;
  const last = candidates[candidates.length - 1].endsAt;
  const existing = await db.execute({
    sql: `SELECT s.id, s.batch_id, s.instructor_user_id, s.room_id, s.local_date, s.starts_at, s.ends_at,
                 b.name AS batch_name, u.display_name AS instructor_name, r.name AS room_name
          FROM crm_class_sessions s
          JOIN batches b ON b.id = s.batch_id AND b.school_id = s.school_id
          LEFT JOIN users u ON u.id = s.instructor_user_id
          LEFT JOIN crm_rooms r ON r.id = s.room_id AND r.school_id = s.school_id
          WHERE s.school_id = ? AND s.status != 'cancelled' AND s.starts_at < ? AND s.ends_at > ?
            AND (s.instructor_user_id = ? OR s.batch_id = ? OR (s.room_id IS NOT NULL AND s.room_id = ?))`,
    args: [scope.schoolId, last, first, instructorUserId, batch.id, roomId || ''],
  });
  const byDate = new Map();
  for (const row of existing.rows) {
    if (exclude.has(row.id)) continue;
    if (!byDate.has(row.local_date)) byDate.set(row.local_date, []);
    byDate.get(row.local_date).push(row);
  }

  const groups = new Map();
  for (const candidate of candidates) {
    const others = [...(byDate.get(candidate.localDate) || []), ...(byDate.get(addDays(candidate.localDate, -1)) || [])];
    for (const other of others) {
      if (!intervalsOverlap(candidate, { startsAt: other.starts_at, endsAt: other.ends_at })) continue;
      const kinds = [];
      if (other.instructor_user_id === instructorUserId) kinds.push('instructor');
      if (roomId && other.room_id === roomId) kinds.push('room');
      if (other.batch_id === batch.id) kinds.push('batch');
      for (const kind of kinds) {
        const key = `${kind}:${other.batch_id}:${labelTime(other.starts_at, scope.timezone)}`;
        if (!groups.has(key)) {
          groups.set(key, {
            kind,
            otherBatch: { id: other.batch_id, name: other.batch_name },
            instructorName: other.instructor_name || null,
            roomName: other.room_name || null,
            time: `${labelTime(other.starts_at, scope.timezone)}–${labelTime(other.ends_at, scope.timezone)}`,
            count: 0,
            dates: [],
          });
        }
        const group = groups.get(key);
        group.count += 1;
        if (group.dates.length < SAMPLE_DATES) group.dates.push(candidate.localDate);
      }
    }
  }
  result.conflicts = [...groups.values()];

  const { [instructorUserId]: calendar } = await availabilityFor(db, scope, [instructorUserId], { fromDate: candidates[0].localDate });
  const issues = new Map();
  for (const candidate of candidates) {
    const issue = availabilityIssue(calendar, { localDate: candidate.localDate, startMinute: candidate.startMinute, endMinute: candidate.endMinute });
    if (!issue) continue;
    const key = issue.kind === 'on_leave' ? `leave:${issue.reason}` : 'outside';
    if (!issues.has(key)) issues.set(key, { kind: issue.kind, reason: issue.reason || null, count: 0, dates: [] });
    const entry = issues.get(key);
    entry.count += 1;
    if (entry.dates.length < SAMPLE_DATES) entry.dates.push(candidate.localDate);
  }
  result.availability = [...issues.values()];

  const capacity = candidates[0].capacity;
  if (capacity && Number(batch.student_count) > capacity) result.capacity = { students: Number(batch.student_count), capacity };
  return result;
}

/** Throws 409 unless there's nothing to warn about or the caller chose "Save anyway". Returns whether it was an override. */
function assertAcknowledged(check, acknowledged) {
  const issues = check.conflicts.length > 0 || check.availability.length > 0;
  if (issues && !acknowledged) {
    throw new CrmHttpError(409, 'schedule_conflict', 'This clashes with other classes or the instructor\'s availability', check);
  }
  return issues;
}

const weekdayList = (weekdays) => JSON.stringify([...weekdays].sort((a, b) => a - b));

function candidatesFor(dates, { startTime, endTime, timezone, capacity }) {
  const startMinute = timeToMinutes(startTime);
  const endMinute = timeToMinutes(endTime);
  return dates.map((localDate) => ({ localDate, ...sessionWindow(localDate, startTime, endTime, timezone), startMinute, endMinute, capacity }));
}

function sessionInsert(scope, session, now, guard = null) {
  const values = [
    session.id, scope.schoolId, session.batchId, session.ruleId || null, session.seriesId || null, session.subjectId || null,
    session.instructorUserId, session.roomId || null, session.onlineUrl || null, session.localDate, session.startsAt, session.endsAt,
    session.capacity || null, session.conflictOverride ? 1 : 0, scope.actor.user_id || null, now, now,
  ];
  const columns = `(id, school_id, batch_id, rule_id, series_id, subject_id, instructor_user_id, room_id, online_url, local_date,
                    starts_at, ends_at, capacity, conflict_override, created_by, created_at, updated_at)`;
  return guard
    ? { sql: `INSERT INTO crm_class_sessions ${columns} SELECT ${values.map(() => '?').join(', ')} WHERE ${guard.sql}`, args: [...values, ...guard.args] }
    : { sql: `INSERT INTO crm_class_sessions ${columns} VALUES (${values.map(() => '?').join(', ')})`, args: values };
}

function uniqueViolation(error) {
  return /UNIQUE constraint failed/i.test(String(error?.message || error?.cause?.message || ''));
}

async function slotRefs(db, scope, batch, body) {
  await assertSubject(db, scope, body.subjectId);
  await assertBatchInstructor(db, scope, batch.id, body.instructorUserId);
  const room = body.roomId ? await assertActiveRoom(db, scope, body.roomId) : null;
  return { room, capacity: capacityFor(room, batch) };
}

// ---------------------------------------------------------------- rules --

const RULE_SELECT = `
  SELECT t.*, u.display_name AS instructor_name, r.name AS room_name, sj.name AS subject_name,
         (SELECT COUNT(*) FROM crm_class_sessions s WHERE s.rule_id = t.id) AS session_count,
         (SELECT COUNT(*) FROM crm_class_sessions s WHERE s.rule_id = t.id AND s.status = 'scheduled' AND s.starts_at >= ?) AS upcoming_count
  FROM crm_timetable_rules t
  LEFT JOIN users u ON u.id = t.instructor_user_id
  LEFT JOIN crm_rooms r ON r.id = t.room_id AND r.school_id = t.school_id
  LEFT JOIN subjects sj ON sj.id = t.subject_id AND sj.school_id = t.school_id`;

function serializeRule(row) {
  return {
    id: row.id,
    seriesId: row.series_id,
    previousRuleId: row.previous_rule_id || null,
    batchId: row.batch_id,
    subject: row.subject_id ? { id: row.subject_id, name: row.subject_name || null } : null,
    instructor: { userId: row.instructor_user_id, name: row.instructor_name || null },
    weekdays: JSON.parse(row.weekdays),
    startTime: row.start_time,
    endTime: row.end_time,
    timezone: row.timezone,
    room: row.room_id ? { id: row.room_id, name: row.room_name || null } : null,
    onlineUrl: row.online_url || null,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    status: row.status,
    sessionCount: Number(row.session_count || 0),
    upcomingCount: Number(row.upcoming_count || 0),
    version: Number(row.version),
  };
}

async function loadRuleRow(db, scope, ruleId) {
  const result = await db.execute({ sql: `${RULE_SELECT} WHERE t.id = ? AND t.school_id = ?`, args: [new Date().toISOString(), ruleId, scope.schoolId] });
  if (!result.rows[0]) throw crmErrors.notFound();
  return result.rows[0];
}

export async function listRules({ db, scope, input }) {
  const { batchId } = input.query;
  await loadBatchRow(db, scope, batchId);
  const result = await db.execute({
    sql: `${RULE_SELECT} WHERE t.school_id = ? AND t.batch_id = ? ORDER BY t.status = 'active' DESC, t.valid_from DESC, t.start_time`,
    args: [new Date().toISOString(), scope.schoolId, batchId],
  });
  return { items: result.rows.map(serializeRule), nextCursor: null };
}

export async function createRule({ db, scope, input }) {
  const body = input.body;
  const batch = await assertActiveBatch(db, scope, body.batchId);
  const { capacity } = await slotRefs(db, scope, batch, body);
  const skip = await closedDates(db, scope, body.validFrom, body.validUntil);
  const dates = ruleDates({ weekdays: body.weekdays, validFrom: body.validFrom, validUntil: body.validUntil, skipDates: skip });
  if (!dates.length) throw crmErrors.validation([{ path: 'weekdays', message: 'No class falls on these days in this date range' }]);
  const candidates = candidatesFor(dates, { ...body, timezone: scope.timezone, capacity });
  const check = await scheduleCheck(db, scope, { candidates, batch, instructorUserId: body.instructorUserId, roomId: body.roomId });
  const override = assertAcknowledged(check, body.acknowledgeConflicts);

  const ruleId = newId('rule');
  const now = new Date().toISOString();
  const statements = [
    {
      sql: `INSERT INTO crm_timetable_rules (id, school_id, series_id, batch_id, subject_id, instructor_user_id, weekdays, start_time, end_time, timezone,
                                             room_id, online_url, valid_from, valid_until, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [ruleId, scope.schoolId, ruleId, batch.id, body.subjectId || null, body.instructorUserId, weekdayList(body.weekdays),
        body.startTime, body.endTime, scope.timezone, body.roomId || null, body.onlineUrl || null, body.validFrom, body.validUntil,
        scope.actor.user_id || null, now, now],
    },
    ...candidates.map((candidate) => sessionInsert(scope, {
      ...candidate, id: newId('cs'), batchId: batch.id, ruleId, seriesId: ruleId, subjectId: body.subjectId, instructorUserId: body.instructorUserId,
      roomId: body.roomId, onlineUrl: body.onlineUrl, conflictOverride: override,
    }, now)),
    auditStatement(scope, {
      action: 'timetable.changed', entityId: batch.id,
      summary: { change: 'created', ruleId, seriesId: ruleId, sessionsCreated: candidates.length, ...(override ? { conflictOverride: true } : {}) },
      now,
    }),
  ];
  await db.batch(statements, 'write');
  return { rule: serializeRule(await loadRuleRow(db, scope, ruleId)), sessionsCreated: candidates.length, capacity: check.capacity };
}

export async function updateRule({ db, scope, input }) {
  const body = input.body;
  const old = await loadRuleRow(db, scope, body.ruleId);
  if (old.status !== 'active') throw new CrmHttpError(422, 'rule_ended', 'This timetable has ended; add a new one instead');
  if (Number(old.version) !== body.expectedVersion) throw versionConflict(Number(old.version));
  if (body.applyFrom < old.valid_from) {
    throw crmErrors.validation([{ path: 'applyFrom', message: 'Changes can start no earlier than this timetable did' }]);
  }
  const batch = await assertActiveBatch(db, scope, old.batch_id);
  const { capacity } = await slotRefs(db, scope, batch, body);

  // Sessions this edit replaces, and dates the series keeps (held, cancelled, hand-edited).
  const [replaceable, kept] = await Promise.all([
    db.execute({
      sql: "SELECT id FROM crm_class_sessions WHERE school_id = ? AND rule_id = ? AND local_date >= ? AND status = 'scheduled' AND is_edited = 0",
      args: [scope.schoolId, old.id, body.applyFrom],
    }),
    db.execute({
      sql: `SELECT local_date FROM crm_class_sessions WHERE school_id = ? AND series_id = ? AND local_date >= ?
              AND NOT (rule_id = ? AND status = 'scheduled' AND is_edited = 0)`,
      args: [scope.schoolId, old.series_id, body.applyFrom, old.id],
    }),
  ]);
  const replaceIds = replaceable.rows.map((row) => row.id);
  const skip = await closedDates(db, scope, body.applyFrom, body.validUntil);
  for (const row of kept.rows) skip.add(row.local_date);
  const dates = ruleDates({ weekdays: body.weekdays, validFrom: body.applyFrom, validUntil: body.validUntil, skipDates: skip });
  const candidates = candidatesFor(dates, { ...body, timezone: scope.timezone, capacity });
  const check = await scheduleCheck(db, scope, { candidates, batch, instructorUserId: body.instructorUserId, roomId: body.roomId, excludeIds: replaceIds });
  const override = assertAcknowledged(check, body.acknowledgeConflicts);

  const ruleId = newId('rule');
  const now = new Date().toISOString();
  // Everything after the first statement applies only if the old version was closed by this request.
  const guard = { sql: 'EXISTS (SELECT 1 FROM crm_timetable_rules WHERE id = ? AND version = ? AND updated_at = ?)', args: [old.id, body.expectedVersion + 1, now] };
  const statements = [
    {
      sql: `UPDATE crm_timetable_rules SET status = 'ended', valid_until = ?, version = version + 1, updated_at = ?
            WHERE id = ? AND school_id = ? AND status = 'active' AND version = ?`,
      args: [addDays(body.applyFrom, -1), now, old.id, scope.schoolId, body.expectedVersion],
    },
    {
      sql: `DELETE FROM crm_class_sessions WHERE school_id = ? AND rule_id = ? AND local_date >= ? AND status = 'scheduled' AND is_edited = 0 AND ${guard.sql}`,
      args: [scope.schoolId, old.id, body.applyFrom, ...guard.args],
    },
    {
      sql: `INSERT INTO crm_timetable_rules (id, school_id, series_id, previous_rule_id, batch_id, subject_id, instructor_user_id, weekdays, start_time, end_time,
                                             timezone, room_id, online_url, valid_from, valid_until, created_by, created_at, updated_at)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql}`,
      args: [ruleId, scope.schoolId, old.series_id, old.id, batch.id, body.subjectId || null, body.instructorUserId, weekdayList(body.weekdays),
        body.startTime, body.endTime, scope.timezone, body.roomId || null, body.onlineUrl || null, body.applyFrom, body.validUntil,
        scope.actor.user_id || null, now, now, ...guard.args],
    },
    ...candidates.map((candidate) => sessionInsert(scope, {
      ...candidate, id: newId('cs'), batchId: batch.id, ruleId, seriesId: old.series_id, subjectId: body.subjectId, instructorUserId: body.instructorUserId,
      roomId: body.roomId, onlineUrl: body.onlineUrl, conflictOverride: override,
    }, now, guard)),
    auditStatement(scope, {
      action: 'timetable.changed', entityId: batch.id,
      summary: {
        change: 'updated', ruleId, seriesId: old.series_id, previousRuleId: old.id, applyFrom: body.applyFrom,
        sessionsCreated: candidates.length, sessionsRemoved: replaceIds.length, sessionsKept: kept.rows.length, ...(override ? { conflictOverride: true } : {}),
      },
      when: guard, now,
    }),
  ];
  let results;
  try {
    results = await db.batch(statements, 'write');
  } catch (error) {
    // A session became held or edited between the read and the write.
    if (uniqueViolation(error)) throw new CrmHttpError(409, 'version_conflict', 'Sessions changed while you were editing. Reload and try again.');
    throw error;
  }
  if (!Number(results[0].rowsAffected)) throw versionConflict(Number((await loadRuleRow(db, scope, old.id)).version));
  return {
    rule: serializeRule(await loadRuleRow(db, scope, ruleId)),
    sessionsCreated: candidates.length,
    sessionsRemoved: Number(results[1].rowsAffected),
    sessionsKept: kept.rows.length,
    capacity: check.capacity,
  };
}

/** Ends a timetable after `lastDate`: later plain scheduled sessions go; the rest stay. */
export async function endRule({ db, scope, input }) {
  const { ruleId, expectedVersion, lastDate } = input.body;
  const row = await loadRuleRow(db, scope, ruleId);
  if (row.status !== 'active') throw new CrmHttpError(422, 'rule_ended', 'This timetable has already ended');
  if (lastDate > row.valid_until) throw crmErrors.validation([{ path: 'lastDate', message: 'To run longer, edit the timetable instead' }]);
  const now = new Date().toISOString();
  const guard = { sql: 'EXISTS (SELECT 1 FROM crm_timetable_rules WHERE id = ? AND version = ? AND updated_at = ?)', args: [row.id, expectedVersion + 1, now] };
  const results = await db.batch([
    {
      sql: `UPDATE crm_timetable_rules SET status = 'ended', valid_until = ?, version = version + 1, updated_at = ?
            WHERE id = ? AND school_id = ? AND status = 'active' AND version = ?`,
      args: [lastDate, now, row.id, scope.schoolId, expectedVersion],
    },
    {
      sql: `DELETE FROM crm_class_sessions WHERE school_id = ? AND rule_id = ? AND local_date > ? AND status = 'scheduled' AND is_edited = 0 AND ${guard.sql}`,
      args: [scope.schoolId, row.id, lastDate, ...guard.args],
    },
    auditStatement(scope, { action: 'timetable.changed', entityId: row.batch_id, summary: { change: 'ended', ruleId: row.id, seriesId: row.series_id, lastDate }, when: guard, now }),
  ], 'write');
  if (!Number(results[0].rowsAffected)) throw versionConflict(Number((await loadRuleRow(db, scope, row.id)).version));
  return { rule: serializeRule(await loadRuleRow(db, scope, row.id)), sessionsRemoved: Number(results[1].rowsAffected) };
}

// ---------------------------------------------------------------- sessions --

export const SESSION_SELECT = `
  SELECT s.*, b.name AS batch_name, b.status AS batch_status, u.display_name AS instructor_name, r.name AS room_name, sj.name AS subject_name
  FROM crm_class_sessions s
  JOIN batches b ON b.id = s.batch_id AND b.school_id = s.school_id
  LEFT JOIN users u ON u.id = s.instructor_user_id
  LEFT JOIN crm_rooms r ON r.id = s.room_id AND r.school_id = s.school_id
  LEFT JOIN subjects sj ON sj.id = s.subject_id AND sj.school_id = s.school_id`;

export function serializeSession(row, scope, nowIso = new Date().toISOString()) {
  return {
    id: row.id,
    batch: { id: row.batch_id, name: row.batch_name },
    ruleId: row.rule_id || null,
    seriesId: row.series_id || null,
    subject: row.subject_id ? { id: row.subject_id, name: row.subject_name || null } : null,
    instructor: { userId: row.instructor_user_id, name: row.instructor_name || null },
    room: row.room_id ? { id: row.room_id, name: row.room_name || null } : null,
    onlineUrl: row.online_url || null,
    localDate: row.local_date,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    capacity: row.capacity === null || row.capacity === undefined ? null : Number(row.capacity),
    status: row.status,
    // Past and still scheduled: attendance hasn't been taken (D6). Derived, never stored.
    notMarked: row.status === 'scheduled' && row.ends_at < nowIso,
    cancelReason: row.cancel_reason || null,
    isEdited: Number(row.is_edited) === 1,
    isMine: Boolean(scope.actor.user_id) && row.instructor_user_id === scope.actor.user_id,
    version: Number(row.version),
  };
}

export async function listSessions({ db, scope, input }) {
  const { from, to, batchId, instructorId, roomId, mine } = input.query;
  if (to < from) throw crmErrors.validation([{ path: 'to', message: 'The end must be on or after the start' }]);
  if (Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) > MAX_SESSION_RANGE_DAYS) {
    throw crmErrors.validation([{ path: 'to', message: `Ask for at most ${MAX_SESSION_RANGE_DAYS} days at a time` }]);
  }
  const clauses = ['s.school_id = ?', 's.local_date >= ?', 's.local_date <= ?'];
  const args = [scope.schoolId, from, to];
  if (batchId) { clauses.push('s.batch_id = ?'); args.push(batchId); }
  if (instructorId) { clauses.push('s.instructor_user_id = ?'); args.push(instructorId); }
  if (roomId) { clauses.push('s.room_id = ?'); args.push(roomId); }
  if (mine) { clauses.push('s.instructor_user_id = ?'); args.push(scope.actor.user_id || ''); }
  const result = await db.execute({ sql: `${SESSION_SELECT} WHERE ${clauses.join(' AND ')} ORDER BY s.starts_at, b.name LIMIT 2000`, args });
  const nowIso = new Date().toISOString();
  const leave = await leaveFlags(db, scope, result.rows, from);
  return { items: result.rows.map((row) => ({ ...serializeSession(row, scope, nowIso), onLeave: leave.has(row.id) })), nextCursor: null };
}

function localMinutes(iso, timeZone) {
  const parts = zonedParts(Date.parse(iso), timeZone);
  return parts.hour * 60 + parts.minute;
}

/**
 * Sessions whose instructor has leave covering them (D4): flagged, never moved.
 * Cancelled and held sessions don't need the flag.
 */
async function leaveFlags(db, scope, rows, fromDate) {
  const open = rows.filter((row) => row.status === 'scheduled');
  if (!open.length) return new Set();
  const calendars = await availabilityFor(db, scope, open.map((row) => row.instructor_user_id), { fromDate });
  const flagged = new Set();
  for (const row of open) {
    const { exceptions } = calendars[row.instructor_user_id] || { exceptions: [] };
    if (!exceptions.length) continue;
    const issue = availabilityIssue({ windows: [], exceptions }, {
      localDate: row.local_date, startMinute: localMinutes(row.starts_at, scope.timezone), endMinute: localMinutes(row.ends_at, scope.timezone),
    });
    if (issue?.kind === 'on_leave') flagged.add(row.id);
  }
  return flagged;
}

export async function loadSessionRow(db, scope, sessionId) {
  const result = await db.execute({ sql: `${SESSION_SELECT} WHERE s.id = ? AND s.school_id = ?`, args: [sessionId, scope.schoolId] });
  if (!result.rows[0]) throw crmErrors.notFound();
  return result.rows[0];
}

/** An extra class outside any timetable (D5). */
export async function createOneOffSession({ db, scope, input }) {
  const body = input.body;
  const batch = await assertActiveBatch(db, scope, body.batchId);
  const { capacity } = await slotRefs(db, scope, batch, body);
  const candidates = candidatesFor([body.localDate], { ...body, timezone: scope.timezone, capacity });
  const check = await scheduleCheck(db, scope, { candidates, batch, instructorUserId: body.instructorUserId, roomId: body.roomId });
  const override = assertAcknowledged(check, body.acknowledgeConflicts);
  const sessionId = newId('cs');
  const now = new Date().toISOString();
  await db.batch([
    sessionInsert(scope, {
      ...candidates[0], id: sessionId, batchId: batch.id, subjectId: body.subjectId, instructorUserId: body.instructorUserId,
      roomId: body.roomId, onlineUrl: body.onlineUrl, conflictOverride: override,
    }, now),
    auditStatement(scope, {
      action: 'session.changed', entityId: sessionId,
      summary: { change: 'created', batchId: batch.id, localDate: body.localDate, ...(override ? { conflictOverride: true } : {}) },
      now,
    }),
  ], 'write');
  return { session: serializeSession(await loadSessionRow(db, scope, sessionId), scope), capacity: check.capacity };
}

// ---------------------------------------------------------------- S4: one session --

function versionGuardedSessionUpdate(scope, row, expected, set, args, now) {
  return {
    sql: `UPDATE crm_class_sessions SET ${set}, version = version + 1, updated_at = ? WHERE id = ? AND school_id = ? AND version = ?`,
    args: [...args, now, row.id, scope.schoolId, expected],
  };
}

async function finishSessionWrite(db, scope, results, row) {
  if (Number(results[0].rowsAffected)) return serializeSession(await loadSessionRow(db, scope, row.id), scope);
  const current = await loadSessionRow(db, scope, row.id);
  throw versionConflict(Number(current.version));
}

/** Cancel one class with a reason (D6). Not once attendance is taken. */
export async function cancelSession({ db, scope, input }) {
  const { sessionId, expectedVersion, reason } = input.body;
  const row = await loadSessionRow(db, scope, sessionId);
  if (row.status === 'held') throw new CrmHttpError(422, 'session_held', 'Attendance has been taken for this class, so it can\'t be cancelled');
  assertTransition('classSession', row.status, 'cancelled', { reason });
  const now = new Date().toISOString();
  const results = await db.batch([
    versionGuardedSessionUpdate(scope, row, expectedVersion, "status = 'cancelled', cancel_reason = ?, cancelled_by = ?, cancelled_at = ?", [reason, scope.actor.user_id || null, now], now),
    auditStatement(scope, { action: 'session.changed', entityId: row.id, summary: { change: 'cancelled', batchId: row.batch_id, localDate: row.local_date, reason }, onlyIfChanged: true, now }),
  ], 'write');
  return finishSessionWrite(db, scope, results, row);
}

/** Undo a cancel while the class is still in the future; the usual clash checks apply. */
export async function restoreSession({ db, scope, input }) {
  const { sessionId, expectedVersion, acknowledgeConflicts } = input.body;
  const row = await loadSessionRow(db, scope, sessionId);
  assertTransition('classSession', row.status, 'scheduled');
  if (row.starts_at <= new Date().toISOString()) throw new CrmHttpError(422, 'session_past', 'Only future classes can be brought back. Add a one-off class instead.');
  const batch = await assertActiveBatch(db, scope, row.batch_id);
  const check = await scheduleCheck(db, scope, {
    candidates: [{ localDate: row.local_date, startsAt: row.starts_at, endsAt: row.ends_at, startMinute: localMinutes(row.starts_at, scope.timezone), endMinute: localMinutes(row.ends_at, scope.timezone), capacity: row.capacity }],
    batch, instructorUserId: row.instructor_user_id, roomId: row.room_id, excludeIds: [row.id],
  });
  const override = assertAcknowledged(check, acknowledgeConflicts);
  const now = new Date().toISOString();
  const results = await db.batch([
    versionGuardedSessionUpdate(scope, row, expectedVersion, "status = 'scheduled', cancel_reason = NULL, cancelled_by = NULL, cancelled_at = NULL, conflict_override = MAX(conflict_override, ?)", [override ? 1 : 0], now),
    auditStatement(scope, {
      action: 'session.changed', entityId: row.id,
      summary: { change: 'restored', batchId: row.batch_id, localDate: row.local_date, ...(override ? { conflictOverride: true } : {}) }, onlyIfChanged: true, now,
    }),
  ], 'write');
  return finishSessionWrite(db, scope, results, row);
}

/**
 * A substitute, room or link for one scheduled class (D6). The substitute
 * may be any active teacher or admin, not only the batch's instructors. The
 * session is marked hand-edited so later timetable changes keep it.
 */
export async function updateSession({ db, scope, input }) {
  const { sessionId, expectedVersion, instructorUserId, roomId = null, onlineUrl = null, acknowledgeConflicts } = input.body;
  const row = await loadSessionRow(db, scope, sessionId);
  if (row.status !== 'scheduled') throw new CrmHttpError(422, 'session_not_scheduled', 'Only scheduled classes can be changed');
  const [person] = await eligibleInstructors(db, scope.schoolId, [instructorUserId]);
  if (!person) throw new CrmHttpError(422, 'invalid_instructor', 'Choose an active teacher or admin of this school', [{ path: 'instructorUserId', message: 'Not an eligible instructor' }]);
  const room = roomId && roomId !== row.room_id ? await assertActiveRoom(db, scope, roomId) : null;
  const fields = [
    ['instructor', row.instructor_user_id, instructorUserId], ['room', row.room_id || null, roomId], ['onlineUrl', row.online_url || null, onlineUrl],
  ].filter(([, from, to]) => from !== to).map(([field]) => field);
  if (!fields.length) return serializeSession(row, scope);
  const batch = await loadBatchRow(db, scope, row.batch_id);
  const capacity = roomId === row.room_id ? (row.capacity === null ? null : Number(row.capacity)) : capacityFor(room, batch);
  const check = (fields.includes('instructor') || fields.includes('room'))
    ? await scheduleCheck(db, scope, {
      candidates: [{ localDate: row.local_date, startsAt: row.starts_at, endsAt: row.ends_at, startMinute: localMinutes(row.starts_at, scope.timezone), endMinute: localMinutes(row.ends_at, scope.timezone), capacity }],
      batch, instructorUserId, roomId, excludeIds: [row.id],
    })
    : { conflicts: [], availability: [], capacity: null };
  const override = assertAcknowledged(check, acknowledgeConflicts);
  const now = new Date().toISOString();
  const results = await db.batch([
    versionGuardedSessionUpdate(scope, row, expectedVersion,
      'instructor_user_id = ?, room_id = ?, online_url = ?, capacity = ?, is_edited = 1, conflict_override = MAX(conflict_override, ?)',
      [instructorUserId, roomId, onlineUrl, capacity, override ? 1 : 0], now),
    auditStatement(scope, {
      action: 'session.changed', entityId: row.id,
      summary: {
        change: 'updated', batchId: row.batch_id, localDate: row.local_date, fields,
        ...(fields.includes('instructor') ? { fromInstructorUserId: row.instructor_user_id, toInstructorUserId: instructorUserId } : {}),
        ...(override ? { conflictOverride: true } : {}),
      },
      onlyIfChanged: true, now,
    }),
  ], 'write');
  return finishSessionWrite(db, scope, results, row);
}
