// Batches in the CRM (CRM-013, FLKRM-327 S1, D1/D12). `batches` and
// `batch_memberships` stay the one class roster that tests, the teacher roster
// screen and admissions already use: the CRM writes the same rows with the
// same rules (active names unique per school, a year on every batch) and keeps
// its extras in `crm_batch_settings`. No columns are added to `batches`.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { batchBody, updateBatchBody } from '../../shared/crm/classes.js';
import { auditStatement } from './audit.js';
import { versionConflict } from './concurrency.js';
import { assertSchoolRefs } from './courses.js';
import { CrmHttpError, crmErrors } from './errors.js';
import { can } from './permissions.js';
import { assertActiveRoom, serializeRoom } from './rooms.js';

const newId = (prefix) => `${prefix}_${randomUUID()}`;
const id = z.string().trim().min(1).max(128);

export { batchBody as createBatchBody, updateBatchBody };
export const listBatchesQuery = z.object({
  status: z.enum(['active', 'archived', 'all']).default('active'),
  courseId: z.string().max(128).optional(),
});
export const batchQuery = z.object({ batchId: id });
export const batchCourseBody = z.object({ batchId: id, courseId: id.nullable(), expectedVersion: z.coerce.number().int().min(0) }).strict();
// `cancelFutureSessions` confirms the "This cancels N future classes" prompt (D12).
export const archiveBatchBody = z.object({ batchId: id, cancelFutureSessions: z.boolean().optional() }).strict();
export const batchStudentsQuery = z.object({ batchId: id, view: z.enum(['current', 'past']).default('current') });
export const addBatchStudentsBody = z.object({ batchId: id, studentIds: z.array(id).min(1, 'Choose at least one student').max(200) }).strict();
export const removeBatchStudentBody = z.object({ batchId: id, membershipId: id }).strict();

export const BATCH_SELECT = `
  SELECT b.id, b.name, b.grade, b.status, b.academic_year, b.academic_year_id, b.subject_id, b.created_at,
         ay.label AS academic_year_label, ay.starts_on AS year_starts_on, ay.ends_on AS year_ends_on,
         sj.name AS subject_name,
         s.course_id, c.name AS course_name, c.status AS course_status,
         s.starts_on, s.ends_on, s.capacity, s.default_room_id, s.default_online_url, s.version AS settings_version,
         r.name AS room_name, r.seats AS room_seats, r.status AS room_status, r.version AS room_version,
         (SELECT COUNT(*) FROM batch_memberships m WHERE m.batch_id = b.id AND m.status = 'active') AS student_count,
         li.user_id AS lead_user_id, lu.display_name AS lead_name
  FROM batches b
  LEFT JOIN academic_years ay ON ay.id = b.academic_year_id AND ay.school_id = b.school_id
  LEFT JOIN subjects sj ON sj.id = b.subject_id AND sj.school_id = b.school_id
  LEFT JOIN crm_batch_settings s ON s.batch_id = b.id AND s.school_id = b.school_id
  LEFT JOIN crm_courses c ON c.id = s.course_id AND c.school_id = b.school_id
  LEFT JOIN crm_rooms r ON r.id = s.default_room_id AND r.school_id = b.school_id
  LEFT JOIN crm_batch_instructors li ON li.batch_id = b.id AND li.school_id = b.school_id AND li.status = 'active' AND li.is_lead = 1
  LEFT JOIN users lu ON lu.id = li.user_id`;

export function serializeBatch(row) {
  return {
    id: row.id,
    name: row.name,
    grade: row.grade || null,
    status: row.status,
    academicYear: row.academic_year_id
      ? { id: row.academic_year_id, label: row.academic_year_label || row.academic_year || null, startsOn: row.year_starts_on || null, endsOn: row.year_ends_on || null }
      : null,
    subject: row.subject_id ? { id: row.subject_id, name: row.subject_name || null } : null,
    course: row.course_id ? { id: row.course_id, name: row.course_name || null, status: row.course_status || null } : null,
    startsOn: row.starts_on || null,
    endsOn: row.ends_on || null,
    capacity: row.capacity === null || row.capacity === undefined ? null : Number(row.capacity),
    defaultRoom: row.default_room_id
      ? serializeRoom({ id: row.default_room_id, name: row.room_name, seats: row.room_seats, status: row.room_status, version: row.room_version || 1 })
      : null,
    defaultOnlineUrl: row.default_online_url || null,
    studentCount: Number(row.student_count || 0),
    lead: row.lead_user_id ? { userId: row.lead_user_id, name: row.lead_name || null } : null,
    // 0 until the batch is first edited in the CRM (no settings row yet).
    version: Number(row.settings_version || 0),
  };
}

export async function loadBatchRow(db, scope, batchId) {
  const result = await db.execute({ sql: `${BATCH_SELECT} WHERE b.id = ? AND b.school_id = ?`, args: [batchId, scope.schoolId] });
  if (!result.rows[0]) throw crmErrors.notFound();
  return result.rows[0];
}

export async function listBatches({ db, scope, input }) {
  const { status, courseId } = input.query;
  const clauses = ['b.school_id = ?'];
  const args = [scope.schoolId];
  if (status !== 'all') { clauses.push('b.status = ?'); args.push(status); }
  if (courseId) { clauses.push('s.course_id = ?'); args.push(courseId); }
  const result = await db.execute({
    sql: `${BATCH_SELECT} WHERE ${clauses.join(' AND ')} ORDER BY b.status = 'active' DESC, b.name COLLATE NOCASE LIMIT 500`,
    args,
  });
  return { items: result.rows.map(serializeBatch), nextCursor: null };
}

export async function getBatch({ db, scope, input }) {
  return serializeBatch(await loadBatchRow(db, scope, input.query.batchId));
}

async function assertNameFree(db, scope, name, exceptId = null) {
  const taken = await db.execute({
    sql: `SELECT 1 FROM batches WHERE school_id = ? AND status = 'active' AND lower(name) = lower(?) ${exceptId ? 'AND id != ?' : ''} LIMIT 1`,
    args: exceptId ? [scope.schoolId, name, exceptId] : [scope.schoolId, name],
  });
  if (taken.rows.length) throw new CrmHttpError(409, 'duplicate_name', 'An active batch with this name already exists');
}

/** The course must be this school's and active, unless the batch already has it. */
async function assertCourse(db, scope, courseId, currentCourseId = null) {
  if (!courseId) return null;
  const result = await db.execute({ sql: 'SELECT id, status FROM crm_courses WHERE id = ? AND school_id = ?', args: [courseId, scope.schoolId] });
  const course = result.rows[0];
  if (!course || (course.status !== 'active' && courseId !== currentCourseId)) {
    throw crmErrors.validation([{ path: 'courseId', message: 'Choose one of the school\'s active courses' }]);
  }
  return course;
}

async function yearLabel(db, scope, academicYearId) {
  const result = await db.execute({ sql: 'SELECT label FROM academic_years WHERE id = ? AND school_id = ?', args: [academicYearId, scope.schoolId] });
  return result.rows[0]?.label || null;
}

export async function createBatch({ db, scope, input }) {
  const body = input.body;
  await assertSchoolRefs(db, scope, body);
  await assertCourse(db, scope, body.courseId);
  await assertActiveRoom(db, scope, body.defaultRoomId, 'defaultRoomId');
  await assertNameFree(db, scope, body.name);
  const school = await db.execute({ sql: 'SELECT display_name FROM schools WHERE id = ?', args: [scope.schoolId] });
  const batchId = newId('batch');
  const now = new Date().toISOString();
  const results = await db.batch([
    // Same shape as the teacher roster's batches, guarded against a racing duplicate name.
    {
      sql: `INSERT INTO batches (id, school, school_id, name, grade, board, stream, academic_year, academic_year_id, subject_id, status, created_at, updated_at)
            SELECT ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, 'active', ?, ?
            WHERE NOT EXISTS (SELECT 1 FROM batches WHERE school_id = ? AND status = 'active' AND lower(name) = lower(?))`,
      args: [batchId, school.rows[0]?.display_name || scope.schoolName || '', scope.schoolId, body.name, body.grade,
        await yearLabel(db, scope, body.academicYearId), body.academicYearId, body.subjectId || null, now, now, scope.schoolId, body.name],
    },
    {
      sql: `INSERT INTO crm_batch_settings (batch_id, school_id, course_id, starts_on, ends_on, capacity, default_room_id, default_online_url, updated_by, created_at, updated_at)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() > 0`,
      args: [batchId, scope.schoolId, body.courseId || null, body.startsOn || null, body.endsOn || null, body.capacity || null,
        body.defaultRoomId || null, body.defaultOnlineUrl || null, scope.actor.user_id || null, now, now],
    },
    auditStatement(scope, { action: 'batch.changed', entityId: batchId, summary: { change: 'created', name: body.name, courseId: body.courseId || null }, onlyIfChanged: true, now }),
  ], 'write');
  if (!Number(results[0].rowsAffected)) throw new CrmHttpError(409, 'duplicate_name', 'An active batch with this name already exists');
  return serializeBatch(await loadBatchRow(db, scope, batchId));
}

const BATCH_FIELDS = [
  ['name', 'name'], ['grade', 'grade'], ['academicYearId', 'academic_year_id'], ['subjectId', 'subject_id'], ['courseId', 'course_id'],
  ['startsOn', 'starts_on'], ['endsOn', 'ends_on'], ['capacity', 'capacity'], ['defaultRoomId', 'default_room_id'], ['defaultOnlineUrl', 'default_online_url'],
];

/**
 * The settings row is the batch's version. Version 0 (never edited in the CRM)
 * inserts it; otherwise it must still be at `expectedVersion`. The `batches`
 * update is guarded on the settings write having just happened.
 */
function settingsWrite(scope, batchId, expected, values, now) {
  return expected === 0
    ? {
      sql: `INSERT INTO crm_batch_settings (batch_id, school_id, course_id, starts_on, ends_on, capacity, default_room_id, default_online_url, updated_by, created_at, updated_at)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM crm_batch_settings WHERE batch_id = ?)`,
      args: [batchId, scope.schoolId, ...values, scope.actor.user_id || null, now, now, batchId],
    }
    : {
      sql: `UPDATE crm_batch_settings SET course_id = ?, starts_on = ?, ends_on = ?, capacity = ?, default_room_id = ?, default_online_url = ?,
                   updated_by = ?, version = version + 1, updated_at = ?
            WHERE batch_id = ? AND school_id = ? AND version = ?`,
      args: [...values, scope.actor.user_id || null, now, batchId, scope.schoolId, expected],
    };
}

function settingsGuard(batchId, expected, now) {
  return { sql: 'EXISTS (SELECT 1 FROM crm_batch_settings WHERE batch_id = ? AND version = ? AND updated_at = ?)', args: [batchId, expected + 1, now] };
}

export async function assertActiveBatch(db, scope, batchId) {
  const row = await loadBatchRow(db, scope, batchId);
  if (row.status !== 'active') throw new CrmHttpError(422, 'batch_archived', 'This batch is archived');
  return row;
}

export async function updateBatch({ db, scope, input }) {
  const body = input.body;
  const row = await assertActiveBatch(db, scope, body.batchId);
  await assertSchoolRefs(db, scope, body);
  await assertCourse(db, scope, body.courseId, row.course_id);
  if (body.defaultRoomId && body.defaultRoomId !== row.default_room_id) await assertActiveRoom(db, scope, body.defaultRoomId, 'defaultRoomId');
  if (body.name.toLowerCase() !== String(row.name).toLowerCase()) await assertNameFree(db, scope, body.name, row.id);
  const next = {
    ...body,
    grade: body.grade || null,
    subjectId: body.subjectId || null,
    courseId: body.courseId || null,
    startsOn: body.startsOn || null,
    endsOn: body.endsOn || null,
    capacity: body.capacity || null,
    defaultRoomId: body.defaultRoomId || null,
    defaultOnlineUrl: body.defaultOnlineUrl || null,
  };
  const fields = BATCH_FIELDS.filter(([key, column]) => String(row[column] ?? '') !== String(next[key] ?? '')).map(([key]) => key);
  if (!fields.length) return serializeBatch(row);
  if (Number(row.settings_version || 0) !== body.expectedVersion) throw versionConflict(Number(row.settings_version || 0));

  const now = new Date().toISOString();
  const guard = settingsGuard(row.id, body.expectedVersion, now);
  const results = await db.batch([
    settingsWrite(scope, row.id, body.expectedVersion,
      [next.courseId, next.startsOn, next.endsOn, next.capacity, next.defaultRoomId, next.defaultOnlineUrl], now),
    {
      sql: `UPDATE batches SET name = ?, grade = ?, academic_year = ?, academic_year_id = ?, subject_id = ?, updated_at = ?
            WHERE id = ? AND school_id = ? AND status = 'active' AND ${guard.sql}`,
      args: [next.name, next.grade, await yearLabel(db, scope, next.academicYearId), next.academicYearId, next.subjectId, now, row.id, scope.schoolId, ...guard.args],
    },
    auditStatement(scope, { action: 'batch.changed', entityId: row.id, summary: { change: 'updated', name: next.name, fields, courseId: next.courseId }, when: guard, now }),
  ], 'write');
  if (!Number(results[0].rowsAffected)) throw versionConflict(Number((await loadBatchRow(db, scope, row.id)).settings_version || 0));
  return serializeBatch(await loadBatchRow(db, scope, row.id));
}

/** Link or unlink a course without touching anything else (Courses tab). */
export async function setBatchCourse({ db, scope, input }) {
  const { batchId, courseId, expectedVersion } = input.body;
  const row = await assertActiveBatch(db, scope, batchId);
  if ((row.course_id || null) === courseId) return serializeBatch(row);
  await assertCourse(db, scope, courseId);
  const now = new Date().toISOString();
  const write = expectedVersion === 0
    ? {
      sql: `INSERT INTO crm_batch_settings (batch_id, school_id, course_id, updated_by, created_at, updated_at)
            SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM crm_batch_settings WHERE batch_id = ?)`,
      args: [row.id, scope.schoolId, courseId, scope.actor.user_id || null, now, now, row.id],
    }
    : {
      sql: `UPDATE crm_batch_settings SET course_id = ?, updated_by = ?, version = version + 1, updated_at = ?
            WHERE batch_id = ? AND school_id = ? AND version = ?`,
      args: [courseId, scope.actor.user_id || null, now, row.id, scope.schoolId, expectedVersion],
    };
  const results = await db.batch([
    write,
    auditStatement(scope, { action: 'batch.changed', entityId: row.id, summary: { change: 'course_linked', name: row.name, courseId }, onlyIfChanged: true, now }),
  ], 'write');
  if (!Number(results[0].rowsAffected)) throw versionConflict(Number(row.settings_version || 0));
  return serializeBatch(await loadBatchRow(db, scope, row.id));
}

/**
 * Same rule as the teacher roster: no archiving while students are active in
 * it. Future scheduled classes are cancelled ("Batch archived") and its
 * timetables end, but only after the caller confirmed the count (D12).
 */
export async function archiveBatch({ db, scope, input }) {
  const row = await assertActiveBatch(db, scope, input.body.batchId);
  if (Number(row.student_count) > 0) {
    throw new CrmHttpError(409, 'batch_has_students', 'Remove or move this batch\'s students before archiving it', { studentCount: Number(row.student_count) });
  }
  const now = new Date().toISOString();
  const future = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM crm_class_sessions WHERE school_id = ? AND batch_id = ? AND status = 'scheduled' AND starts_at > ?",
    args: [scope.schoolId, row.id, now],
  });
  const futureCount = Number(future.rows[0].n);
  if (futureCount && !input.body.cancelFutureSessions) {
    throw new CrmHttpError(409, 'has_future_sessions', `Archiving cancels ${futureCount} future class${futureCount === 1 ? '' : 'es'}`, { sessionCount: futureCount });
  }
  const guard = { sql: "EXISTS (SELECT 1 FROM batches WHERE id = ? AND status = 'archived' AND updated_at = ?)", args: [row.id, now] };
  const results = await db.batch([
    {
      sql: `UPDATE batches SET status = 'archived', updated_at = ?
            WHERE id = ? AND school_id = ? AND status = 'active'
              AND NOT EXISTS (SELECT 1 FROM batch_memberships WHERE batch_id = ? AND status = 'active')`,
      args: [now, row.id, scope.schoolId, row.id],
    },
    {
      sql: `UPDATE crm_class_sessions SET status = 'cancelled', cancel_reason = 'Batch archived', cancelled_by = ?, cancelled_at = ?, version = version + 1, updated_at = ?
            WHERE school_id = ? AND batch_id = ? AND status = 'scheduled' AND starts_at > ? AND ${guard.sql}`,
      args: [scope.actor.user_id || null, now, now, scope.schoolId, row.id, now, ...guard.args],
    },
    {
      sql: `UPDATE crm_timetable_rules SET status = 'ended', version = version + 1, updated_at = ?
            WHERE school_id = ? AND batch_id = ? AND status = 'active' AND ${guard.sql}`,
      args: [now, scope.schoolId, row.id, ...guard.args],
    },
    auditStatement(scope, { action: 'batch.changed', entityId: row.id, summary: { change: 'archived', name: row.name, cancelledSessions: futureCount }, when: guard, now }),
  ], 'write');
  if (!Number(results[0].rowsAffected)) throw new CrmHttpError(409, 'batch_has_students', 'Students joined this batch meanwhile. Reload and try again.');
  return { ...serializeBatch(await loadBatchRow(db, scope, row.id)), cancelledSessions: Number(results[1].rowsAffected) };
}

export async function listBatchStudents({ db, scope, input }) {
  const { batchId, view } = input.query;
  await loadBatchRow(db, scope, batchId);
  const result = await db.execute({
    sql: `SELECT m.id AS membership_id, m.status, m.joined_at, m.left_at, st.id AS student_id, st.display_name, st.status AS student_status
          FROM batch_memberships m
          JOIN students st ON st.id = m.student_id AND st.school_id = ? AND st.status != 'archived'
          WHERE m.batch_id = ? AND m.status ${view === 'current' ? "= 'active'" : "!= 'active'"}
          ORDER BY ${view === 'current' ? 'st.display_name COLLATE NOCASE' : 'm.left_at DESC'} LIMIT 1000`,
    args: [scope.schoolId, batchId],
  });
  return {
    items: result.rows.map((row) => ({
      membershipId: row.membership_id,
      studentId: row.student_id,
      name: row.display_name,
      studentStatus: row.student_status,
      joinedAt: row.joined_at || null,
      leftAt: row.left_at || null,
    })),
    nextCursor: null,
  };
}

/**
 * Adds students to the canonical roster. Already-active members are skipped.
 * When the batch has a year and a class, a missing enrollment for that year is
 * created with that class, as conversion does; an existing one is kept.
 */
export async function addBatchStudents({ db, scope, input }) {
  // Choosing students means seeing the roster.
  if (!can(scope, 'crm.students.read')) throw crmErrors.forbidden();
  const { batchId } = input.body;
  const studentIds = [...new Set(input.body.studentIds)];
  const batch = await assertActiveBatch(db, scope, batchId);
  const placeholders = studentIds.map(() => '?').join(', ');
  const [students, active, enrolled] = await Promise.all([
    db.execute({ sql: `SELECT id FROM students WHERE school_id = ? AND status = 'active' AND id IN (${placeholders})`, args: [scope.schoolId, ...studentIds] }),
    db.execute({ sql: `SELECT student_id FROM batch_memberships WHERE batch_id = ? AND status = 'active' AND student_id IN (${placeholders})`, args: [batchId, ...studentIds] }),
    batch.academic_year_id
      ? db.execute({ sql: `SELECT student_id FROM student_enrollments WHERE academic_year_id = ? AND student_id IN (${placeholders})`, args: [batch.academic_year_id, ...studentIds] })
      : { rows: [] },
  ]);
  const found = new Set(students.rows.map((row) => row.id));
  const missing = studentIds.filter((value) => !found.has(value));
  if (missing.length) throw crmErrors.validation(missing.map((value) => ({ path: 'studentIds', message: `Not an active student of this school: ${value}` })));

  const already = new Set(active.rows.map((row) => row.student_id));
  const hasEnrollment = new Set(enrolled.rows.map((row) => row.student_id));
  const toAdd = studentIds.filter((value) => !already.has(value));
  const canEnroll = Boolean(batch.academic_year_id && batch.grade);
  const now = new Date().toISOString();
  const statements = [];
  for (const studentId of toAdd) {
    const membershipId = newId('membership');
    const enrollmentCreated = canEnroll && !hasEnrollment.has(studentId);
    statements.push(
      {
        sql: `INSERT INTO batch_memberships (id, batch_id, student_id, status, joined_at, left_at, created_at, updated_at)
              SELECT ?, ?, ?, 'active', ?, NULL, ?, ?
              WHERE NOT EXISTS (SELECT 1 FROM batch_memberships WHERE batch_id = ? AND student_id = ? AND status = 'active')`,
        args: [membershipId, batchId, studentId, now, now, now, batchId, studentId],
      },
      auditStatement(scope, {
        action: 'membership.changed', entityId: studentId,
        summary: { change: 'joined', batchId, membershipId, ...(enrollmentCreated ? { enrollmentCreated: true } : {}) },
        onlyIfChanged: true, now,
      }),
    );
    if (enrollmentCreated) {
      statements.push({
        sql: `INSERT INTO student_enrollments (id, student_id, academic_year_id, standard, status, created_at, updated_at)
              SELECT ?, ?, ?, ?, 'active', ?, ?
              WHERE NOT EXISTS (SELECT 1 FROM student_enrollments WHERE student_id = ? AND academic_year_id = ?)`,
        args: [newId('enrollment'), studentId, batch.academic_year_id, batch.grade, now, now, studentId, batch.academic_year_id],
      });
    }
  }
  if (statements.length) await db.batch(statements, 'write');
  const updated = await loadBatchRow(db, scope, batchId);
  const capacity = updated.capacity ? Number(updated.capacity) : null;
  return {
    added: toAdd.length,
    alreadyInBatch: studentIds.length - toAdd.length,
    batch: serializeBatch(updated),
    // Capacity is advice only (D7): seat limits and waitlists are CRM-029.
    overCapacity: capacity !== null && Number(updated.student_count) > capacity,
  };
}

/** Ends a membership (`left_at`); rows are never deleted, so past attendance keeps its roster. */
export async function removeBatchStudent({ db, scope, input }) {
  const { batchId, membershipId } = input.body;
  await loadBatchRow(db, scope, batchId);
  const found = await db.execute({
    sql: `SELECT m.id, m.student_id, m.status FROM batch_memberships m
          JOIN students st ON st.id = m.student_id AND st.school_id = ?
          WHERE m.id = ? AND m.batch_id = ?`,
    args: [scope.schoolId, membershipId, batchId],
  });
  const membership = found.rows[0];
  if (!membership) throw crmErrors.notFound();
  const now = new Date().toISOString();
  const results = await db.batch([
    {
      sql: "UPDATE batch_memberships SET status = 'inactive', left_at = ?, updated_at = ? WHERE id = ? AND batch_id = ? AND status = 'active'",
      args: [now, now, membershipId, batchId],
    },
    auditStatement(scope, { action: 'membership.changed', entityId: membership.student_id, summary: { change: 'left', batchId, membershipId }, onlyIfChanged: true, now }),
  ], 'write');
  if (!Number(results[0].rowsAffected)) throw new CrmHttpError(409, 'already_removed', 'This student has already left the batch');
  return { removed: true, batch: serializeBatch(await loadBatchRow(db, scope, batchId)) };
}

/** Pickers for the class forms: years, subjects, active rooms and courses, program labels. */
export async function classesOptions({ db, scope }) {
  const [years, subjects, rooms, courses] = await Promise.all([
    db.execute({ sql: 'SELECT id, label, starts_on, ends_on, is_current FROM academic_years WHERE school_id = ? ORDER BY is_current DESC, starts_on DESC, label DESC', args: [scope.schoolId] }),
    db.execute({ sql: "SELECT id, name FROM subjects WHERE school_id = ? AND (status IS NULL OR status = 'active') ORDER BY name COLLATE NOCASE", args: [scope.schoolId] }),
    db.execute({ sql: "SELECT * FROM crm_rooms WHERE school_id = ? AND status = 'active' ORDER BY name COLLATE NOCASE", args: [scope.schoolId] }),
    db.execute({
      sql: `SELECT id, name, program, subject_id, level, duration_value, duration_unit, delivery_mode, academic_year_id
            FROM crm_courses WHERE school_id = ? AND status = 'active' ORDER BY name COLLATE NOCASE`,
      args: [scope.schoolId],
    }),
  ]);
  return {
    academicYears: years.rows.map((row) => ({ id: row.id, label: row.label, startsOn: row.starts_on || null, endsOn: row.ends_on || null, isCurrent: Number(row.is_current) === 1 })),
    subjects: subjects.rows.map((row) => ({ id: row.id, name: row.name })),
    rooms: rooms.rows.map(serializeRoom),
    courses: courses.rows.map((row) => ({
      id: row.id, name: row.name, program: row.program || null, subjectId: row.subject_id || null, level: row.level || null,
      duration: row.duration_value ? { value: Number(row.duration_value), unit: row.duration_unit } : null,
      deliveryMode: row.delivery_mode, academicYearId: row.academic_year_id || null,
    })),
    programs: [...new Set(courses.rows.map((row) => row.program).filter(Boolean))].sort(),
  };
}
