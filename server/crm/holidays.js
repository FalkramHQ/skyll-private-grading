// School holidays (FLKRM-327 S4, D6). Timetable generation skips them, and
// adding one cancels the scheduled classes on those dates with the reason
// "Holiday: <label>". Removing a holiday never brings classes back: some may
// have been cancelled on purpose, so staff re-add or undo them by hand.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { datesInRange, holidayBody } from '../../shared/crm/timetable.js';
import { addDays, localDate } from '../../shared/crm/time.js';
import { auditStatement } from './audit.js';
import { CrmHttpError, crmErrors } from './errors.js';

const newId = (prefix) => `${prefix}_${randomUUID()}`;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export { holidayBody };
export const holidayImpactQuery = z.object({ startsOn: z.string().regex(DATE), endsOn: z.string().regex(DATE) });
export const removeHolidayBody = z.object({ holidayId: z.string().trim().min(1).max(128) }).strict();

/** Dates the school is closed between `from` and `to` (inclusive), for generation. */
export async function closedDates(db, scope, from, to) {
  const result = await db.execute({
    sql: 'SELECT starts_on, ends_on FROM crm_holidays WHERE school_id = ? AND removed_at IS NULL AND starts_on <= ? AND ends_on >= ?',
    args: [scope.schoolId, to, from],
  });
  const dates = new Set();
  for (const row of result.rows) for (const date of datesInRange(row.starts_on, row.ends_on)) if (date >= from && date <= to) dates.add(date);
  return dates;
}

function serializeHoliday(row) {
  return { id: row.id, startsOn: row.starts_on, endsOn: row.ends_on, label: row.label, createdAt: row.created_at };
}

/** Holidays from a year ago onwards. */
export async function listHolidays({ db, scope }) {
  const since = addDays(localDate(Date.now(), scope.timezone), -365);
  const result = await db.execute({
    sql: 'SELECT * FROM crm_holidays WHERE school_id = ? AND removed_at IS NULL AND ends_on >= ? ORDER BY starts_on',
    args: [scope.schoolId, since],
  });
  return { items: result.rows.map(serializeHoliday), nextCursor: null };
}

const SCHEDULED_IN_RANGE = "school_id = ? AND status = 'scheduled' AND local_date >= ? AND local_date <= ?";

/** How many scheduled classes a holiday would cancel, shown before adding it. */
export async function holidayImpact({ db, scope, input }) {
  const { startsOn, endsOn } = input.query;
  if (endsOn < startsOn) throw crmErrors.validation([{ path: 'endsOn', message: 'The last day must be on or after the first' }]);
  const result = await db.execute({
    sql: `SELECT s.batch_id, b.name AS batch_name, COUNT(*) AS n
          FROM crm_class_sessions s JOIN batches b ON b.id = s.batch_id AND b.school_id = s.school_id
          WHERE s.school_id = ? AND s.status = 'scheduled' AND s.local_date >= ? AND s.local_date <= ?
          GROUP BY s.batch_id, b.name ORDER BY b.name`,
    args: [scope.schoolId, startsOn, endsOn],
  });
  const batches = result.rows.map((row) => ({ id: row.batch_id, name: row.batch_name, sessions: Number(row.n) }));
  return { sessions: batches.reduce((sum, batch) => sum + batch.sessions, 0), batches };
}

export async function addHoliday({ db, scope, input }) {
  const { startsOn, endsOn, label } = input.body;
  const overlap = await db.execute({
    sql: 'SELECT label FROM crm_holidays WHERE school_id = ? AND removed_at IS NULL AND starts_on <= ? AND ends_on >= ? LIMIT 1',
    args: [scope.schoolId, endsOn, startsOn],
  });
  if (overlap.rows.length) throw new CrmHttpError(409, 'holiday_overlap', `These dates overlap "${overlap.rows[0].label}"`);
  const holidayId = newId('hol');
  const now = new Date().toISOString();
  const reason = `Holiday: ${label}`;
  const toCancel = await db.execute({ sql: `SELECT COUNT(*) AS n FROM crm_class_sessions WHERE ${SCHEDULED_IN_RANGE}`, args: [scope.schoolId, startsOn, endsOn] });
  const results = await db.batch([
    {
      sql: 'INSERT INTO crm_holidays (id, school_id, starts_on, ends_on, label, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      args: [holidayId, scope.schoolId, startsOn, endsOn, label, scope.actor.user_id || null, now, now],
    },
    // Held classes are never touched; only plain scheduled ones are cancelled.
    {
      sql: `UPDATE crm_class_sessions SET status = 'cancelled', cancel_reason = ?, cancelled_by = ?, cancelled_at = ?, version = version + 1, updated_at = ?
            WHERE ${SCHEDULED_IN_RANGE}`,
      args: [reason, scope.actor.user_id || null, now, now, scope.schoolId, startsOn, endsOn],
    },
    auditStatement(scope, {
      action: 'holiday.changed', entityId: scope.schoolId,
      summary: { change: 'added', holidayId, startsOn, endsOn, label, sessionsCancelled: Number(toCancel.rows[0].n) }, now,
    }),
  ], 'write');
  return { holiday: serializeHoliday({ id: holidayId, starts_on: startsOn, ends_on: endsOn, label, created_at: now }), sessionsCancelled: Number(results[1].rowsAffected) };
}

export async function removeHoliday({ db, scope, input }) {
  const found = await db.execute({ sql: 'SELECT * FROM crm_holidays WHERE id = ? AND school_id = ?', args: [input.body.holidayId, scope.schoolId] });
  const row = found.rows[0];
  if (!row) throw crmErrors.notFound();
  if (row.removed_at) throw new CrmHttpError(422, 'invalid_transition', 'This holiday was already removed');
  const now = new Date().toISOString();
  await db.batch([
    { sql: 'UPDATE crm_holidays SET removed_at = ?, updated_at = ? WHERE id = ? AND removed_at IS NULL', args: [now, now, row.id] },
    auditStatement(scope, {
      action: 'holiday.changed', entityId: scope.schoolId,
      summary: { change: 'removed', holidayId: row.id, startsOn: row.starts_on, endsOn: row.ends_on, label: row.label }, onlyIfChanged: true, now,
    }),
  ], 'write');
  return { removed: true };
}
