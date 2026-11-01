// Instructor assignment and availability on real SQLite (FLKRM-327 S2, D2/D4).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import {
  BASE_SCHEMA, CLASSES_MIGRATIONS, CRM_MIGRATIONS, SEED, actors, auditRows, grant, makeCaller, migrationStatements,
} from './classesHarness.js';

const state = vi.hoisted(() => ({ db: null }));
const auth = vi.hoisted(() => ({ database: vi.fn(() => state.db), sessionForRequest: vi.fn() }));
const flags = vi.hoisted(() => ({ isSchoolFeatureEnabled: vi.fn(async () => true) }));
vi.mock('../../../api/_lib/auth.js', () => auth);
vi.mock('../../../api/_lib/featureFlags.js', () => flags);

const { handleCrmRequest } = await import('../../../server/crm/router.js');
const call = makeCaller(auth, handleCrmRequest);
const { admin, otherAdmin, teacher, teacher2, staff } = actors;
let dir;

beforeAll(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'crm-instructors-')); });
afterAll(async () => { state.db?.close(); await rm(dir, { recursive: true, force: true }); });

beforeEach(async () => {
  state.db?.close();
  state.db = createClient({ url: `file:${path.join(dir, `${Date.now()}-${Math.random()}.db`)}` });
  await state.db.batch([...BASE_SCHEMA, ...migrationStatements([...CRM_MIGRATIONS, ...CLASSES_MIGRATIONS]), ...SEED], 'write');
});

const assign = (body, actor = admin) => call(actor, 'POST', 'classes/batches/instructors', { body: { batchId: 'b_math10', ...body } });
const batchInstructors = async (batchId = 'b_math10') => (await call(admin, 'GET', 'classes/batches/instructors', { query: { batchId } })).body.items;

describe('Instructor assignment (S2)', () => {
  it('assigns several instructors per batch and subject; the first becomes lead', async () => {
    const first = await assign({ userId: 'usr_teacher', subjectId: 'sub_math' });
    expect(first.statusCode).toBe(201);
    expect(first.body).toMatchObject({ userId: 'usr_teacher', name: 'Teacher A', subject: { id: 'sub_math', name: 'Mathematics' }, isLead: true, status: 'active' });
    const second = await assign({ userId: 'usr_admin', subjectId: 'sub_sci' });
    expect(second.body.isLead).toBe(false);
    // Same person, different subject is fine; same person + same subject is a conflict.
    expect((await assign({ userId: 'usr_teacher', subjectId: 'sub_sci' })).statusCode).toBe(201);
    const duplicate = await assign({ userId: 'usr_teacher', subjectId: 'sub_math' });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.body.error.code).toBe('duplicate_assignment');
    expect((await batchInstructors()).map((item) => [item.name, item.subject?.name, item.isLead])).toEqual([
      ['Teacher A', 'Mathematics', true], ['Admin A', 'Science', false], ['Teacher A', 'Science', false],
    ]);
    const batch = (await call(admin, 'GET', 'classes/batches/detail', { query: { batchId: 'b_math10' } })).body;
    expect(batch.lead).toEqual({ userId: 'usr_teacher', name: 'Teacher A' });
  });

  it('only assigns active teachers or admins of this school', async () => {
    expect((await assign({ userId: 'usr_staff' })).body.error.code).toBe('invalid_instructor');
    expect((await assign({ userId: 'usr_admin_b' })).body.error.code).toBe('invalid_instructor');
    expect((await assign({ userId: 'usr_teacher', subjectId: 'sub_b' })).body.error.details[0].path).toBe('subjectId');
    expect((await assign({ userId: 'usr_teacher', batchId: 'b_other' })).statusCode).toBe(404);
    expect((await assign({ userId: 'usr_teacher' }, teacher)).statusCode).toBe(403);
    await state.db.execute("UPDATE school_memberships SET status = 'disabled' WHERE user_id = 'usr_teacher2'");
    expect((await assign({ userId: 'usr_teacher2' })).body.error.code).toBe('invalid_instructor');
  });

  it('swaps the lead atomically and ends assignments without deleting them', async () => {
    const lead = (await assign({ userId: 'usr_teacher', subjectId: 'sub_math' })).body;
    const other = (await assign({ userId: 'usr_teacher2', subjectId: 'sub_sci' })).body;
    const swapped = await call(admin, 'POST', 'classes/batches/instructors/lead', { body: { assignmentId: other.id, expectedVersion: other.version } });
    expect(swapped.body.isLead).toBe(true);
    expect((await batchInstructors()).filter((item) => item.isLead).map((item) => item.userId)).toEqual(['usr_teacher2']);
    // A stale version changes nothing.
    expect((await call(admin, 'POST', 'classes/batches/instructors/lead', { body: { assignmentId: lead.id, expectedVersion: lead.version } })).statusCode).toBe(409);

    // Assigning with isLead moves the lead too.
    const third = (await assign({ userId: 'usr_admin', isLead: true })).body;
    expect((await batchInstructors()).filter((item) => item.isLead).map((item) => item.id)).toEqual([third.id]);

    const ended = await call(admin, 'POST', 'classes/batches/instructors/end', { body: { assignmentId: third.id, expectedVersion: third.version } });
    expect(ended.body).toMatchObject({ status: 'ended', isLead: false });
    expect(ended.body.endedAt).toBeTruthy();
    expect((await batchInstructors()).map((item) => item.status)).toEqual(['active', 'active', 'ended']);
    // Ended people can be assigned again.
    expect((await assign({ userId: 'usr_admin' })).statusCode).toBe(201);
    const audit = await auditRows(state.db, 'instructor.changed');
    expect(audit.map((row) => row.summary.change)).toEqual(['assigned', 'assigned', 'lead_changed', 'assigned', 'ended', 'assigned']);
    expect(audit[3].summary).toMatchObject({ isLead: true, previousLeadUserId: 'usr_teacher2' });
    expect(audit.every((row) => row.entity_type === 'batch' && row.entity_id === 'b_math10')).toBe(true);
  });

  it('keeps other schools out', async () => {
    const assignment = (await assign({ userId: 'usr_teacher' })).body;
    expect((await call(otherAdmin, 'GET', 'classes/batches/instructors', { query: { batchId: 'b_math10' } })).statusCode).toBe(404);
    expect((await call(otherAdmin, 'POST', 'classes/batches/instructors/end', { body: { assignmentId: assignment.id, expectedVersion: 1 } })).statusCode).toBe(404);
  });
});

describe('Instructor availability (S2)', () => {
  const week = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '15:00', end: '20:00' }));

  it('lets a teacher set their own weekly windows and leave, but nobody else\'s', async () => {
    const own = await call(teacher, 'POST', 'classes/availability', { body: { userId: 'usr_teacher', windows: week } });
    expect(own.statusCode).toBe(200);
    expect(own.body).toMatchObject({ userId: 'usr_teacher', summary: 'Mon–Fri 15:00–20:00', canEdit: true });
    expect(own.body.windows).toHaveLength(5);
    const leave = await call(teacher, 'POST', 'classes/availability/exceptions', { body: { userId: 'usr_teacher', startsOn: '2099-10-14', endsOn: '2099-10-15', reason: 'Leave' } });
    expect(leave.statusCode).toBe(201);
    expect(leave.body.exceptions).toEqual([expect.objectContaining({ startsOn: '2099-10-14', endsOn: '2099-10-15', start: null, reason: 'Leave' })]);

    expect((await call(teacher, 'POST', 'classes/availability', { body: { userId: 'usr_teacher2', windows: week } })).statusCode).toBe(403);
    expect((await call(teacher, 'POST', 'classes/availability/exceptions', { body: { userId: 'usr_teacher2', startsOn: '2099-10-14', endsOn: '2099-10-14', reason: 'Leave' } })).statusCode).toBe(403);
    // Reading someone else's is fine (school-wide view), but not editable.
    const other = await call(teacher, 'GET', 'classes/availability', { query: { userId: 'usr_teacher2' } });
    expect(other.body).toMatchObject({ summary: 'Always available', canEdit: false });
  });

  it('lets classes-write holders edit anyone, replacing the weekly set', async () => {
    await call(admin, 'POST', 'classes/availability', { body: { userId: 'usr_teacher', windows: week } });
    const replaced = await call(admin, 'POST', 'classes/availability', { body: { userId: 'usr_teacher', windows: [{ weekday: 6, start: '09:00', end: '13:00' }] } });
    expect(replaced.body.summary).toBe('Sat 09:00–13:00');
    const cleared = await call(admin, 'POST', 'classes/availability', { body: { userId: 'usr_teacher', windows: [] } });
    expect(cleared.body.summary).toBe('Always available');
    expect((await call(admin, 'POST', 'classes/availability', { body: { userId: 'usr_staff', windows: week } })).body.error.code).toBe('invalid_instructor');
    expect((await call(admin, 'POST', 'classes/availability', { body: { userId: 'usr_teacher', windows: [{ weekday: 1, start: '15:00', end: '18:00' }, { weekday: 1, start: '17:00', end: '19:00' }] } })).statusCode).toBe(422);
    expect((await auditRows(state.db, 'availability.changed')).map((row) => [row.entity_id, row.summary.windowCount])).toEqual([['usr_teacher', 5], ['usr_teacher', 1], ['usr_teacher', 0]]);
  });

  it('removes leave softly, only by the owner or classes write', async () => {
    const added = (await call(teacher, 'POST', 'classes/availability/exceptions', { body: { userId: 'usr_teacher', startsOn: '2099-10-14', endsOn: '2099-10-14', start: '09:00', end: '12:00', reason: 'Training' } })).body;
    const exceptionId = added.exceptions[0].id;
    expect((await call(teacher2, 'POST', 'classes/availability/exceptions/remove', { body: { exceptionId } })).statusCode).toBe(403);
    expect((await call(otherAdmin, 'POST', 'classes/availability/exceptions/remove', { body: { exceptionId } })).statusCode).toBe(404);
    const removed = await call(teacher, 'POST', 'classes/availability/exceptions/remove', { body: { exceptionId } });
    expect(removed.body.exceptions).toEqual([]);
    expect((await state.db.execute({ sql: 'SELECT removed_at FROM crm_availability_exceptions WHERE id = ?', args: [exceptionId] })).rows[0].removed_at).toBeTruthy();
    expect((await call(teacher, 'POST', 'classes/availability/exceptions/remove', { body: { exceptionId } })).statusCode).toBe(422);
  });

  it('lists instructors with their batches, availability and next leave', async () => {
    await assign({ userId: 'usr_teacher', subjectId: 'sub_math' });
    await call(teacher, 'POST', 'classes/availability', { body: { userId: 'usr_teacher', windows: week } });
    await call(teacher, 'POST', 'classes/availability/exceptions', { body: { userId: 'usr_teacher', startsOn: '2099-12-24', endsOn: '2099-12-26', reason: 'Holiday' } });
    await call(teacher, 'POST', 'classes/availability/exceptions', { body: { userId: 'usr_teacher', startsOn: '2000-01-01', endsOn: '2000-01-02', reason: 'Old' } });
    const list = (await call(teacher, 'GET', 'classes/instructors')).body.items;
    // Staff never appear; admins and teachers do.
    expect(list.map((person) => person.name).sort()).toEqual(['Admin A', 'Teacher A', 'Teacher Two']);
    const me = list.find((person) => person.userId === 'usr_teacher');
    expect(me).toMatchObject({
      role: 'teacher', canEditAvailability: true,
      assignments: [expect.objectContaining({ batchName: 'Grade 10 Maths', isLead: true })],
      availability: { summary: 'Mon–Fri 15:00–20:00', windowCount: 5, nextLeave: expect.objectContaining({ reason: 'Holiday' }), leaveCount: 1 },
    });
    expect(list.find((person) => person.userId === 'usr_teacher2').canEditAvailability).toBe(false);
    await grant(state.db, 'usr_staff', ['crm.access', 'crm.classes.read']);
    expect((await call(staff, 'GET', 'classes/instructors')).statusCode).toBe(200);
    expect((await call(staff, 'POST', 'classes/availability', { body: { userId: 'usr_teacher', windows: [] } })).statusCode).toBe(403);
  });
});
