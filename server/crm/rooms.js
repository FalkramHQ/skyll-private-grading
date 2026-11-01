// Rooms (FLKRM-327 S1, D7): a fixed per-school list so the timetable can
// detect two classes in one room. Branches come later (CRM-036).
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { nameKey, roomBody } from '../../shared/crm/classes.js';
import { auditStatement } from './audit.js';
import { assertVersionedWrite, expectedVersion } from './concurrency.js';
import { duplicateName } from './courses.js';
import { CrmHttpError, crmErrors } from './errors.js';

const roomId = z.string().trim().min(1).max(128);

export { roomBody as createRoomBody };
export const listRoomsQuery = z.object({ status: z.enum(['active', 'archived', 'all']).default('active') });
export const updateRoomBody = z.object({
  roomId,
  expectedVersion,
  name: z.string().trim().min(1, 'Enter a room name').max(60),
  seats: z.coerce.number().int().min(1, 'At least 1').max(1000).nullable().optional(),
}).strict();
export const roomStatusBody = z.object({ roomId, expectedVersion }).strict();

const ROOM_NAME_TAKEN = 'A room with this name already exists (it may be archived)';

export function serializeRoom(row) {
  return { id: row.id, name: row.name, seats: row.seats === null || row.seats === undefined ? null : Number(row.seats), status: row.status, version: Number(row.version) };
}

async function loadRoomRow(db, scope, id) {
  const result = await db.execute({ sql: 'SELECT * FROM crm_rooms WHERE id = ? AND school_id = ?', args: [id, scope.schoolId] });
  if (!result.rows[0]) throw crmErrors.notFound();
  return result.rows[0];
}

/** 422 unless `roomId` is an active room of this school. */
export async function assertActiveRoom(db, scope, roomIdValue, path = 'roomId') {
  if (!roomIdValue) return null;
  const result = await db.execute({ sql: "SELECT * FROM crm_rooms WHERE id = ? AND school_id = ? AND status = 'active'", args: [roomIdValue, scope.schoolId] });
  if (!result.rows[0]) throw crmErrors.validation([{ path, message: 'Choose one of the school\'s active rooms' }]);
  return result.rows[0];
}

export async function listRooms({ db, scope, input }) {
  const { status } = input.query;
  const result = await db.execute({
    sql: `SELECT * FROM crm_rooms WHERE school_id = ? ${status === 'all' ? '' : 'AND status = ?'} ORDER BY status = 'active' DESC, name COLLATE NOCASE`,
    args: status === 'all' ? [scope.schoolId] : [scope.schoolId, status],
  });
  return { items: result.rows.map(serializeRoom), nextCursor: null };
}

export async function createRoom({ db, scope, input }) {
  const { name, seats = null } = input.body;
  const id = `room_${randomUUID()}`;
  const now = new Date().toISOString();
  try {
    await db.batch([
      {
        sql: 'INSERT INTO crm_rooms (id, school_id, name, name_key, seats, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        args: [id, scope.schoolId, name, nameKey(name), seats, scope.actor.user_id || null, now, now],
      },
      auditStatement(scope, { action: 'room.changed', entityId: id, summary: { change: 'created', name, seats }, now }),
    ], 'write');
  } catch (error) {
    throw duplicateName(error, ROOM_NAME_TAKEN);
  }
  return serializeRoom(await loadRoomRow(db, scope, id));
}

export async function updateRoom({ db, scope, input }) {
  const { roomId: id, name, seats = null, expectedVersion: version } = input.body;
  const row = await loadRoomRow(db, scope, id);
  const now = new Date().toISOString();
  let results;
  try {
    results = await db.batch([
      {
        sql: 'UPDATE crm_rooms SET name = ?, name_key = ?, seats = ?, version = version + 1, updated_at = ? WHERE id = ? AND school_id = ? AND version = ?',
        args: [name, nameKey(name), seats, now, row.id, scope.schoolId, version],
      },
      auditStatement(scope, { action: 'room.changed', entityId: row.id, summary: { change: 'updated', name, seats }, onlyIfChanged: true, now }),
    ], 'write');
  } catch (error) {
    throw duplicateName(error, ROOM_NAME_TAKEN);
  }
  await assertVersionedWrite(results, 0, async () => (await loadRoomRow(db, scope, row.id)).version);
  return serializeRoom(await loadRoomRow(db, scope, row.id));
}

function statusHandler(to, change) {
  return async ({ db, scope, input }) => {
    const row = await loadRoomRow(db, scope, input.body.roomId);
    if (row.status === to) throw new CrmHttpError(422, 'invalid_transition', to === 'archived' ? 'This room is already archived' : 'This room is already active');
    const now = new Date().toISOString();
    const results = await db.batch([
      {
        sql: 'UPDATE crm_rooms SET status = ?, version = version + 1, updated_at = ? WHERE id = ? AND school_id = ? AND version = ?',
        args: [to, now, row.id, scope.schoolId, input.body.expectedVersion],
      },
      auditStatement(scope, { action: 'room.changed', entityId: row.id, summary: { change, name: row.name }, onlyIfChanged: true, now }),
    ], 'write');
    await assertVersionedWrite(results, 0, async () => (await loadRoomRow(db, scope, row.id)).version);
    return serializeRoom(await loadRoomRow(db, scope, row.id));
  };
}

// Archived rooms stay on past sessions but can't be chosen for new ones.
export const archiveRoom = statusHandler('archived', 'archived');
export const restoreRoom = statusHandler('active', 'restored');
