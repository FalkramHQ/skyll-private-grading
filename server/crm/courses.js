// Courses (CRM-013, FLKRM-327 S1, D1/D13): the school's catalogue. A course
// is what the institute sells; the canonical `batches` are its runs. Linking
// is optional and lives in `crm_batch_settings.course_id`.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { courseBody, nameKey, updateCourseBody } from '../../shared/crm/classes.js';
import { auditStatement } from './audit.js';
import { assertVersionedWrite, expectedVersion } from './concurrency.js';
import { CrmHttpError, crmErrors } from './errors.js';

export { courseBody as createCourseBody, updateCourseBody };

export const listCoursesQuery = z.object({ status: z.enum(['active', 'archived', 'all']).default('active') });
export const courseStatusBody = z.object({ courseId: z.string().trim().min(1).max(128), expectedVersion }).strict();

const COURSE_SELECT = `
  SELECT c.*, sj.name AS subject_name, ay.label AS academic_year_label
  FROM crm_courses c
  LEFT JOIN subjects sj ON sj.id = c.subject_id AND sj.school_id = c.school_id
  LEFT JOIN academic_years ay ON ay.id = c.academic_year_id AND ay.school_id = c.school_id`;

function serializeCourse(row, batches = []) {
  return {
    id: row.id,
    name: row.name,
    program: row.program || null,
    subject: row.subject_id ? { id: row.subject_id, name: row.subject_name || null } : null,
    level: row.level || null,
    duration: row.duration_value ? { value: Number(row.duration_value), unit: row.duration_unit } : null,
    deliveryMode: row.delivery_mode,
    academicYear: row.academic_year_id ? { id: row.academic_year_id, label: row.academic_year_label || null } : null,
    description: row.description || null,
    status: row.status,
    version: Number(row.version),
    batches,
  };
}

async function linkedBatches(db, scope, courseIds) {
  if (!courseIds.length) return {};
  const result = await db.execute({
    sql: `SELECT s.course_id, b.id, b.name, b.status,
                 (SELECT COUNT(*) FROM batch_memberships m WHERE m.batch_id = b.id AND m.status = 'active') AS student_count
          FROM crm_batch_settings s JOIN batches b ON b.id = s.batch_id AND b.school_id = s.school_id
          WHERE s.school_id = ? AND s.course_id IN (${courseIds.map(() => '?').join(', ')})
          ORDER BY b.status = 'active' DESC, b.name`,
    args: [scope.schoolId, ...courseIds],
  });
  const byCourse = {};
  for (const row of result.rows) {
    (byCourse[row.course_id] ||= []).push({ id: row.id, name: row.name, status: row.status, studentCount: Number(row.student_count) });
  }
  return byCourse;
}

export async function loadCourseRow(db, scope, id) {
  const result = await db.execute({ sql: `${COURSE_SELECT} WHERE c.id = ? AND c.school_id = ?`, args: [id, scope.schoolId] });
  if (!result.rows[0]) throw crmErrors.notFound();
  return result.rows[0];
}

async function loadCourse(db, scope, id) {
  const row = await loadCourseRow(db, scope, id);
  return serializeCourse(row, (await linkedBatches(db, scope, [id]))[id] || []);
}

export async function listCourses({ db, scope, input }) {
  const { status } = input.query;
  const result = await db.execute({
    sql: `${COURSE_SELECT} WHERE c.school_id = ? ${status === 'all' ? '' : 'AND c.status = ?'} ORDER BY c.status = 'active' DESC, c.name COLLATE NOCASE`,
    args: status === 'all' ? [scope.schoolId] : [scope.schoolId, status],
  });
  const batches = await linkedBatches(db, scope, result.rows.map((row) => row.id));
  return { items: result.rows.map((row) => serializeCourse(row, batches[row.id] || [])), nextCursor: null };
}

/** 422 unless each referenced subject / academic year belongs to this school. */
export async function assertSchoolRefs(db, scope, { subjectId, academicYearId }) {
  const errors = [];
  if (subjectId) {
    const found = await db.execute({ sql: 'SELECT 1 FROM subjects WHERE id = ? AND school_id = ?', args: [subjectId, scope.schoolId] });
    if (!found.rows.length) errors.push({ path: 'subjectId', message: 'Choose one of the school\'s subjects' });
  }
  if (academicYearId) {
    const found = await db.execute({ sql: 'SELECT 1 FROM academic_years WHERE id = ? AND school_id = ?', args: [academicYearId, scope.schoolId] });
    if (!found.rows.length) errors.push({ path: 'academicYearId', message: 'Choose one of the school\'s academic years' });
  }
  if (errors.length) throw crmErrors.validation(errors);
}

export function duplicateName(error, message) {
  if (/UNIQUE constraint failed/i.test(String(error?.message || error?.cause?.message || ''))) {
    return new CrmHttpError(409, 'duplicate_name', message);
  }
  return error;
}

function courseValues(body) {
  return [
    body.name, nameKey(body.name), body.program, body.subjectId || null, body.level,
    body.durationValue || null, body.durationValue ? body.durationUnit : null, body.deliveryMode,
    body.academicYearId || null, body.description,
  ];
}

const COURSE_NAME_TAKEN = 'A course with this name already exists (it may be archived)';

export async function createCourse({ db, scope, input }) {
  const body = input.body;
  await assertSchoolRefs(db, scope, body);
  const id = `course_${randomUUID()}`;
  const now = new Date().toISOString();
  try {
    await db.batch([
      {
        sql: `INSERT INTO crm_courses (id, school_id, name, name_key, program, subject_id, level, duration_value, duration_unit,
                                       delivery_mode, academic_year_id, description, created_by, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [id, scope.schoolId, ...courseValues(body), scope.actor.user_id || null, now, now],
      },
      auditStatement(scope, { action: 'course.changed', entityId: id, summary: { change: 'created', name: body.name }, now }),
    ], 'write');
  } catch (error) {
    throw duplicateName(error, COURSE_NAME_TAKEN);
  }
  return loadCourse(db, scope, id);
}

const COURSE_FIELDS = [
  ['name', 'name'], ['program', 'program'], ['subjectId', 'subject_id'], ['level', 'level'], ['durationValue', 'duration_value'],
  ['durationUnit', 'duration_unit'], ['deliveryMode', 'delivery_mode'], ['academicYearId', 'academic_year_id'], ['description', 'description'],
];

export async function updateCourse({ db, scope, input }) {
  const body = input.body;
  const row = await loadCourseRow(db, scope, body.courseId);
  await assertSchoolRefs(db, scope, body);
  const next = { ...body, subjectId: body.subjectId || null, academicYearId: body.academicYearId || null, durationValue: body.durationValue || null };
  next.durationUnit = next.durationValue ? body.durationUnit : null;
  const fields = COURSE_FIELDS.filter(([key, column]) => String(row[column] ?? '') !== String(next[key] ?? '')).map(([key]) => key);
  if (!fields.length) return serializeCourse(row, (await linkedBatches(db, scope, [row.id]))[row.id] || []);
  const now = new Date().toISOString();
  let results;
  try {
    results = await db.batch([
      {
        sql: `UPDATE crm_courses SET name = ?, name_key = ?, program = ?, subject_id = ?, level = ?, duration_value = ?, duration_unit = ?,
                     delivery_mode = ?, academic_year_id = ?, description = ?, version = version + 1, updated_at = ?
              WHERE id = ? AND school_id = ? AND version = ?`,
        args: [...courseValues(next), now, row.id, scope.schoolId, body.expectedVersion],
      },
      auditStatement(scope, { action: 'course.changed', entityId: row.id, summary: { change: 'updated', name: body.name, fields }, onlyIfChanged: true, now }),
    ], 'write');
  } catch (error) {
    throw duplicateName(error, COURSE_NAME_TAKEN);
  }
  await assertVersionedWrite(results, 0, async () => (await loadCourseRow(db, scope, row.id)).version);
  return loadCourse(db, scope, row.id);
}

function statusHandler(to, change) {
  return async ({ db, scope, input }) => {
    const row = await loadCourseRow(db, scope, input.body.courseId);
    if (row.status === to) throw new CrmHttpError(422, 'invalid_transition', to === 'archived' ? 'This course is already archived' : 'This course is already active');
    const now = new Date().toISOString();
    const results = await db.batch([
      {
        sql: 'UPDATE crm_courses SET status = ?, version = version + 1, updated_at = ? WHERE id = ? AND school_id = ? AND version = ?',
        args: [to, now, row.id, scope.schoolId, input.body.expectedVersion],
      },
      auditStatement(scope, { action: 'course.changed', entityId: row.id, summary: { change, name: row.name }, onlyIfChanged: true, now }),
    ], 'write');
    await assertVersionedWrite(results, 0, async () => (await loadCourseRow(db, scope, row.id)).version);
    return loadCourse(db, scope, row.id);
  };
}

// Archiving hides the course from new links only; its batches are untouched (D12).
export const archiveCourse = statusHandler('archived', 'archived');
export const restoreCourse = statusHandler('active', 'restored');
