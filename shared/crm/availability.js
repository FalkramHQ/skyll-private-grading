// Instructor availability rules shared by the CRM server and UI (FLKRM-327 S2,
// D4). Windows and exceptions are wall-clock times in the school's timezone.
// ISO weekdays: 1 = Monday … 7 = Sunday.
import { z } from 'zod';
import { dateOnly } from './classes.js';

export const WEEKDAYS = Object.freeze([1, 2, 3, 4, 5, 6, 7]);
export const WEEKDAY_SHORT = Object.freeze({ 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat', 7: 'Sun' });
export const WEEKDAY_LONG = Object.freeze({ 1: 'Monday', 2: 'Tuesday', 3: 'Wednesday', 4: 'Thursday', 5: 'Friday', 6: 'Saturday', 7: 'Sunday' });

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** 'HH:MM' → minutes from midnight; '24:00' is accepted as an end of day. */
export function timeToMinutes(value) {
  if (value === '24:00') return 1440;
  const match = TIME.exec(String(value || ''));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

export function minutesToTime(minutes) {
  const value = Number(minutes);
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

/** ISO weekday (1 = Monday) of a `YYYY-MM-DD` calendar date. */
export function isoWeekday(localDate) {
  const [year, month, day] = localDate.split('-').map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

const timeField = z.string().trim().refine((value) => timeToMinutes(value) !== null && value !== '24:00', 'Enter a time like 16:30');
const endField = z.string().trim().refine((value) => timeToMinutes(value) !== null, 'Enter a time like 18:00');

export const windowInput = z.object({
  weekday: z.coerce.number().int().min(1).max(7),
  start: timeField,
  end: endField,
}).strict().refine((window) => timeToMinutes(window.end) > timeToMinutes(window.start), { message: 'The end must be after the start', path: ['end'] });

function overlapsOnSameDay(windows) {
  const sorted = [...windows].sort((a, b) => a.weekday - b.weekday || timeToMinutes(a.start) - timeToMinutes(b.start));
  return sorted.some((window, index) => index > 0 && sorted[index - 1].weekday === window.weekday
    && timeToMinutes(window.start) < timeToMinutes(sorted[index - 1].end));
}

export const availabilityBody = z.object({
  userId: z.string().trim().min(1).max(128),
  windows: z.array(windowInput).max(50),
}).strict().refine((body) => !overlapsOnSameDay(body.windows), { message: 'Two windows on the same day overlap', path: ['windows'] });

export const exceptionBody = z.object({
  userId: z.string().trim().min(1).max(128),
  startsOn: dateOnly,
  endsOn: dateOnly,
  // Both blank = whole days.
  start: timeField.nullable().optional(),
  end: endField.nullable().optional(),
  reason: z.string().trim().min(1, 'Add a short reason, like "Leave"').max(80),
}).strict()
  .refine((body) => body.endsOn >= body.startsOn, { message: 'The last day must be on or after the first', path: ['endsOn'] })
  .refine((body) => Boolean(body.start) === Boolean(body.end), { message: 'Enter both times, or neither for whole days', path: ['end'] })
  .refine((body) => !body.start || timeToMinutes(body.end) > timeToMinutes(body.start), { message: 'The end must be after the start', path: ['end'] });

/**
 * "Mon–Fri 15:00–20:00 · Sat 09:00–13:00". Days with identical windows are
 * grouped when they are consecutive.
 */
export function summarizeWindows(windows = []) {
  if (!windows.length) return 'Always available';
  const byDay = new Map();
  for (const window of windows) {
    const key = Number(window.weekday);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push([Number(window.startMinute), Number(window.endMinute)]);
  }
  const days = [...byDay.keys()].sort((a, b) => a - b).map((day) => ({
    day,
    text: byDay.get(day).sort((a, b) => a[0] - b[0]).map(([start, end]) => `${minutesToTime(start)}–${minutesToTime(end)}`).join(', '),
  }));
  const groups = [];
  for (const entry of days) {
    const last = groups[groups.length - 1];
    if (last && last.text === entry.text && last.to === entry.day - 1) last.to = entry.day;
    else groups.push({ from: entry.day, to: entry.day, text: entry.text });
  }
  return groups.map((group) => {
    const span = group.from === group.to ? WEEKDAY_SHORT[group.from] : `${WEEKDAY_SHORT[group.from]}–${WEEKDAY_SHORT[group.to]}`;
    return `${span} ${group.text}`;
  }).join(' · ');
}

/**
 * Why `[startMinute, endMinute)` on `localDate` doesn't suit an instructor,
 * or null when it does. `windows` / `exceptions` use minutes (DB shape).
 * - `on_leave`: an active exception covers any part of the slot.
 * - `outside_availability`: they have weekly windows and none covers the slot.
 */
export function availabilityIssue({ windows = [], exceptions = [] }, { localDate, startMinute, endMinute }) {
  const leave = exceptions.find((exception) => !exception.removedAt
    && exception.startsOn <= localDate && exception.endsOn >= localDate
    && (exception.startMinute === null || exception.startMinute === undefined
      || (Number(exception.startMinute) < endMinute && Number(exception.endMinute) > startMinute)));
  if (leave) return { kind: 'on_leave', reason: leave.reason, exceptionId: leave.id || null };
  if (!windows.length) return null;
  const weekday = isoWeekday(localDate);
  const covered = windows.some((window) => Number(window.weekday) === weekday
    && Number(window.startMinute) <= startMinute && Number(window.endMinute) >= endMinute);
  return covered ? null : { kind: 'outside_availability' };
}
