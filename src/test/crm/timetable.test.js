// Timetable generation rules (FLKRM-327 S3, D5): which dates a rule produces
// and the exact UTC times of each session, in the school's timezone.
import { describe, expect, it } from 'vitest';
import {
  MAX_RULE_DAYS, daysBetween, intervalsOverlap, oneOffSessionBody, ruleBody, ruleDates, sessionWindow, updateRuleBody,
} from '../../../shared/crm/timetable.js';

describe('ruleDates', () => {
  it('returns every matching weekday in the inclusive range, in order', () => {
    // 12 Oct 2026 is a Monday.
    expect(ruleDates({ weekdays: [1, 3, 5], validFrom: '2026-10-12', validUntil: '2026-10-25' })).toEqual([
      '2026-10-12', '2026-10-14', '2026-10-16', '2026-10-19', '2026-10-21', '2026-10-23',
    ]);
    expect(ruleDates({ weekdays: [7], validFrom: '2026-10-12', validUntil: '2026-10-18' })).toEqual(['2026-10-18']);
  });

  it('skips given dates (holidays, dates a series already has)', () => {
    expect(ruleDates({ weekdays: [1, 3], validFrom: '2026-10-12', validUntil: '2026-10-21', skipDates: new Set(['2026-10-14', '2026-10-19']) }))
      .toEqual(['2026-10-12', '2026-10-21']);
  });

  it('handles month and leap-year boundaries', () => {
    expect(ruleDates({ weekdays: [7], validFrom: '2028-02-26', validUntil: '2028-03-06' })).toEqual(['2028-02-27', '2028-03-05']);
    expect(ruleDates({ weekdays: [2], validFrom: '2028-02-29', validUntil: '2028-02-29' })).toEqual(['2028-02-29']);
  });

  it('returns nothing for an empty or reversed range', () => {
    expect(ruleDates({ weekdays: [1], validFrom: '2026-10-13', validUntil: '2026-10-18' })).toEqual([]);
    expect(ruleDates({ weekdays: [1], validFrom: '2026-10-19', validUntil: '2026-10-12' })).toEqual([]);
  });

  it('produces about 156 Mon/Wed/Fri sessions in a year', () => {
    const dates = ruleDates({ weekdays: [1, 3, 5], validFrom: '2026-06-01', validUntil: '2027-05-31' });
    expect(dates.length).toBeGreaterThanOrEqual(156);
    expect(dates.length).toBeLessThanOrEqual(157);
  });
});

describe('sessionWindow', () => {
  it('converts school wall-clock times to UTC (IST is UTC+5:30)', () => {
    expect(sessionWindow('2026-10-12', '16:00', '17:30', 'Asia/Kolkata')).toEqual({
      startsAt: '2026-10-12T10:30:00.000Z', endsAt: '2026-10-12T12:00:00.000Z',
    });
    // Early-morning IST is still the previous UTC day.
    expect(sessionWindow('2026-10-12', '04:00', '05:00', 'Asia/Kolkata').startsAt).toBe('2026-10-11T22:30:00.000Z');
  });

  it('keeps the wall-clock time across a DST change in a DST timezone', () => {
    // Europe/Berlin leaves summer time on 25 Oct 2026.
    expect(sessionWindow('2026-10-24', '16:00', '17:00', 'Europe/Berlin').startsAt).toBe('2026-10-24T14:00:00.000Z');
    expect(sessionWindow('2026-10-26', '16:00', '17:00', 'Europe/Berlin').startsAt).toBe('2026-10-26T15:00:00.000Z');
  });
});

describe('helpers', () => {
  it('counts days between dates and overlaps half-open intervals', () => {
    expect(daysBetween('2026-10-01', '2026-10-31')).toBe(30);
    expect(daysBetween('2026-01-01', '2027-01-01')).toBe(365);
    const a = { startsAt: '2026-10-12T10:30:00.000Z', endsAt: '2026-10-12T12:00:00.000Z' };
    expect(intervalsOverlap(a, { startsAt: '2026-10-12T11:59:00.000Z', endsAt: '2026-10-12T13:00:00.000Z' })).toBe(true);
    // Back-to-back classes don't clash.
    expect(intervalsOverlap(a, { startsAt: '2026-10-12T12:00:00.000Z', endsAt: '2026-10-12T13:00:00.000Z' })).toBe(false);
  });
});

describe('rule schemas', () => {
  const base = { batchId: 'b', instructorUserId: 'u', weekdays: [1, 3], startTime: '16:00', endTime: '17:30', validFrom: '2026-10-12', validUntil: '2027-03-31' };

  it('accepts a sensible rule and rejects bad times, weekdays and ranges', () => {
    expect(ruleBody.safeParse(base).success).toBe(true);
    expect(ruleBody.safeParse({ ...base, endTime: '16:00' }).success).toBe(false);
    expect(ruleBody.safeParse({ ...base, weekdays: [] }).success).toBe(false);
    expect(ruleBody.safeParse({ ...base, weekdays: [1, 1] }).success).toBe(false);
    expect(ruleBody.safeParse({ ...base, validUntil: '2026-10-01' }).success).toBe(false);
    expect(ruleBody.safeParse({ ...base, validUntil: '2027-10-13' }).success).toBe(false);
    expect(MAX_RULE_DAYS).toBe(366);
  });

  it('needs an apply-from date within the new range when editing', () => {
    const edit = { ...base, ruleId: 'r', expectedVersion: 1, applyFrom: '2026-11-02' };
    delete edit.batchId;
    delete edit.validFrom;
    expect(updateRuleBody.safeParse(edit).success).toBe(true);
    expect(updateRuleBody.safeParse({ ...edit, applyFrom: '2027-04-01' }).success).toBe(false);
  });

  it('validates one-off sessions', () => {
    const one = { batchId: 'b', instructorUserId: 'u', localDate: '2026-10-17', startTime: '10:00', endTime: '12:00' };
    expect(oneOffSessionBody.safeParse(one).success).toBe(true);
    expect(oneOffSessionBody.safeParse({ ...one, endTime: '09:00' }).success).toBe(false);
  });
});
