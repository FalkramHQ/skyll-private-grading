// Session changes and holidays on real SQLite (FLKRM-327 S4, D6): cancel with
// a reason and undo, substitutes and room changes that survive timetable
// edits, holidays that cancel and are skipped, leave flags, and archiving.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import {
  BASE_SCHEMA, CLASSES_MIGRATIONS, CRM_MIGRATIONS, SEED, actors, auditRows, count, makeCaller, migrationStatements,
} from './classesHarness.js';

const state = vi.hoisted(() => ({ db: null }));
const auth = vi.hoisted(() => ({ database: vi.fn(() => state.db), sessionForRequest: vi.fn() }));
const flags = vi.hoisted(() => ({ isSchoolFeatureEnabled: vi.fn(async () => true) }));
vi.mock('../../../api/_lib/auth.js', () => auth);
vi.mock('../../../api/_lib/featureFlags.js', () => flags);

const { handleCrmRequest } = await import('../../../server/crm/router.js');
const call = makeCaller(auth, handleCrmRequest);
const { admin, otherAdmin, teacher } = actors;
let dir;
const MON = '2030-01-07';

beforeAll(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'crm-sessions-')); });
afterAll(async () => { state.db?.close(); await rm(dir, { recursive: true, force: true }); });

// The fixtures use fixed dates in January 2030. Pin "now" before them so the
// suite does not start failing once those dates pass.
afterEach(() => { vi.useRealTimers(); });

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2029-12-01T06:00:00.000Z'));
  state.db?.close();
  state.db = createClient({ url: `file:${path.join(dir, `${Date.now()}-${Math.random()}.db`)}` });
  await state.db.batch([...BASE_SCHEMA, ...migrationStatements([...CRM_MIGRATIONS, ...CLASSES_MIGRATIONS]), ...SEED], 'write');
  for (const [batchId, userId] of [['b_math10', 'usr_teacher'], ['b_sci9', 'usr_teacher2']]) {
    await call(admin, 'POST', 'classes/batches/instructors', { body: { batchId, userId } });
  }
});

const rule = (body = {}) => call(admin, 'POST', 'classes/rules', {
  body: { batchId: 'b_math10', instructorUserId: 'usr_teacher', weekdays: [1, 3, 5], startTime: '16:00', endTime: '17:30', validFrom: MON, validUntil: '2030-01-27', ...body },
});
const sessions = async (query = {}) => (await call(admin, 'GET', 'classes/sessions', { query: { from: '2030-01-01', to: '2030-02-28', ...query } })).body.items;
const byDate = async () => Object.fromEntries((await sessions()).map((session) => [session.localDate, session]));

describe('Cancelling and restoring a class (S4)', () => {
  it('cancels with a required reason, audits it, and undoes it while still in the future', async () => {
    await rule();
    const wed = (await byDate())['2030-01-09'];
    const noReason = await call(admin, 'POST', 'classes/sessions/cancel', { body: { sessionId: wed.id, expectedVersion: wed.version, reason: ' ' } });
    expect(noReason.statusCode).toBe(422);
    const cancelled = await call(admin, 'POST', 'classes/sessions/cancel', { body: { sessionId: wed.id, expectedVersion: wed.version, reason: 'Teacher unwell' } });
    expect(cancelled.body).toMatchObject({ status: 'cancelled', cancelReason: 'Teacher unwell', version: 2 });
    // Cancelling twice is not a valid move; a stale version is a conflict.
    expect((await call(admin, 'POST', 'classes/sessions/cancel', { body: { sessionId: wed.id, expectedVersion: 2, reason: 'Again' } })).body.error.code).toBe('invalid_transition');
    expect((await call(admin, 'POST', 'classes/sessions/restore', { body: { sessionId: wed.id, expectedVersion: 1 } })).statusCode).toBe(409);
    const restored = await call(admin, 'POST', 'classes/sessions/restore', { body: { sessionId: wed.id, expectedVersion: 2 } });
    expect(restored.body).toMatchObject({ status: 'scheduled', cancelReason: null, version: 3 });
    expect((await auditRows(state.db, 'session.changed')).map((row) => [row.summary.change, row.summary.reason])).toEqual([['cancelled', 'Teacher unwell'], ['restored', undefined]]);
  });

  it('never cancels a held class, never restores a past one, and keeps other schools and teachers out', async () => {
    await rule();
    const dates = await byDate();
    await state.db.execute({ sql: "UPDATE crm_class_sessions SET status = 'held' WHERE id = ?", args: [dates['2030-01-07'].id] });
    expect((await call(admin, 'POST', 'classes/sessions/cancel', { body: { sessionId: dates['2030-01-07'].id, expectedVersion: 1, reason: 'X' } })).body.error.code).toBe('session_held');
    await state.db.execute({ sql: "UPDATE crm_class_sessions SET status = 'cancelled', cancel_reason = 'Old', starts_at = '2020-01-01T10:00:00.000Z', ends_at = '2020-01-01T11:00:00.000Z' WHERE id = ?", args: [dates['2030-01-09'].id] });
    expect((await call(admin, 'POST', 'classes/sessions/restore', { body: { sessionId: dates['2030-01-09'].id, expectedVersion: 1 } })).body.error.code).toBe('session_past');
    expect((await call(teacher, 'POST', 'classes/sessions/cancel', { body: { sessionId: dates['2030-01-11'].id, expectedVersion: 1, reason: 'X' } })).statusCode).toBe(403);
    expect((await call(otherAdmin, 'POST', 'classes/sessions/cancel', { body: { sessionId: dates['2030-01-11'].id, expectedVersion: 1, reason: 'X' } })).statusCode).toBe(404);
  });
});

describe('Substitutes and room changes (S4)', () => {
  it('puts in a substitute who need not be assigned, marks the class changed, and keeps it through a timetable edit', async () => {
    const created = (await rule()).body.rule;
    const fri = (await byDate())['2030-01-18'];
    const sub = await call(admin, 'POST', 'classes/sessions/update', { body: { sessionId: fri.id, expectedVersion: 1, instructorUserId: 'usr_admin' } });
    expect(sub.body).toMatchObject({ instructor: { userId: 'usr_admin', name: 'Admin A' }, isEdited: true });
    expect((await auditRows(state.db, 'session.changed'))[0].summary).toMatchObject({ change: 'updated', fields: ['instructor'], fromInstructorUserId: 'usr_teacher', toInstructorUserId: 'usr_admin' });

    await call(admin, 'POST', 'classes/rules/update', {
      body: { ruleId: created.id, expectedVersion: 1, applyFrom: '2030-01-14', instructorUserId: 'usr_teacher', weekdays: [1, 3, 5], startTime: '17:00', endTime: '18:00', validUntil: '2030-01-27' },
    });
    const after = await byDate();
    expect(after['2030-01-18']).toMatchObject({ id: fri.id, instructor: { userId: 'usr_admin' }, startsAt: fri.startsAt });
    expect(after['2030-01-16'].startsAt).toBe('2030-01-16T11:30:00.000Z');
  });

  it('checks the substitute and new room for clashes, with Save anyway', async () => {
    const lab = (await call(admin, 'POST', 'classes/rooms', { body: { name: 'Lab', seats: 1 } })).body;
    await rule();
    await call(admin, 'POST', 'classes/rules', { body: { batchId: 'b_sci9', instructorUserId: 'usr_teacher2', weekdays: [1], startTime: '16:00', endTime: '17:00', validFrom: MON, validUntil: '2030-01-13', roomId: lab.id } });
    const mon = (await sessions({ batchId: 'b_math10' }))[0];
    const clash = await call(admin, 'POST', 'classes/sessions/update', { body: { sessionId: mon.id, expectedVersion: 1, instructorUserId: 'usr_teacher2', roomId: lab.id } });
    expect(clash.body.error.code).toBe('schedule_conflict');
    expect(clash.body.error.details.conflicts.map((conflict) => conflict.kind).sort()).toEqual(['instructor', 'room']);
    const saved = await call(admin, 'POST', 'classes/sessions/update', { body: { sessionId: mon.id, expectedVersion: 1, instructorUserId: 'usr_teacher2', roomId: lab.id, acknowledgeConflicts: true } });
    expect(saved.body).toMatchObject({ room: { name: 'Lab' }, capacity: 1, isEdited: true });
    expect(await count(state.db, 'SELECT conflict_override AS n FROM crm_class_sessions WHERE id = ?', [mon.id])).toBe(1);
    expect((await call(admin, 'POST', 'classes/sessions/update', { body: { sessionId: mon.id, expectedVersion: 2, instructorUserId: 'usr_staff' } })).body.error.code).toBe('invalid_instructor');
  });
});

describe('Holidays (S4)', () => {
  it('previews, then cancels scheduled classes on those dates, and later timetables skip them', async () => {
    await rule();
    const impact = await call(admin, 'GET', 'classes/holidays/impact', { query: { startsOn: '2030-01-14', endsOn: '2030-01-16' } });
    expect(impact.body).toEqual({ sessions: 2, batches: [{ id: 'b_math10', name: 'Grade 10 Maths', sessions: 2 }] });
    const added = await call(admin, 'POST', 'classes/holidays', { body: { startsOn: '2030-01-14', endsOn: '2030-01-16', label: 'Pongal' } });
    expect(added.statusCode).toBe(201);
    expect(added.body.sessionsCancelled).toBe(2);
    const dates = await byDate();
    expect(dates['2030-01-14']).toMatchObject({ status: 'cancelled', cancelReason: 'Holiday: Pongal' });
    expect(dates['2030-01-18'].status).toBe('scheduled');
    expect((await auditRows(state.db, 'holiday.changed'))[0].summary).toMatchObject({ change: 'added', label: 'Pongal', sessionsCancelled: 2 });

    const science = await call(admin, 'POST', 'classes/rules', { body: { batchId: 'b_sci9', instructorUserId: 'usr_teacher2', weekdays: [2], startTime: '09:00', endTime: '10:00', validFrom: MON, validUntil: '2030-01-27' } });
    expect(science.body.sessionsCreated).toBe(2); // 8th and 22nd; the 15th is Pongal.
    expect((await call(admin, 'POST', 'classes/holidays', { body: { startsOn: '2030-01-16', endsOn: '2030-01-17', label: 'Overlap' } })).body.error.code).toBe('holiday_overlap');
  });

  it('removing a holiday does not bring classes back; teachers can read but not change holidays', async () => {
    await rule();
    const holiday = (await call(admin, 'POST', 'classes/holidays', { body: { startsOn: '2030-01-09', endsOn: '2030-01-09', label: 'Rain' } })).body.holiday;
    expect((await call(teacher, 'GET', 'classes/holidays')).body.items.map((item) => item.label)).toEqual(['Rain']);
    expect((await call(teacher, 'POST', 'classes/holidays/remove', { body: { holidayId: holiday.id } })).statusCode).toBe(403);
    expect((await call(admin, 'POST', 'classes/holidays/remove', { body: { holidayId: holiday.id } })).body).toEqual({ removed: true });
    expect((await byDate())['2030-01-09'].status).toBe('cancelled');
    expect((await call(admin, 'GET', 'classes/holidays')).body.items).toEqual([]);
    expect((await call(otherAdmin, 'POST', 'classes/holidays/remove', { body: { holidayId: holiday.id } })).statusCode).toBe(404);
  });
});

describe('Leave flags and archiving (S4)', () => {
  it('flags scheduled classes that fall in the instructor\'s leave', async () => {
    await call(admin, 'POST', 'classes/availability/exceptions', { body: { userId: 'usr_teacher', startsOn: '2030-01-09', endsOn: '2030-01-09', reason: 'Leave' } });
    await call(admin, 'POST', 'classes/availability/exceptions', { body: { userId: 'usr_teacher', startsOn: '2030-01-11', endsOn: '2030-01-11', start: '09:00', end: '12:00', reason: 'Training' } });
    await rule({ acknowledgeConflicts: true });
    const dates = await byDate();
    expect(dates['2030-01-09'].onLeave).toBe(true);
    expect(dates['2030-01-11'].onLeave).toBe(false);
    expect(dates['2030-01-07'].onLeave).toBe(false);
  });

  it('asks before archiving a batch with future classes, then cancels them and ends its timetables', async () => {
    await call(admin, 'POST', 'classes/rules', { body: { batchId: 'b_sci9', instructorUserId: 'usr_teacher2', weekdays: [2], startTime: '09:00', endTime: '10:00', validFrom: MON, validUntil: '2030-01-27' } });
    const asked = await call(admin, 'POST', 'classes/batches/archive', { body: { batchId: 'b_sci9' } });
    expect(asked.statusCode).toBe(409);
    expect(asked.body.error).toMatchObject({ code: 'has_future_sessions', details: { sessionCount: 3 } });
    const archived = await call(admin, 'POST', 'classes/batches/archive', { body: { batchId: 'b_sci9', cancelFutureSessions: true } });
    expect(archived.body).toMatchObject({ status: 'archived', cancelledSessions: 3 });
    expect(await count(state.db, "SELECT COUNT(*) AS n FROM crm_class_sessions WHERE batch_id = 'b_sci9' AND status = 'cancelled' AND cancel_reason = 'Batch archived'")).toBe(3);
    expect(await count(state.db, "SELECT COUNT(*) AS n FROM crm_timetable_rules WHERE batch_id = 'b_sci9' AND status = 'active'")).toBe(0);
    expect((await auditRows(state.db, 'batch.changed')).at(-1).summary).toMatchObject({ change: 'archived', cancelledSessions: 3 });
  });
});
