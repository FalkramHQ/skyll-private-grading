// Attendance marking on real SQLite (FLKRM-327 S5, D3, D8–D10): who is on a
// sheet, who may mark it and when, corrections with reasons, all-or-nothing
// bulk saves, conflicts, and school isolation.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { addDays, localDate } from '../../../shared/crm/time.js';
import { sessionWindow } from '../../../shared/crm/timetable.js';
import {
  BASE_SCHEMA, CLASSES_MIGRATIONS, CRM_MIGRATIONS, SEED, actors, auditRows, count, grant, makeCaller, migrationStatements,
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

const TZ = 'Asia/Kolkata';
const today = () => localDate(Date.now(), TZ);
const iso = (date, time) => sessionWindow(date, time, '23:59', TZ).startsAt;

beforeAll(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'crm-attendance-')); });
afterAll(async () => { state.db?.close(); await rm(dir, { recursive: true, force: true }); });

let sessionSeq = 0;
// Late-evening classes, so "today's" class hasn't ended whenever the tests run.
async function session({ batchId = 'b_math10', date = today(), instructor = 'usr_teacher', status = 'scheduled', start = '23:58', end = '23:59' } = {}) {
  sessionSeq += 1;
  const id = `cs_${sessionSeq}`;
  const { startsAt, endsAt } = sessionWindow(date, start, end, TZ);
  await state.db.execute({
    sql: `INSERT INTO crm_class_sessions (id, school_id, batch_id, instructor_user_id, local_date, starts_at, ends_at, status, cancel_reason, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [id, batchId === 'b_other' ? 'sch_b' : 'sch_a', batchId, instructor, date, startsAt, endsAt, status, status === 'cancelled' ? 'Rain' : null, startsAt, startsAt],
  });
  return id;
}

beforeEach(async () => {
  state.db?.close();
  state.db = createClient({ url: `file:${path.join(dir, `${Date.now()}-${Math.random()}.db`)}` });
  await state.db.batch([...BASE_SCHEMA, ...migrationStatements([...CRM_MIGRATIONS, ...CLASSES_MIGRATIONS]), ...SEED], 'write');
  await call(admin, 'POST', 'classes/batches/instructors', { body: { batchId: 'b_math10', userId: 'usr_teacher' } });
  await call(admin, 'POST', 'classes/batches/instructors', { body: { batchId: 'b_sci9', userId: 'usr_teacher2' } });
  // Diya joined Grade 10 Maths two days ago; Arjun left three days ago.
  await state.db.execute({ sql: "INSERT INTO batch_memberships VALUES ('bm_3', 'b_math10', 'stu_3', 'active', ?, NULL, ?, ?)", args: [iso(addDays(today(), -2), '08:00'), iso(today(), '00:00'), iso(today(), '00:00')] });
  await state.db.execute({ sql: "UPDATE batch_memberships SET status = 'inactive', left_at = ? WHERE id = 'bm_2'", args: [iso(addDays(today(), -3), '08:00')] });
});

const sheet = (sessionId, actor = teacher) => call(actor, 'GET', 'attendance/sheet', { query: { sessionId } });
const mark = (sessionId, marks, actor = teacher) => call(actor, 'POST', 'attendance/mark', { body: { sessionId, marks } });
const rows = async (sessionId) => (await state.db.execute({ sql: 'SELECT student_id, status, version FROM crm_session_attendance WHERE session_id = ? ORDER BY student_id', args: [sessionId] })).rows.map((row) => [row.student_id, row.status, Number(row.version)]);

describe('The sheet and its roster (S5, D8)', () => {
  it('lists the students who were in the batch when the class started', async () => {
    const todays = await session();
    const old = await session({ date: addDays(today(), -5) });
    const now = (await sheet(todays)).body;
    expect(now.students.map((student) => student.name)).toEqual(['Anaya Iyer', 'Diya Rao']);
    expect(now).toMatchObject({ canMark: true, blockedReason: null, session: { id: todays, batch: { name: 'Grade 10 Maths' } } });
    const before = (await sheet(old)).body;
    expect(before.students.map((student) => student.name)).toEqual(['Anaya Iyer', 'Arjun Sharma']);
  });

  it('keeps already-marked students on the sheet after they leave', async () => {
    const todays = await session();
    await mark(todays, [{ studentId: 'stu_1', status: 'present' }, { studentId: 'stu_3', status: 'absent' }]);
    await state.db.execute({ sql: "UPDATE batch_memberships SET status = 'inactive', left_at = '2000-01-01T00:00:00.000Z' WHERE id = 'bm_3'" });
    const after = (await sheet(todays)).body.students;
    expect(after.map((student) => [student.name, student.status])).toEqual([['Anaya Iyer', 'present'], ['Diya Rao', 'absent']]);
  });
});

describe('Marking (S5, D9/D10)', () => {
  it('saves a whole class at once, holds the session and audits counts only', async () => {
    const todays = await session();
    const saved = await mark(todays, [{ studentId: 'stu_1', status: 'present' }, { studentId: 'stu_3', status: 'late', note: 'Bus was late' }]);
    expect(saved.statusCode).toBe(200);
    expect(saved.body.counts).toEqual({ present: 1, absent: 0, late: 1, excused: 0, unmarked: 0 });
    expect(await rows(todays)).toEqual([['stu_1', 'present', 1], ['stu_3', 'late', 1]]);
    expect(await count(state.db, 'SELECT COUNT(*) AS n FROM crm_class_sessions WHERE id = ? AND status = ?', [todays, 'held'])).toBe(1);
    const audit = await auditRows(state.db, 'attendance.marked');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ entity_type: 'class_session', entity_id: todays, summary: { batchId: 'b_math10', firstMarks: 2, corrections: 0, counts: { present: 1, late: 1, absent: 0, excused: 0 } } });
    expect(JSON.stringify(audit[0].summary)).not.toMatch(/Anaya|Bus/);
  });

  it('treats a change to a saved mark as a correction that needs a reason', async () => {
    const todays = await session();
    await mark(todays, [{ studentId: 'stu_1', status: 'absent' }]);
    const noReason = await mark(todays, [{ studentId: 'stu_1', status: 'late', expectedVersion: 1 }]);
    expect(noReason.statusCode).toBe(422);
    expect(noReason.body.error).toMatchObject({ code: 'reason_required', details: [{ studentId: 'stu_1' }] });
    const fixed = await mark(todays, [{ studentId: 'stu_1', status: 'late', expectedVersion: 1, reasonKey: 'arrived_late' }]);
    expect(fixed.statusCode).toBe(200);
    expect(await rows(todays)).toEqual([['stu_1', 'late', 2]]);
    const corrected = await auditRows(state.db, 'attendance.corrected');
    expect(corrected).toEqual([expect.objectContaining({
      entity_type: 'student', entity_id: 'stu_1', actor_user_id: 'usr_teacher',
      summary: { studentId: 'stu_1', sessionId: todays, from: 'absent', to: 'late', reason: 'Arrived late', reasonKey: 'arrived_late' },
    })]);
    // Sending the same status again is not a change.
    expect((await mark(todays, [{ studentId: 'stu_1', status: 'late', expectedVersion: 2 }])).statusCode).toBe(200);
    expect(await auditRows(state.db, 'attendance.corrected')).toHaveLength(1);
  });

  it('is all-or-nothing: a stale mark or a first mark someone else saved refuses the whole sheet', async () => {
    const todays = await session();
    await mark(todays, [{ studentId: 'stu_1', status: 'present' }]);
    const stale = await mark(todays, [
      { studentId: 'stu_3', status: 'present' },
      { studentId: 'stu_1', status: 'absent', expectedVersion: 7, reasonKey: 'marked_by_mistake' },
    ]);
    expect(stale.statusCode).toBe(409);
    expect(stale.body.error).toMatchObject({ code: 'attendance_conflict', details: { studentIds: ['stu_1'] } });
    expect(await rows(todays)).toEqual([['stu_1', 'present', 1]]);
    // A first mark for a student someone else has just marked.
    const raced = await mark(todays, [{ studentId: 'stu_3', status: 'present' }, { studentId: 'stu_1', status: 'absent' }]);
    expect(raced.statusCode).toBe(409);
    expect(await rows(todays)).toEqual([['stu_1', 'present', 1]]);
  });

  it('aborts everything when a mark changes or the class is cancelled between reading and writing', async () => {
    const todays = await session();
    await mark(todays, [{ studentId: 'stu_1', status: 'present' }]);
    // Someone else saves just before this request's write lands.
    const batch = state.db.batch.bind(state.db);
    state.db.batch = async (statements, mode) => {
      state.db.batch = batch;
      await state.db.execute("UPDATE crm_session_attendance SET status = 'absent', version = version + 1 WHERE student_id = 'stu_1'");
      return batch(statements, mode);
    };
    const raced = await mark(todays, [{ studentId: 'stu_3', status: 'present' }, { studentId: 'stu_1', status: 'late', expectedVersion: 1, reasonKey: 'arrived_late' }]);
    expect(raced.statusCode).toBe(409);
    expect(raced.body.error.code).toBe('attendance_conflict');
    expect(await rows(todays)).toEqual([['stu_1', 'absent', 2]]);
    expect(await auditRows(state.db, 'attendance.corrected')).toEqual([]);

    const another = await session({ start: '23:50', end: '23:55' });
    state.db.batch = async (statements, mode) => {
      state.db.batch = batch;
      await state.db.execute({ sql: "UPDATE crm_class_sessions SET status = 'cancelled', cancel_reason = 'Rain' WHERE id = ?", args: [another] });
      return batch(statements, mode);
    };
    const cancelled = await mark(another, [{ studentId: 'stu_1', status: 'present' }]);
    expect(cancelled.body.error.code).toBe('session_cancelled');
    expect(await rows(another)).toEqual([]);
  });

  it('refuses the whole sheet when any student is not on the roster', async () => {
    const old = await session({ date: addDays(today(), -5) });
    for (const studentId of ['stu_3', 'stu_4', 'stu_b1', 'stu_missing']) {
      const refused = await mark(old, [{ studentId: 'stu_1', status: 'present' }, { studentId, status: 'present' }]);
      expect(refused.statusCode).toBe(422);
      expect(refused.body.error).toMatchObject({ code: 'not_on_roster', details: { studentIds: [studentId] } });
    }
    expect(await rows(old)).toEqual([]);
  });
});

describe('Who may mark, and when (S5, D3/D9)', () => {
  it('lets teachers mark only their own classes; a substitute counts; a grant widens it', async () => {
    const maths = await session();
    const blocked = await mark(maths, [{ studentId: 'stu_1', status: 'present' }], teacher2);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.body.error.code).toBe('not_your_class');
    expect((await sheet(maths, teacher2)).body).toMatchObject({ canMark: false, blockedReason: 'not_your_class' });

    const covered = await session({ instructor: 'usr_teacher2', start: '23:56', end: '23:57' });
    expect((await mark(covered, [{ studentId: 'stu_1', status: 'present' }], teacher2)).statusCode).toBe(200);

    await grant(state.db, 'usr_teacher2', ['crm.attendance.write']);
    expect((await mark(maths, [{ studentId: 'stu_1', status: 'present' }], teacher2)).statusCode).toBe(200);
  });

  it('opens on the class day and locks own-class markers out after seven days', async () => {
    const tomorrow = await session({ date: addDays(today(), 1) });
    const early = await mark(tomorrow, [{ studentId: 'stu_1', status: 'present' }], admin);
    expect(early.body.error.code).toBe('not_yet');

    const lastWeek = await session({ date: addDays(today(), -7) });
    expect((await mark(lastWeek, [{ studentId: 'stu_1', status: 'present' }])).statusCode).toBe(200);

    const old = await session({ date: addDays(today(), -8) });
    const locked = await mark(old, [{ studentId: 'stu_1', status: 'present' }]);
    expect(locked.statusCode).toBe(403);
    expect(locked.body.error.code).toBe('attendance_locked');
    expect((await mark(old, [{ studentId: 'stu_1', status: 'present' }], admin)).statusCode).toBe(200);
    expect((await mark(old, [{ studentId: 'stu_1', status: 'absent', expectedVersion: 1, reasonKey: 'other', reasonNote: 'Register checked' }], admin)).statusCode).toBe(200);
  });

  it('never marks a cancelled class, and keeps read-only roles and other schools out', async () => {
    const cancelled = await session({ status: 'cancelled' });
    expect((await mark(cancelled, [{ studentId: 'stu_1', status: 'present' }], admin)).body.error.code).toBe('session_cancelled');

    const todays = await session();
    await grant(state.db, 'usr_staff', ['crm.access', 'crm.attendance.read']);
    expect((await sheet(todays, staff)).body).toMatchObject({ canMark: false, blockedReason: 'read_only' });
    expect((await mark(todays, [{ studentId: 'stu_1', status: 'present' }], staff)).statusCode).toBe(403);
    expect((await sheet(todays, otherAdmin)).statusCode).toBe(404);
    expect((await mark(todays, [{ studentId: 'stu_1', status: 'present' }], otherAdmin)).statusCode).toBe(404);
  });
});

describe('Today and waiting lists (S5, D10)', () => {
  it('shows today\'s classes with marking progress and the classes still waiting', async () => {
    // Anaya joined Grade 9 Science three days ago.
    await state.db.execute({ sql: "INSERT INTO batch_memberships VALUES ('bm_sci', 'b_sci9', 'stu_1', 'active', ?, NULL, ?, ?)", args: [iso(addDays(today(), -3), '08:00'), iso(today(), '00:00'), iso(today(), '00:00')] });
    const todays = await session();
    await session({ batchId: 'b_sci9', instructor: 'usr_teacher2' });
    const waitingMine = await session({ date: addDays(today(), -2) });
    await session({ date: addDays(today(), -2), batchId: 'b_sci9', instructor: 'usr_teacher2' });
    await session({ date: addDays(today(), -10) });
    await session({ date: addDays(today(), -3), status: 'cancelled' });
    await mark(todays, [{ studentId: 'stu_1', status: 'present' }]);

    const mine = (await call(teacher, 'GET', 'attendance/today')).body;
    expect(mine.view).toBe('mine');
    expect(mine.items).toEqual([expect.objectContaining({ id: todays, markedCount: 1, rosterCount: 2, status: 'held' })]);
    expect((await call(admin, 'GET', 'attendance/today', { query: { view: 'all' } })).body.items).toHaveLength(2);

    const pendingMine = (await call(teacher, 'GET', 'attendance/pending')).body.items;
    expect(pendingMine.map((item) => item.id)).toEqual([waitingMine]);
    // A class from before anyone joined has an empty roster and never waits.
    await session({ date: addDays(today(), -4), batchId: 'b_sci9', instructor: 'usr_teacher2' });
    const pendingAll = (await call(admin, 'GET', 'attendance/pending')).body.items;
    expect(pendingAll).toHaveLength(3);
    expect(pendingAll.every((item) => item.status === 'scheduled')).toBe(true);
    // Read-only front desk sees the whole school's lists.
    await grant(state.db, 'usr_staff', ['crm.access', 'crm.attendance.read']);
    expect((await call(staff, 'GET', 'attendance/today')).body).toMatchObject({ view: 'all', items: [expect.anything(), expect.anything()] });
    expect((await call(staff, 'GET', 'attendance/pending')).body.items).toHaveLength(3);
  });
});
