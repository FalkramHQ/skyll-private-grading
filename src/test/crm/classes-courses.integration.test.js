// Courses, batches and rooms on real SQLite (FLKRM-327 S1): the CRM writes the
// canonical `batches` / `batch_memberships` rows, so intake test creation must
// keep working on them unchanged.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import {
  BASE_SCHEMA, CLASSES_MIGRATIONS, CRM_MIGRATIONS, SEED, actors, auditRows, count, grant, makeCaller, migrationStatements,
} from './classesHarness.js';

const state = vi.hoisted(() => ({ db: null, user: null }));
const auth = vi.hoisted(() => ({
  database: vi.fn(() => state.db),
  sessionForRequest: vi.fn(),
  ensureAuthTables: vi.fn(async () => undefined),
  requireUser: vi.fn(async () => state.user),
}));
const flags = vi.hoisted(() => ({ isSchoolFeatureEnabled: vi.fn(async () => true) }));
vi.mock('../../../api/_lib/auth.js', () => auth);
vi.mock('../../../api/_lib/featureFlags.js', () => flags);
// Intake test creation, for the regression check (its own tables are created below).
vi.mock('../../../api/_lib/intake.js', () => ({ ensureIntakeTables: vi.fn(async () => undefined), id: (prefix) => `${prefix}_${randomUUID()}` }));
vi.mock('../../../api/_lib/storage.js', () => ({ deleteObject: vi.fn() }));
vi.mock('../../../api/_lib/exams.js', () => ({
  canonicalExamStatements: vi.fn(() => []), canonicalExamBatchSync: vi.fn(() => []), canonicalExamDeleteStatements: vi.fn(() => []),
  currentAcademicYearId: vi.fn(async () => null), ensureSubjectId: vi.fn(async () => 'sub_math'), examRowId: vi.fn(() => 'exam_x'),
}));

const { handleCrmRequest } = await import('../../../server/crm/router.js');
const { default: intakeTests } = await import('../../../server/intake/tests.js');
const call = makeCaller(auth, handleCrmRequest);
const { admin, otherAdmin, teacher, staff } = actors;
let dir;

beforeAll(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'crm-classes-')); });
afterAll(async () => { state.db?.close(); await rm(dir, { recursive: true, force: true }); });

beforeEach(async () => {
  state.db?.close();
  state.db = createClient({ url: `file:${path.join(dir, `${Date.now()}-${Math.random()}.db`)}` });
  await state.db.batch([
    ...BASE_SCHEMA,
    'CREATE TABLE tests (id TEXT PRIMARY KEY, school TEXT, title TEXT, subject TEXT, grade TEXT, status TEXT, created_by TEXT, created_at TEXT, updated_at TEXT)',
    'CREATE TABLE test_batches (test_id TEXT, batch_id TEXT, created_at TEXT, PRIMARY KEY (test_id, batch_id))',
    'CREATE TABLE test_students (id TEXT PRIMARY KEY, test_id TEXT, student_id TEXT, student_name TEXT, batch_id TEXT, status TEXT, expected_page_count INTEGER, created_at TEXT)',
    ...migrationStatements([...CRM_MIGRATIONS, ...CLASSES_MIGRATIONS]),
    ...SEED,
  ], 'write');
});

const newCourse = (body = {}, actor = admin) => call(actor, 'POST', 'classes/courses', {
  body: { name: 'Grade 10 Maths tuition', program: 'Board prep', subjectId: 'sub_math', level: 'Grade 10', durationValue: 10, durationUnit: 'months', deliveryMode: 'classroom', ...body },
});
const newBatch = (body = {}, actor = admin) => call(actor, 'POST', 'classes/batches', {
  body: { name: 'Grade 10 Maths Evening', academicYearId: 'ay_26', grade: '10', subjectId: 'sub_math', startsOn: '2026-06-15', endsOn: '2027-03-14', capacity: 30, ...body },
});

describe('CRM courses (S1)', () => {
  it('creates, edits, archives and restores a course with audit and version checks', async () => {
    const created = await newCourse();
    expect(created.statusCode).toBe(201);
    expect(created.body).toMatchObject({
      name: 'Grade 10 Maths tuition', program: 'Board prep', subject: { id: 'sub_math', name: 'Mathematics' }, level: 'Grade 10',
      duration: { value: 10, unit: 'months' }, deliveryMode: 'classroom', status: 'active', version: 1, batches: [],
    });

    const edited = await call(admin, 'POST', 'classes/courses/update', {
      body: { courseId: created.body.id, expectedVersion: 1, name: 'Grade 10 Maths', subjectId: 'sub_math', level: 'Grade 10', deliveryMode: 'hybrid' },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.body).toMatchObject({ name: 'Grade 10 Maths', deliveryMode: 'hybrid', program: null, duration: null, version: 2 });
    const stale = await call(admin, 'POST', 'classes/courses/update', { body: { courseId: created.body.id, expectedVersion: 1, name: 'Late', deliveryMode: 'online' } });
    expect(stale.statusCode).toBe(409);

    const archived = await call(admin, 'POST', 'classes/courses/archive', { body: { courseId: created.body.id, expectedVersion: 2 } });
    expect(archived.body.status).toBe('archived');
    expect((await call(admin, 'GET', 'classes/courses')).body.items).toEqual([]);
    expect((await call(admin, 'GET', 'classes/courses', { query: { status: 'archived' } })).body.items).toHaveLength(1);
    expect((await call(admin, 'POST', 'classes/courses/restore', { body: { courseId: created.body.id, expectedVersion: 3 } })).body.status).toBe('active');

    const audit = await auditRows(state.db, 'course.changed');
    expect(audit.map((row) => row.summary.change)).toEqual(['created', 'updated', 'archived', 'restored']);
    expect(audit[1].summary.fields).toEqual(['name', 'program', 'durationValue', 'durationUnit', 'deliveryMode']);
  });

  it('refuses duplicate names (case-insensitive), half a duration, and another school\'s subject or year', async () => {
    await newCourse();
    expect((await newCourse({ name: '  grade 10 MATHS   tuition ' })).body.error.code).toBe('duplicate_name');
    expect((await newCourse({ name: 'X', durationUnit: null })).statusCode).toBe(422);
    expect((await newCourse({ name: 'Y', subjectId: 'sub_b' })).body.error.details[0].path).toBe('subjectId');
    expect((await newCourse({ name: 'Z', academicYearId: 'ay_b' })).body.error.details[0].path).toBe('academicYearId');
    // The same name is fine in another school.
    expect((await newCourse({ subjectId: 'sub_b' }, otherAdmin)).statusCode).toBe(201);
  });

  it('lets teachers read but not change courses; staff need a grant; other schools see nothing', async () => {
    const course = (await newCourse()).body;
    expect((await call(teacher, 'GET', 'classes/courses')).body.items).toHaveLength(1);
    expect((await newCourse({ name: 'Teacher course' }, teacher)).statusCode).toBe(403);
    expect((await call(staff, 'GET', 'classes/courses')).statusCode).toBe(403);
    await grant(state.db, 'usr_staff', ['crm.access', 'crm.classes.read']);
    expect((await call(staff, 'GET', 'classes/courses')).statusCode).toBe(200);
    expect((await call(otherAdmin, 'GET', 'classes/courses')).body.items).toEqual([]);
    expect((await call(otherAdmin, 'POST', 'classes/courses/archive', { body: { courseId: course.id, expectedVersion: 1 } })).statusCode).toBe(404);
  });
});

describe('CRM batches (S1)', () => {
  it('creates a canonical batch with CRM settings, linked to a course', async () => {
    const course = (await newCourse()).body;
    const room = (await call(admin, 'POST', 'classes/rooms', { body: { name: 'Room 2', seats: 30 } })).body;
    const created = await newBatch({ courseId: course.id, defaultRoomId: room.id });
    expect(created.statusCode).toBe(201);
    expect(created.body).toMatchObject({
      name: 'Grade 10 Maths Evening', grade: '10', status: 'active', academicYear: { id: 'ay_26', label: '2026-27' },
      subject: { id: 'sub_math' }, course: { id: course.id }, startsOn: '2026-06-15', endsOn: '2027-03-14', capacity: 30,
      defaultRoom: { id: room.id, name: 'Room 2', seats: 30 }, studentCount: 0, version: 1,
    });
    const row = (await state.db.execute({ sql: 'SELECT * FROM batches WHERE id = ?', args: [created.body.id] })).rows[0];
    expect(row).toMatchObject({ school: 'School A', school_id: 'sch_a', academic_year: '2026-27', academic_year_id: 'ay_26', subject_id: 'sub_math', status: 'active' });
    expect((await call(admin, 'GET', 'classes/courses')).body.items[0].batches.map((batch) => batch.name)).toEqual(['Grade 10 Maths Evening']);
    expect((await auditRows(state.db, 'batch.changed'))[0].summary).toMatchObject({ change: 'created', courseId: course.id });
  });

  it('keeps active batch names unique per school and validates dates, rooms and courses', async () => {
    expect((await newBatch({ name: 'grade 10 maths' })).body.error.code).toBe('duplicate_name');
    expect((await newBatch({ startsOn: '2026-07-01', endsOn: '2026-06-01' })).body.error.details[0].path).toBe('endsOn');
    expect((await newBatch({ academicYearId: '' })).body.error.details[0].path).toBe('academicYearId');
    expect((await newBatch({ defaultRoomId: 'room_missing' })).body.error.details[0].path).toBe('defaultRoomId');
    const archivedCourse = (await newCourse()).body;
    await call(admin, 'POST', 'classes/courses/archive', { body: { courseId: archivedCourse.id, expectedVersion: 1 } });
    expect((await newBatch({ courseId: archivedCourse.id })).body.error.details[0].path).toBe('courseId');
    expect((await newBatch({ academicYearId: 'ay_b' })).statusCode).toBe(422);
  });

  it('edits an existing roster batch (settings version 0) and then guards on its version', async () => {
    const before = (await call(admin, 'GET', 'classes/batches/detail', { query: { batchId: 'b_math10' } })).body;
    expect(before).toMatchObject({ version: 0, course: null, studentCount: 2 });
    const body = { batchId: 'b_math10', name: 'Grade 10 Maths A', academicYearId: 'ay_26', grade: '10', subjectId: 'sub_math', capacity: 25 };
    const first = await call(admin, 'POST', 'classes/batches/update', { body: { ...body, expectedVersion: 0 } });
    expect(first.statusCode).toBe(200);
    expect(first.body).toMatchObject({ name: 'Grade 10 Maths A', capacity: 25, version: 1 });
    expect((await call(admin, 'POST', 'classes/batches/update', { body: { ...body, capacity: 20, expectedVersion: 0 } })).statusCode).toBe(409);
    const second = await call(admin, 'POST', 'classes/batches/update', { body: { ...body, capacity: 20, expectedVersion: 1 } });
    expect(second.body).toMatchObject({ capacity: 20, version: 2 });
    expect((await auditRows(state.db, 'batch.changed')).map((row) => row.summary.fields)).toEqual([['name', 'capacity'], ['capacity']]);
    // Renaming onto another active batch's name is refused.
    expect((await call(admin, 'POST', 'classes/batches/update', { body: { ...body, name: 'GRADE 9 SCIENCE', expectedVersion: 2 } })).body.error.code).toBe('duplicate_name');
  });

  it('links and unlinks a course from the Courses tab', async () => {
    const course = (await newCourse()).body;
    const linked = await call(admin, 'POST', 'classes/batches/course', { body: { batchId: 'b_sci9', courseId: course.id, expectedVersion: 0 } });
    expect(linked.body).toMatchObject({ course: { id: course.id }, version: 1 });
    const filtered = await call(admin, 'GET', 'classes/batches', { query: { courseId: course.id } });
    expect(filtered.body.items.map((batch) => batch.id)).toEqual(['b_sci9']);
    const unlinked = await call(admin, 'POST', 'classes/batches/course', { body: { batchId: 'b_sci9', courseId: null, expectedVersion: 1 } });
    expect(unlinked.body.course).toBeNull();
  });

  it('archives only empty batches, and never another school\'s', async () => {
    const refused = await call(admin, 'POST', 'classes/batches/archive', { body: { batchId: 'b_math10' } });
    expect(refused.statusCode).toBe(409);
    expect(refused.body.error).toMatchObject({ code: 'batch_has_students', details: { studentCount: 2 } });
    expect((await call(admin, 'POST', 'classes/batches/archive', { body: { batchId: 'b_sci9' } })).body.status).toBe('archived');
    expect((await call(admin, 'GET', 'classes/batches')).body.items.map((batch) => batch.id)).toEqual(['b_math10']);
    expect((await call(admin, 'POST', 'classes/batches/archive', { body: { batchId: 'b_other' } })).statusCode).toBe(404);
    expect((await call(otherAdmin, 'GET', 'classes/batches/detail', { query: { batchId: 'b_math10' } })).statusCode).toBe(404);
  });
});

describe('CRM batch students (S1)', () => {
  it('adds students with a join date and the year\'s enrollment, skipping current members', async () => {
    const added = await call(admin, 'POST', 'classes/batches/students/add', { body: { batchId: 'b_math10', studentIds: ['stu_2', 'stu_3'] } });
    expect(added.statusCode).toBe(200);
    expect(added.body).toMatchObject({ added: 1, alreadyInBatch: 1, overCapacity: false, batch: { studentCount: 3 } });
    const membership = (await state.db.execute("SELECT * FROM batch_memberships WHERE student_id = 'stu_3'")).rows[0];
    expect(membership).toMatchObject({ batch_id: 'b_math10', status: 'active', left_at: null });
    expect(membership.joined_at).toBeTruthy();
    // stu_3 had no 2026-27 enrollment: created with the batch's class. stu_1's existing one is untouched.
    expect((await state.db.execute("SELECT standard FROM student_enrollments WHERE student_id = 'stu_3' AND academic_year_id = 'ay_26'")).rows[0].standard).toBe('10');
    const audit = await auditRows(state.db, 'membership.changed');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ entity_type: 'student', entity_id: 'stu_3', summary: { change: 'joined', batchId: 'b_math10', enrollmentCreated: true } });
  });

  it('refuses inactive, unknown and other-school students as a whole; needs students read', async () => {
    const refused = await call(admin, 'POST', 'classes/batches/students/add', { body: { batchId: 'b_math10', studentIds: ['stu_3', 'stu_4', 'stu_b1'] } });
    expect(refused.statusCode).toBe(422);
    expect(refused.body.error.details).toHaveLength(2);
    expect(await count(state.db, "SELECT COUNT(*) AS n FROM batch_memberships WHERE student_id = 'stu_3'")).toBe(0);
    expect((await call(admin, 'POST', 'classes/batches/students/add', { body: { batchId: 'b_other', studentIds: ['stu_3'] } })).statusCode).toBe(404);
    await grant(state.db, 'usr_staff', ['crm.access', 'crm.classes.read', 'crm.classes.write']);
    expect((await call(staff, 'POST', 'classes/batches/students/add', { body: { batchId: 'b_math10', studentIds: ['stu_3'] } })).statusCode).toBe(403);
    expect((await call(teacher, 'POST', 'classes/batches/students/add', { body: { batchId: 'b_math10', studentIds: ['stu_3'] } })).statusCode).toBe(403);
  });

  it('removes a student by ending the membership, keeping the row', async () => {
    const removed = await call(admin, 'POST', 'classes/batches/students/remove', { body: { batchId: 'b_math10', membershipId: 'bm_2' } });
    expect(removed.body).toMatchObject({ removed: true, batch: { studentCount: 1 } });
    const row = (await state.db.execute("SELECT status, left_at FROM batch_memberships WHERE id = 'bm_2'")).rows[0];
    expect(row.status).toBe('inactive');
    expect(row.left_at).toBeTruthy();
    expect((await call(admin, 'POST', 'classes/batches/students/remove', { body: { batchId: 'b_math10', membershipId: 'bm_2' } })).body.error.code).toBe('already_removed');
    const current = await call(teacher, 'GET', 'classes/batches/students', { query: { batchId: 'b_math10' } });
    expect(current.body.items.map((item) => item.name)).toEqual(['Anaya Iyer']);
    const past = await call(teacher, 'GET', 'classes/batches/students', { query: { batchId: 'b_math10', view: 'past' } });
    expect(past.body.items.map((item) => item.name)).toEqual(['Arjun Sharma']);
    expect((await auditRows(state.db, 'membership.changed'))[0]).toMatchObject({ entity_id: 'stu_2', summary: { change: 'left', membershipId: 'bm_2' } });
  });

  it('flags (but allows) going over capacity', async () => {
    await call(admin, 'POST', 'classes/batches/update', { body: { batchId: 'b_math10', name: 'Grade 10 Maths', academicYearId: 'ay_26', grade: '10', subjectId: 'sub_math', capacity: 2, expectedVersion: 0 } });
    const added = await call(admin, 'POST', 'classes/batches/students/add', { body: { batchId: 'b_math10', studentIds: ['stu_3'] } });
    expect(added.body).toMatchObject({ added: 1, overCapacity: true });
  });
});

describe('Assessment regression (S1): intake test creation on CRM batches', () => {
  it('creates a test from a CRM-created batch with exactly its current students', async () => {
    const batch = (await newBatch()).body;
    await call(admin, 'POST', 'classes/batches/students/add', { body: { batchId: batch.id, studentIds: ['stu_1', 'stu_3'] } });
    const roster = (await call(admin, 'GET', 'classes/batches/students', { query: { batchId: batch.id } })).body.items;
    await call(admin, 'POST', 'classes/batches/students/remove', { body: { batchId: batch.id, membershipId: roster.find((item) => item.studentId === 'stu_3').membershipId } });

    state.user = { user_id: 'usr_admin', username: 'a_admin', role: 'admin', school: 'School A', school_id: 'sch_a' };
    const res = { statusCode: 0, status(code) { this.statusCode = code; return this; }, json(payload) { this.body = payload; return this; }, setHeader() {} };
    await intakeTests({ method: 'POST', query: {}, headers: {}, body: { name: 'Unit test 1', subject: 'Mathematics', batch_ids: [batch.id, 'b_math10'] } }, res);
    expect(res.statusCode).toBe(201);
    expect(res.body.test.batches.map((item) => item.id).sort()).toEqual([batch.id, 'b_math10'].sort());
    // Anaya (in both batches) once, Arjun from Grade 10 Maths; Diya left the CRM batch before the test.
    expect(res.body.test.students.map((student) => student.name)).toEqual(['Anaya Iyer', 'Arjun Sharma']);
  });
});

describe('CRM rooms and options (S1)', () => {
  it('manages rooms with unique names and archives them out of the pickers', async () => {
    const room = (await call(admin, 'POST', 'classes/rooms', { body: { name: 'Room 1' } })).body;
    expect(room).toMatchObject({ name: 'Room 1', seats: null, status: 'active', version: 1 });
    expect((await call(admin, 'POST', 'classes/rooms', { body: { name: 'room  1' } })).body.error.code).toBe('duplicate_name');
    const renamed = await call(admin, 'POST', 'classes/rooms/update', { body: { roomId: room.id, name: 'Room 1 (lab)', seats: 24, expectedVersion: 1 } });
    expect(renamed.body).toMatchObject({ name: 'Room 1 (lab)', seats: 24, version: 2 });
    await call(admin, 'POST', 'classes/rooms/archive', { body: { roomId: room.id, expectedVersion: 2 } });
    const options = (await call(teacher, 'GET', 'classes/options')).body;
    expect(options.rooms).toEqual([]);
    expect(options.academicYears.map((year) => year.label)).toEqual(['2026-27', '2025-26']);
    expect(options.subjects.map((subject) => subject.name)).toEqual(['Mathematics', 'Science']);
    expect((await call(admin, 'GET', 'classes/rooms', { query: { status: 'all' } })).body.items).toHaveLength(1);
    expect((await auditRows(state.db, 'room.changed')).map((row) => row.summary.change)).toEqual(['created', 'updated', 'archived']);
  });
});
