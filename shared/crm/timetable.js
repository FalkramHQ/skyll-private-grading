// Timetable rules shared by the CRM server and UI (FLKRM-327 S3, D5). A rule
// is a weekly slot in school wall-clock time; each matching date becomes a
// session whose UTC start/end come from the school's timezone.
import { z } from 'zod';
import { isoWeekday, timeToMinutes } from './availability.js';
import { dateOnly, onlineUrl } from './classes.js';
import { zonedTimeToUtcMs } from './time.js';

/** A rule covers at most a year (D5). */
export const MAX_RULE_DAYS = 366;

const DAY_MS = 86_400_000;

function dateMs(value) {
  const [year, month, day] = value.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

export function daysBetween(from, to) {
  return Math.round((dateMs(to) - dateMs(from)) / DAY_MS);
}

/** Every date in `[validFrom, validUntil]` on one of `weekdays` (ISO), minus `skipDates`. */
export function ruleDates({ weekdays, validFrom, validUntil, skipDates = new Set() }) {
  const wanted = new Set(weekdays.map(Number));
  const dates = [];
  for (let ms = dateMs(validFrom); ms <= dateMs(validUntil); ms += DAY_MS) {
    const date = new Date(ms).toISOString().slice(0, 10);
    if (wanted.has(isoWeekday(date)) && !skipDates.has(date)) dates.push(date);
  }
  return dates;
}

/** UTC start and end of a session on `localDate` from wall-clock `HH:MM` times. */
export function sessionWindow(localDate, startTime, endTime, timeZone) {
  const [year, month, day] = localDate.split('-').map(Number);
  const at = (time) => {
    const minutes = timeToMinutes(time);
    return new Date(zonedTimeToUtcMs({ year, month, day, hour: Math.floor(minutes / 60), minute: minutes % 60 }, timeZone)).toISOString();
  };
  return { startsAt: at(startTime), endsAt: at(endTime) };
}

/** Half-open overlap: a class ending at 17:00 doesn't clash with one starting at 17:00. */
export function intervalsOverlap(a, b) {
  return a.startsAt < b.endsAt && b.startsAt < a.endsAt;
}

const id = z.string().trim().min(1).max(128);
const time = z.string().trim().refine((value) => timeToMinutes(value) !== null && value !== '24:00', 'Enter a time like 16:30');
const weekdays = z.array(z.coerce.number().int().min(1).max(7)).min(1, 'Choose at least one day').max(7)
  .refine((days) => new Set(days).size === days.length, 'Each day once');

const endAfterStart = { message: 'The end must be after the start', path: ['endTime'] };
const startBeforeEnd = (body) => timeToMinutes(body.endTime) > timeToMinutes(body.startTime);

const slotFields = {
  subjectId: id.nullable().optional(),
  instructorUserId: z.string().trim().min(1, 'Choose an instructor').max(128),
  weekdays,
  startTime: time,
  endTime: time,
  roomId: id.nullable().optional(),
  onlineUrl: onlineUrl.nullable().optional(),
  validUntil: dateOnly,
  // Set after staff saw the clash / availability panel and chose "Save anyway" (D7).
  acknowledgeConflicts: z.boolean().optional(),
};

export const ruleBody = z.object({ batchId: id, validFrom: dateOnly, ...slotFields }).strict()
  .refine(startBeforeEnd, endAfterStart)
  .refine((body) => body.validUntil >= body.validFrom, { message: 'The last date must be on or after the first', path: ['validUntil'] })
  .refine((body) => daysBetween(body.validFrom, body.validUntil) < MAX_RULE_DAYS, { message: 'A timetable can run for at most a year', path: ['validUntil'] });

// Editing applies from `applyFrom`; earlier sessions are never touched (D5).
export const updateRuleBody = z.object({ ruleId: id, expectedVersion: z.coerce.number().int().positive(), applyFrom: dateOnly, ...slotFields }).strict()
  .refine(startBeforeEnd, endAfterStart)
  .refine((body) => body.validUntil >= body.applyFrom, { message: 'The last date must be on or after the change date', path: ['validUntil'] })
  .refine((body) => daysBetween(body.applyFrom, body.validUntil) < MAX_RULE_DAYS, { message: 'A timetable can run for at most a year', path: ['validUntil'] });

// Ending keeps sessions up to and including `lastDate`.
export const endRuleBody = z.object({ ruleId: id, expectedVersion: z.coerce.number().int().positive(), lastDate: dateOnly }).strict();

export const oneOffSessionBody = z.object({
  batchId: id,
  subjectId: id.nullable().optional(),
  instructorUserId: z.string().trim().min(1, 'Choose an instructor').max(128),
  localDate: dateOnly,
  startTime: time,
  endTime: time,
  roomId: id.nullable().optional(),
  onlineUrl: onlineUrl.nullable().optional(),
  acknowledgeConflicts: z.boolean().optional(),
}).strict().refine(startBeforeEnd, endAfterStart);

// ---------------------------------------------------------------- S4 --

/** Cancelling a class needs a reason (D6). */
export const cancelSessionBody = z.object({
  sessionId: id,
  expectedVersion: z.coerce.number().int().positive(),
  reason: z.string().trim().min(1, 'Say why, for example "Teacher unwell"').max(280),
}).strict();

export const restoreSessionBody = z.object({
  sessionId: id,
  expectedVersion: z.coerce.number().int().positive(),
  acknowledgeConflicts: z.boolean().optional(),
}).strict();

// A substitute and/or a different room or link for one class; never its time (D6).
export const updateSessionBody = z.object({
  sessionId: id,
  expectedVersion: z.coerce.number().int().positive(),
  instructorUserId: z.string().trim().min(1, 'Choose an instructor').max(128),
  roomId: id.nullable().optional(),
  onlineUrl: onlineUrl.nullable().optional(),
  acknowledgeConflicts: z.boolean().optional(),
}).strict();

/** A holiday is one day or a range of at most three months. */
export const MAX_HOLIDAY_DAYS = 92;

export const holidayBody = z.object({
  startsOn: dateOnly,
  endsOn: dateOnly,
  label: z.string().trim().min(1, 'Name the holiday, for example "Diwali"').max(60),
}).strict()
  .refine((body) => body.endsOn >= body.startsOn, { message: 'The last day must be on or after the first', path: ['endsOn'] })
  .refine((body) => daysBetween(body.startsOn, body.endsOn) < MAX_HOLIDAY_DAYS, { message: 'A holiday can be at most three months long', path: ['endsOn'] });

/** Every date from `startsOn` to `endsOn`, inclusive. */
export function datesInRange(startsOn, endsOn) {
  const dates = [];
  for (let ms = dateMs(startsOn); ms <= dateMs(endsOn); ms += DAY_MS) dates.push(new Date(ms).toISOString().slice(0, 10));
  return dates;
}
