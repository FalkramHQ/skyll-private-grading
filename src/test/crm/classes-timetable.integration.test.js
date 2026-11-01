// Timetable rules and sessions on real SQLite (FLKRM-327 S3, D5–D7):
// generation in the school timezone, clash and availability checks with an
// audited override, and rule edits that never rewrite held, cancelled or
// hand-edited sessions.
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

// 7 Jan 2030 is a Monday.
const MON = '2030-01-07';

beforeAll(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'crm-timetable-')); });
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
  for (const [batchId, userId] of [['b_math10', 'usr_teacher'], ['b_sci9', 'usr_teacher'], ['b_math10', 'usr_teacher2'], ['b_sci9', 'usr_teacher2']]) {
    await call(admin, 'POST', 'classes/batches/instructors', { body: { batchId, userId } });
  }
});

let roomCounter = 0;
const room = async (name = `Room ${roomCounter += 1}`, seats = 30) => (await call(admin, 'POST', 'classes/rooms', { body: { name, seats } })).body;
const rule = (body = {}, actor = admin) => call(actor, 'POST', 'classes/rules', {
  body: { batchId: 'b_math10', instructorUserId: 'usr_teacher', weekdays: [1, 3, 5], startTime: '16:00', endTime: '17:30', validFrom: MON, validUntil: '2030-01-20', ...body },
});
const sessions = async (query = {}) => (await call(admin, 'GET', 'classes/sessions', { query: { from: '2030-01-01', to: '2030-02-28', ...query } })).body.items;

describe('Creating a timetable (S3)', () => {
  it('generates a session per matching date with UTC times from IST', async () => {
    const r2 = await room('Room 2', 30);
    const created = await rule({ roomId: r2.id, subjectId: 'sub_math' });
    expect(created.statusCode).toBe(201);
    expect(created.body).toMatchObject({ sessionsCreated: 6, capacity: null });
    expect(created.body.rule).toMatchObject({
      weekdays: [1, 3, 5], startTime: '16:00', endTime: '17:30', timezone: 'Asia/Kolkata', validFrom: MON, validUntil: '2030-01-20',
      instructor: { userId: 'usr_teacher', name: 'Teacher A' }, room: { name: 'Room 2' }, subject: { name: 'Mathematics' }, sessionCount: 6, upcomingCount: 6, status: 'active',
    });
    const list = await sessions();
    expect(list.map((session) => session.localDate)).toEqual(['2030-01-07', '2030-01-09', '2030-01-11', '2030-01-14', '2030-01-16', '2030-01-18']);
    expect(list[0]).toMatchObject({ startsAt: '2030-01-07T10:30:00.000Z', endsAt: '2030-01-07T12:00:00.000Z', status: 'scheduled', capacity: 30, notMarked: false, batch: { name: 'Grade 10 Maths' } });
    expect((await auditRows(state.db, 'timetable.changed'))[0]).toMatchObject({ entity_type: 'batch', entity_id: 'b_math10', summary: { change: 'created', sessionsCreated: 6 } });
  });

  it('needs an assigned instructor, a year at most, and at least one date', async () => {
    expect((await rule({ instructorUserId: 'usr_admin' })).body.error.code).toBe('not_assigned');
    expect((await rule({ instructorUserId: 'usr_staff' })).body.error.code).toBe('invalid_instructor');
    expect((await rule({ validUntil: '2031-01-08' })).body.error.details[0].path).toBe('validUntil');
    expect((await rule({ weekdays: [2], validUntil: MON })).body.error.details[0].message).toMatch(/No class falls/);
    expect((await rule({}, teacher)).statusCode).toBe(403);
    expect((await rule({ batchId: 'b_other' })).statusCode).toBe(404);
    expect((await call(otherAdmin, 'GET', 'classes/rules', { query: { batchId: 'b_math10' } })).statusCode).toBe(404);
  });

  it('allows a timetable that started in the past; those sessions show as not marked', async () => {
    const created = await rule({ validFrom: '2025-01-06', validUntil: '2025-01-12', weekdays: [1] });
    expect(created.statusCode).toBe(201);
    const list = (await call(admin, 'GET', 'classes/sessions', { query: { from: '2025-01-01', to: '2025-01-31' } })).body.items;
    expect(list).toEqual([expect.objectContaining({ localDate: '2025-01-06', status: 'scheduled', notMarked: true })]);
  });
});

describe('Clashes and availability (S3, D7)', () => {
  it('stops an instructor clash until "Save anyway", then records the override', async () => {
    await rule();
    const clash = await rule({ batchId: 'b_sci9', weekdays: [3], startTime: '17:00', endTime: '18:00' });
    expect(clash.statusCode).toBe(409);
    expect(clash.body.error.code).toBe('schedule_conflict');
    expect(clash.body.error.details.conflicts).toEqual([expect.objectContaining({
      kind: 'instructor', otherBatch: { id: 'b_math10', name: 'Grade 10 Maths' }, instructorName: 'Teacher A', time: '16:00–17:30', count: 2, dates: ['2030-01-09', '2030-01-16'],
    })]);
    expect(await count(state.db, "SELECT COUNT(*) AS n FROM crm_class_sessions WHERE batch_id = 'b_sci9'")).toBe(0);

    const saved = await rule({ batchId: 'b_sci9', weekdays: [3], startTime: '17:00', endTime: '18:00', acknowledgeConflicts: true });
    expect(saved.statusCode).toBe(201);
    expect(await count(state.db, "SELECT COUNT(*) AS n FROM crm_class_sessions WHERE batch_id = 'b_sci9' AND conflict_override = 1")).toBe(2);
    expect((await auditRows(state.db, 'timetable.changed'))[1].summary).toMatchObject({ conflictOverride: true });
  });

  it('detects room and batch clashes, but not back-to-back classes', async () => {
    const r1 = await room();
    await rule({ roomId: r1.id });
    const roomClash = await rule({ batchId: 'b_sci9', instructorUserId: 'usr_teacher2', roomId: r1.id, weekdays: [1] });
    expect(roomClash.body.error.details.conflicts.map((conflict) => conflict.kind)).toEqual(['room']);
    const batchClash = await rule({ instructorUserId: 'usr_teacher2', weekdays: [5], subjectId: 'sub_sci' });
    expect(batchClash.body.error.details.conflicts.map((conflict) => [conflict.kind, conflict.count])).toEqual([['batch', 2]]);
    expect((await rule({ batchId: 'b_sci9', roomId: r1.id, weekdays: [1], startTime: '17:30', endTime: '18:30' })).statusCode).toBe(201);
    // The same teacher on a different day is fine.
    expect((await rule({ batchId: 'b_sci9', weekdays: [2] })).statusCode).toBe(201);
  });

  it('warns about hours outside availability and leave', async () => {
    await call(admin, 'POST', 'classes/availability', { body: { userId: 'usr_teacher', windows: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '15:00', end: '17:00' })) } });
    await call(admin, 'POST', 'classes/availability/exceptions', { body: { userId: 'usr_teacher', startsOn: '2030-01-14', endsOn: '2030-01-14', reason: 'Leave' } });
    const warned = await rule({ startTime: '15:00', endTime: '17:00' });
    expect(warned.body.error.details).toMatchObject({ conflicts: [], availability: [{ kind: 'on_leave', reason: 'Leave', count: 1, dates: ['2030-01-14'] }] });
    const outside = await rule({ startTime: '16:00', endTime: '17:30' });
    expect(outside.body.error.details.availability).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'outside_availability', count: 5 })]));
  });

  it('reports capacity as a warning only', async () => {
    const small = await room('Small room', 1);
    const created = await rule({ roomId: small.id });
    expect(created.statusCode).toBe(201);
    expect(created.body.capacity).toEqual({ students: 2, capacity: 1 });
  });
});

describe('Editing and ending a timetable (S3, D5)', () => {
  async function setUp() {
    const created = (await rule({ validUntil: '2030-01-27' })).body.rule;
    const byDate = Object.fromEntries((await sessions()).map((session) => [session.localDate, session.id]));
    // Mon 14th was held, Wed 16th cancelled, Fri 18th hand-edited (a substitute).
    await state.db.execute({ sql: "UPDATE crm_class_sessions SET status = 'held' WHERE id = ?", args: [byDate['2030-01-14']] });
    await state.db.execute({ sql: "UPDATE crm_class_sessions SET status = 'cancelled', cancel_reason = 'Teacher unwell' WHERE id = ?", args: [byDate['2030-01-16']] });
    await state.db.execute({ sql: "UPDATE crm_class_sessions SET is_edited = 1, instructor_user_id = 'usr_teacher2' WHERE id = ?", args: [byDate['2030-01-18']] });
    return { created, byDate };
  }

  it('replaces only plain scheduled sessions from the apply-from date, as a new version', async () => {
    const { created, byDate } = await setUp();
    const edit = await call(admin, 'POST', 'classes/rules/update', {
      body: { ruleId: created.id, expectedVersion: 1, applyFrom: '2030-01-12', instructorUserId: 'usr_teacher', weekdays: [1, 3, 5], startTime: '17:00', endTime: '18:00', validUntil: '2030-01-27' },
    });
    expect(edit.statusCode).toBe(200);
    // Removed: 21st, 23rd, 25th (plain). Kept: 14th (held), 16th (cancelled), 18th (edited).
    expect(edit.body).toMatchObject({ sessionsRemoved: 3, sessionsKept: 3, sessionsCreated: 3 });
    expect(edit.body.rule).toMatchObject({ seriesId: created.id, previousRuleId: created.id, validFrom: '2030-01-12', startTime: '17:00', status: 'active' });

    const list = await sessions();
    const summary = list.map((session) => [session.localDate, session.startsAt.slice(11, 16), session.status, session.isEdited]);
    expect(summary).toEqual([
      ['2030-01-07', '10:30', 'scheduled', false], ['2030-01-09', '10:30', 'scheduled', false], ['2030-01-11', '10:30', 'scheduled', false],
      ['2030-01-14', '10:30', 'held', false], ['2030-01-16', '10:30', 'cancelled', false], ['2030-01-18', '10:30', 'scheduled', true],
      ['2030-01-21', '11:30', 'scheduled', false], ['2030-01-23', '11:30', 'scheduled', false], ['2030-01-25', '11:30', 'scheduled', false],
    ]);
    expect(list.find((session) => session.localDate === '2030-01-07').id).toBe(byDate['2030-01-07']);

    const rules = (await call(admin, 'GET', 'classes/rules', { query: { batchId: 'b_math10' } })).body.items;
    expect(rules.map((item) => [item.status, item.validFrom, item.validUntil])).toEqual([['active', '2030-01-12', '2030-01-27'], ['ended', MON, '2030-01-11']]);
    expect((await auditRows(state.db, 'timetable.changed'))[1].summary).toMatchObject({ change: 'updated', previousRuleId: created.id, applyFrom: '2030-01-12', sessionsRemoved: 3, sessionsKept: 3 });

    // The closed version can't be edited again, and stale versions are refused.
    const again = { ruleId: created.id, expectedVersion: 1, applyFrom: '2030-01-20', instructorUserId: 'usr_teacher', weekdays: [1], startTime: '09:00', endTime: '10:00', validUntil: '2030-01-27' };
    expect((await call(admin, 'POST', 'classes/rules/update', { body: again })).body.error.code).toBe('rule_ended');
  });

  it('refuses an apply-from date before the timetable started and a stale version', async () => {
    const created = (await rule()).body.rule;
    const body = { ruleId: created.id, expectedVersion: 1, applyFrom: '2030-01-01', instructorUserId: 'usr_teacher', weekdays: [2], startTime: '16:00', endTime: '17:00', validUntil: '2030-01-20' };
    expect((await call(admin, 'POST', 'classes/rules/update', { body })).body.error.details[0].path).toBe('applyFrom');
    expect((await call(admin, 'POST', 'classes/rules/update', { body: { ...body, applyFrom: MON, expectedVersion: 2 } })).statusCode).toBe(409);
  });

  it('ends a timetable, removing only later plain sessions', async () => {
    const { created } = await setUp();
    const ended = await call(admin, 'POST', 'classes/rules/end', { body: { ruleId: created.id, expectedVersion: 1, lastDate: '2030-01-13' } });
    expect(ended.body).toMatchObject({ sessionsRemoved: 3, rule: { status: 'ended', validUntil: '2030-01-13' } });
    expect((await sessions()).map((session) => session.localDate)).toEqual(['2030-01-07', '2030-01-09', '2030-01-11', '2030-01-14', '2030-01-16', '2030-01-18']);
  });
});

describe('Sessions list and one-off classes (S3)', () => {
  it('filters by batch, instructor, room and "mine", within two months at a time', async () => {
    const r1 = await room();
    await rule({ roomId: r1.id });
    await rule({ batchId: 'b_sci9', instructorUserId: 'usr_teacher2', weekdays: [2] });
    expect((await sessions({ batchId: 'b_sci9' })).length).toBe(2);
    expect((await sessions({ instructorId: 'usr_teacher2' })).length).toBe(2);
    expect((await sessions({ roomId: r1.id })).length).toBe(6);
    const mine = (await call(teacher, 'GET', 'classes/sessions', { query: { from: '2030-01-01', to: '2030-01-31', mine: '1' } })).body.items;
    expect(mine).toHaveLength(6);
    expect(mine.every((session) => session.isMine)).toBe(true);
    expect((await call(admin, 'GET', 'classes/sessions', { query: { from: '2030-01-01', to: '2030-04-01' } })).statusCode).toBe(422);
    expect((await call(otherAdmin, 'GET', 'classes/sessions', { query: { from: '2030-01-01', to: '2030-01-31' } })).body.items).toEqual([]);
  });

  it('adds a one-off class with the same clash checks', async () => {
    await rule();
    const extra = await call(admin, 'POST', 'classes/sessions', { body: { batchId: 'b_math10', instructorUserId: 'usr_teacher', localDate: '2030-01-12', startTime: '10:00', endTime: '12:00' } });
    expect(extra.statusCode).toBe(201);
    expect(extra.body.session).toMatchObject({ localDate: '2030-01-12', ruleId: null, startsAt: '2030-01-12T04:30:00.000Z' });
    const clash = await call(admin, 'POST', 'classes/sessions', { body: { batchId: 'b_sci9', instructorUserId: 'usr_teacher', localDate: '2030-01-07', startTime: '16:30', endTime: '17:00' } });
    expect(clash.body.error.code).toBe('schedule_conflict');
    expect((await auditRows(state.db, 'session.changed'))[0]).toMatchObject({ entity_type: 'class_session', summary: { change: 'created', batchId: 'b_math10', localDate: '2030-01-12' } });
  });
});
