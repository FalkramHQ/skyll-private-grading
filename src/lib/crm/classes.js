// Client helpers for the CRM Classes section (FLKRM-327).
import { useCallback, useEffect, useState } from 'react';
import { crmFetch, newIdempotencyKey } from './api';

/** POST with a fresh idempotency key, so a double click is applied once. */
export function classesWrite(path, body) {
  return crmFetch(path, { method: 'POST', body, idempotencyKey: newIdempotencyKey() });
}

/** GET classes/options: years, subjects, active rooms and courses, program labels. */
export function useClassesOptions() {
  const [state, setState] = useState({ status: 'loading', options: null, error: null });
  const load = useCallback(async () => {
    try {
      setState({ status: 'ready', options: await crmFetch('classes/options'), error: null });
    } catch (error) {
      setState({ status: 'error', options: null, error });
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  return { ...state, reload: load };
}

/** '' → null and digits → number, for optional number inputs. */
export function numberOrNull(value) {
  const text = String(value ?? '').trim();
  return text === '' ? null : Number(text);
}

/** '' → null for optional text and select inputs. */
export function textOrNull(value) {
  const text = String(value ?? '').trim();
  return text === '' ? null : text;
}

const dayFormat = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** `YYYY-MM-DD` → "15 Jun 2026" (a calendar date, so no timezone shift). */
export function formatDay(value) {
  if (!value) return '';
  const [year, month, day] = value.split('-').map(Number);
  return dayFormat.format(new Date(Date.UTC(year, month - 1, day)));
}

export function dateRange(startsOn, endsOn) {
  if (!startsOn && !endsOn) return '';
  return `${formatDay(startsOn) || '…'} – ${formatDay(endsOn) || '…'}`;
}

const timeFormats = new Map();

/** "16:00" for a UTC instant, in the school's timezone. */
export function formatTime(iso, timeZone) {
  if (!timeFormats.has(timeZone)) {
    timeFormats.set(timeZone, new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
  }
  return timeFormats.get(timeZone).format(new Date(iso));
}

const weekdayFormat = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

/** `YYYY-MM-DD` → "Mon, 12 Oct". */
export function formatWeekday(value) {
  const [year, month, day] = value.split('-').map(Number);
  return weekdayFormat.format(new Date(Date.UTC(year, month - 1, day)));
}

/** The Monday on or before a `YYYY-MM-DD` date. */
export function mondayOf(value) {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const back = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - back);
  return date.toISOString().slice(0, 10);
}

/** Sentence-friendly "Mon 12 Oct, Wed 14 Oct and 3 more". */
export function sampleDates(dates, total) {
  const shown = dates.slice(0, 3).map(formatWeekday).join(', ');
  return total > 3 ? `${shown} and ${total - 3} more` : shown;
}
