// School-local time for CRM due dates (D12). Times are stored in UTC and shown
// and entered in the school's timezone (`schools.timezone`), so "today" and
// "overdue" mean the same thing on the server and in the browser.
export const DEFAULT_TIMEZONE = 'Asia/Kolkata';

const formatters = new Map();

function formatterFor(timeZone) {
  if (!formatters.has(timeZone)) {
    formatters.set(timeZone, new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return formatters.get(timeZone);
}

/** Wall-clock parts of `ms` in `timeZone`. */
export function zonedParts(ms, timeZone = DEFAULT_TIMEZONE) {
  const parts = Object.fromEntries(formatterFor(timeZone).formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second),
  };
}

function offsetMs(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/** UTC ms for a wall-clock time in `timeZone`. Handles DST by re-checking the offset. */
export function zonedTimeToUtcMs({ year, month, day, hour = 0, minute = 0 }, timeZone = DEFAULT_TIMEZONE) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - offsetMs(guess, timeZone);
  return guess - offsetMs(first, timeZone);
}

const LOCAL_INPUT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** `<input type="datetime-local">` value in the school's zone → UTC ISO, or null. */
export function localInputToIso(value, timeZone = DEFAULT_TIMEZONE) {
  const match = LOCAL_INPUT.exec(String(value || ''));
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number);
  return new Date(zonedTimeToUtcMs({ year, month, day, hour, minute }, timeZone)).toISOString();
}

/** UTC ISO → `<input type="datetime-local">` value in the school's zone. */
export function isoToLocalInput(iso, timeZone = DEFAULT_TIMEZONE) {
  const p = zonedParts(Date.parse(iso), timeZone);
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** UTC ms bounds of the school's current day: `[startOfToday, startOfTomorrow)`. */
export function dayBounds(nowMs = Date.now(), timeZone = DEFAULT_TIMEZONE) {
  const p = zonedParts(nowMs, timeZone);
  const start = zonedTimeToUtcMs({ year: p.year, month: p.month, day: p.day }, timeZone);
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  const end = zonedTimeToUtcMs({ year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() }, timeZone);
  return { start, end };
}

/** Where an open task sits on the dashboard: past due, due later today, or later. */
export function taskBucket(dueIso, nowMs = Date.now(), timeZone = DEFAULT_TIMEZONE) {
  const due = Date.parse(dueIso);
  if (due < nowMs) return 'overdue';
  return due < dayBounds(nowMs, timeZone).end ? 'today' : 'upcoming';
}

/** A sensible default due time: tomorrow at 10:00 school time. */
export function defaultDueInput(nowMs = Date.now(), timeZone = DEFAULT_TIMEZONE) {
  const p = zonedParts(nowMs, timeZone);
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  const pad = (n) => String(n).padStart(2, '0');
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}T10:00`;
}

/** The school-local calendar date of `nowMs` as `YYYY-MM-DD`. */
export function localDate(nowMs = Date.now(), timeZone = DEFAULT_TIMEZONE) {
  const p = zonedParts(nowMs, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** `YYYY-MM-DD` plus `days` calendar days. */
export function addDays(dateOnly, days) {
  const [year, month, day] = dateOnly.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}
