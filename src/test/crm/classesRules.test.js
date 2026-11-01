// Shared class rules (FLKRM-327 S1): dates, durations and name keys.
import { describe, expect, it } from 'vitest';
import { addDuration, batchBody, courseBody, isDateOnly, nameKey } from '../../../shared/crm/classes.js';

describe('class rules', () => {
  it('accepts only real calendar dates', () => {
    expect(isDateOnly('2026-02-28')).toBe(true);
    expect(isDateOnly('2026-02-30')).toBe(false);
    expect(isDateOnly('2026-2-3')).toBe(false);
    expect(isDateOnly('')).toBe(false);
  });

  it('adds a course duration to a start date, ending the day before', () => {
    expect(addDuration('2026-06-15', 10, 'months')).toBe('2027-04-14');
    expect(addDuration('2026-10-10', 12, 'weeks')).toBe('2027-01-01');
    expect(addDuration('2026-06-01', 1, 'years')).toBe('2027-05-31');
    expect(addDuration('', 1, 'years')).toBe('');
  });

  it('compares names without case or extra spaces', () => {
    expect(nameKey('  Grade 10   Maths ')).toBe(nameKey('grade 10 maths'));
  });

  it('pairs duration value and unit, and orders batch dates', () => {
    expect(courseBody.safeParse({ name: 'X', durationValue: 3 }).success).toBe(false);
    expect(courseBody.safeParse({ name: 'X', durationValue: 3, durationUnit: 'weeks' }).success).toBe(true);
    expect(batchBody.safeParse({ name: 'B', academicYearId: 'ay', startsOn: '2026-07-01', endsOn: '2026-06-30' }).success).toBe(false);
    expect(batchBody.safeParse({ name: 'B', academicYearId: 'ay', defaultOnlineUrl: 'meet.google.com/x' }).success).toBe(false);
  });
});
