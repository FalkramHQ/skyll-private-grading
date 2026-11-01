// Attendance summaries on real SQLite (FLKRM-327 S6, D11): the formula,
// who counts in a batch over a range, the monthly register, the student
// card, and corrections on the student timeline.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { addDays, localDate } from '../../../shared/crm/time.js';
import { sessionWindow } from '../../../shared/crm/timetable.js';
import {
  BASE_SCHEMA, CLASSES_MIGRATIONS, CRM_MIGRATIONS, SEED, actors, grant, makeCaller, migrationStatements,
} from './classesHarness.js';

const state = vi.hoisted(() => ({ db: null }));
const auth = vi.hoisted(() => ({ database: vi.fn(() => state.db), sessionForRequest: vi.fn() }));
const flags = vi.hoisted(() => ({ isSchoolFeatureEnabled: vi.fn(async () => true) }));
vi.mock('../../../api/_lib/auth.js', () => auth);
vi.mock('../../../api/_lib/featureFlags.js', () => flags);

const { handleCrmRequest } = await import('../../../server/crm/router.js');
const call = makeCaller(auth, handleCrmRequest);
const { admin, otherAdmin, teacher, staff } = actors;
let dir;
const TZ = 'Asia/Kolkata';
const today = () => localDate(Date.now(), TZ);

beforeAll(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'crm-summaries-')); });
afterAll(async () => { state.db?.close(); await rm(dir, { recursive: true, force: true }); });

let seq = 0;
async function session(date, status = 'scheduled') {
  seq += 1;
  const id = `cs_${seq}`;
  const { startsAt, endsAt } = sessionWindow(date, '09:00', '10:00', TZ);
  await state.db.execute({
    sql: `INSERT INTO crm_class_sessions (id, school_id, batch_id, instructor_user_id, local_date, starts_at, ends_at, status, cancel_reason, created_at, updated_at)
          VALUES (?, 'sch_a', 'b_math10', 'usr_teacher', ?, ?, ?, ?, ?, ?, ?)`,
    args: [id, date, startsAt, endsAt, status, status === 'cancelled' ? 'Rain' : null, startsAt, startsAt],
  });
  return id;
}
const mark = (sessionId, marks) => call(admin, 'POST', 'attendance/mark', { body: { sessionId, marks } });

let days;
beforeEach(async () => {
  state.db?.close();
  state.db = createClient({ url: `file:${path.join(dir, `${Date.now()}-${Math.random()}.db`)}` });
  await state.db.batch([...BASE_SCHEMA, ...migrationStatements([...CRM_MIGRATIONS, ...CLASSES_MIGRATIONS]), ...SEED], 'write');
  await state.db.execute({ sql: "UPDATE academic_years SET starts_on = ?, ends_on = ? WHERE id = 'ay_26'", args: [addDays(today(), -60), addDays(today(), 200)] });
  // Anaya and Arjun are in Grade 10 Maths from before; Arjun leaves before the last class.
  days = [-10, -8, -6, -4, -2].map((offset) => addDays(today(), offset));
  const [d10, d8, d6, d4, d2] = days;
  const ids = {};
  ids.d10 = await session(d10);
  ids.d8 = await session(d8);
  ids.d6 = await session(d6, 'cancelled');
  ids.d4 = await session(d4);
  ids.d2 = await session(d2);
  await mark(ids.d10, [{ studentId: 'stu_1', status: 'present' }, { studentId: 'stu_2', status: 'absent' }]);
  await mark(ids.d8, [{ studentId: 'stu_1', status: 'late' }, { studentId: 'stu_2', status: 'excused' }]);
  await mark(ids.d4, [{ studentId: 'stu_1', status: 'absent' }, { studentId: 'stu_2', status: 'present' }]);
  // d2: nobody marked yet. Arjun left the day before.
  await state.db.execute({ sql: "UPDATE batch_memberships SET status = 'inactive', left_at = ? WHERE id = 'bm_2'", args: [sessionWindow(addDays(today(), -3), '09:00', '10:00', TZ).startsAt] });
  state.ids = ids;
});

describe('Batch summary and register (S6)', () => {
  it('counts late as attended, leaves out excused and cancelled, and lists the lowest first', async () => {
    const summary = await call(admin, 'GET', 'attendance/batch-summary', { query: { batchId: 'b_math10', from: days[0], to: today() } });
    expect(summary.statusCode).toBe(200);
    expect(summary.body).toMatchObject({ classesHeld: 3, classesCancelled: 1 });
    expect(summary.body.students).toEqual([
      // Arjun: present 1, absent 1 (excused left out) → 50%; he left before d2, so it isn't "not marked".
      { studentId: 'stu_2', name: 'Arjun Sharma', counts: { present: 1, absent: 1, late: 0, excused: 1, notMarked: 0, percent: 50 } },
      // Anaya: present 1 + late 1 of 3 → 67%; d2 is not marked.
      { studentId: 'stu_1', name: 'Anaya Iyer', counts: { present: 1, absent: 1, late: 1, excused: 0, notMarked: 1, percent: 67 } },
    ]);
    expect(summary.body.overall).toMatchObject({ present: 2, late: 1, absent: 2, excused: 1, notMarked: 1, percent: 60 });
  });

  it('builds a students × classes register for a month', async () => {
    // The month of the latest class, not today's: on the 1st and 2nd every sample class is in the previous month.
    const month = days.at(-1).slice(0, 7);
    const register = (await call(admin, 'GET', 'attendance/register', { query: { batchId: 'b_math10', month } })).body;
    const inMonth = days.filter((day) => day.startsWith(month));
    expect(register.sessions.map((session) => session.localDate)).toEqual(inMonth);
    const anaya = register.students.find((student) => student.studentId === 'stu_1');
    const expected = { [days[0]]: 'present', [days[1]]: 'late', [days[2]]: 'cancelled', [days[3]]: 'absent', [days[4]]: 'not_marked' };
    expect(anaya.cells).toEqual(inMonth.map((day) => expected[day]));
    const arjun = register.students.find((student) => student.studentId === 'stu_2');
    if (inMonth.includes(days[4])) expect(arjun.cells.at(-1)).toBeNull();
  });

  it('is limited to a year, to people with attendance read, and to the school', async () => {
    expect((await call(admin, 'GET', 'attendance/batch-summary', { query: { batchId: 'b_math10', from: '2025-01-01', to: '2026-06-01' } })).statusCode).toBe(422);
    expect((await call(staff, 'GET', 'attendance/batch-summary', { query: { batchId: 'b_math10', from: days[0], to: today() } })).statusCode).toBe(403);
    await grant(state.db, 'usr_staff', ['crm.access', 'crm.attendance.read']);
    expect((await call(staff, 'GET', 'attendance/batch-summary', { query: { batchId: 'b_math10', from: days[0], to: today() } })).statusCode).toBe(200);
    expect((await call(otherAdmin, 'GET', 'attendance/batch-summary', { query: { batchId: 'b_math10', from: days[0], to: today() } })).statusCode).toBe(404);
    expect((await call(otherAdmin, 'GET', 'attendance/register', { query: { batchId: 'b_math10', month: today().slice(0, 7) } })).statusCode).toBe(404);
  });
});

describe('Student summary and timeline (S6)', () => {
  it('summarises the academic year per batch with the last classes, newest first', async () => {
    const summary = (await call(teacher, 'GET', 'attendance/student-summary', { query: { studentId: 'stu_1' } })).body;
    expect(summary.range).toMatchObject({ from: addDays(today(), -60), label: '2026-27' });
    expect(summary.overall).toEqual({ present: 1, absent: 1, late: 1, excused: 0, notMarked: 1, percent: 67 });
    expect(summary.batches).toEqual([{ batchId: 'b_math10', name: 'Grade 10 Maths', counts: summary.overall }]);
    expect(summary.recent.map((item) => item.status)).toEqual(['not_marked', 'absent', 'cancelled', 'late', 'present']);
  });

  it('needs student read as well, and stays within the school', async () => {
    await grant(state.db, 'usr_staff', ['crm.access', 'crm.attendance.read']);
    expect((await call(staff, 'GET', 'attendance/student-summary', { query: { studentId: 'stu_1' } })).statusCode).toBe(403);
    expect((await call(otherAdmin, 'GET', 'attendance/student-summary', { query: { studentId: 'stu_1' } })).statusCode).toBe(404);
  });

  it('shows attendance corrections on the student timeline, with the class', async () => {
    const before = (await call(admin, 'GET', 'attendance/sheet', { query: { sessionId: state.ids.d4 } })).body;
    const anaya = before.students.find((student) => student.studentId === 'stu_1');
    await mark(state.ids.d4, [{ studentId: 'stu_1', status: 'late', expectedVersion: anaya.version, reasonKey: 'arrived_late' }]);
    const items = (await call(admin, 'GET', 'timeline', { query: { entityType: 'student', entityId: 'stu_1' } })).body.items;
    expect(items.find((item) => item.kind === 'attendance')).toMatchObject({ from: 'absent', to: 'late', reason: 'Arrived late', batchName: 'Grade 10 Maths', localDate: days[3] });
    // Without attendance access the correction is left out.
    await grant(state.db, 'usr_staff', ['crm.access', 'crm.students.read']);
    const staffItems = (await call(staff, 'GET', 'timeline', { query: { entityType: 'student', entityId: 'stu_1' } })).body.items;
    expect(staffItems.some((item) => item.kind === 'attendance')).toBe(false);
  });
});
