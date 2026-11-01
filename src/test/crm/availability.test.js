// Instructor availability rules (FLKRM-327 S2, D4).
import { describe, expect, it } from 'vitest';
import {
  availabilityBody, availabilityIssue, exceptionBody, isoWeekday, minutesToTime, summarizeWindows, timeToMinutes,
} from '../../../shared/crm/availability.js';

const w = (weekday, start, end) => ({ weekday, startMinute: timeToMinutes(start), endMinute: timeToMinutes(end) });

describe('availability rules', () => {
  it('converts times and weekdays', () => {
    expect(timeToMinutes('16:30')).toBe(990);
    expect(timeToMinutes('24:00')).toBe(1440);
    expect(timeToMinutes('7:30')).toBeNull();
    expect(minutesToTime(990)).toBe('16:30');
    expect(isoWeekday('2026-10-12')).toBe(1); // Monday
    expect(isoWeekday('2026-10-18')).toBe(7); // Sunday
  });

  it('summarises weekly windows, grouping identical consecutive days', () => {
    expect(summarizeWindows([])).toBe('Always available');
    const windows = [1, 2, 3, 4, 5].map((day) => w(day, '15:00', '20:00'));
    windows.push(w(6, '09:00', '13:00'), w(6, '14:00', '16:00'));
    expect(summarizeWindows(windows)).toBe('Mon–Fri 15:00–20:00 · Sat 09:00–13:00, 14:00–16:00');
    expect(summarizeWindows([w(1, '10:00', '12:00'), w(3, '10:00', '12:00')])).toBe('Mon 10:00–12:00 · Wed 10:00–12:00');
  });

  it('treats no windows as always available, and checks the whole slot fits a window', () => {
    const slot = { localDate: '2026-10-12', startMinute: timeToMinutes('16:00'), endMinute: timeToMinutes('17:30') };
    expect(availabilityIssue({}, slot)).toBeNull();
    expect(availabilityIssue({ windows: [w(1, '15:00', '20:00')] }, slot)).toBeNull();
    expect(availabilityIssue({ windows: [w(1, '16:30', '20:00')] }, slot)).toEqual({ kind: 'outside_availability' });
    expect(availabilityIssue({ windows: [w(2, '15:00', '20:00')] }, slot)).toEqual({ kind: 'outside_availability' });
  });

  it('flags leave over whole days or an overlapping time range, ignoring removed leave', () => {
    const slot = { localDate: '2026-10-14', startMinute: 960, endMinute: 1050 };
    const leave = { id: 'ex1', startsOn: '2026-10-13', endsOn: '2026-10-15', startMinute: null, endMinute: null, reason: 'Leave' };
    expect(availabilityIssue({ exceptions: [leave] }, slot)).toEqual({ kind: 'on_leave', reason: 'Leave', exceptionId: 'ex1' });
    expect(availabilityIssue({ exceptions: [{ ...leave, removedAt: '2026-10-01' }] }, slot)).toBeNull();
    const morning = { ...leave, startMinute: 540, endMinute: 720, reason: 'Training' };
    expect(availabilityIssue({ exceptions: [morning] }, slot)).toBeNull();
    expect(availabilityIssue({ exceptions: [{ ...morning, endMinute: 970 }] }, slot)?.kind).toBe('on_leave');
  });

  it('validates window sets and leave', () => {
    expect(availabilityBody.safeParse({ userId: 'u', windows: [{ weekday: 1, start: '15:00', end: '18:00' }, { weekday: 1, start: '17:00', end: '19:00' }] }).success).toBe(false);
    expect(availabilityBody.safeParse({ userId: 'u', windows: [{ weekday: 1, start: '15:00', end: '18:00' }, { weekday: 1, start: '18:00', end: '24:00' }] }).success).toBe(true);
    expect(availabilityBody.safeParse({ userId: 'u', windows: [{ weekday: 8, start: '15:00', end: '18:00' }] }).success).toBe(false);
    expect(exceptionBody.safeParse({ userId: 'u', startsOn: '2026-10-14', endsOn: '2026-10-13', reason: 'Leave' }).success).toBe(false);
    expect(exceptionBody.safeParse({ userId: 'u', startsOn: '2026-10-14', endsOn: '2026-10-14', start: '09:00', reason: 'Leave' }).success).toBe(false);
    expect(exceptionBody.safeParse({ userId: 'u', startsOn: '2026-10-14', endsOn: '2026-10-14', reason: ' ' }).success).toBe(false);
    expect(exceptionBody.safeParse({ userId: 'u', startsOn: '2026-10-14', endsOn: '2026-10-14', start: '09:00', end: '12:00', reason: 'Training' }).success).toBe(true);
  });
});
