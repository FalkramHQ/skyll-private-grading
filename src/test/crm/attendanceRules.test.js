// Attendance rules (FLKRM-327 S5/S6, D8–D11): statuses, correction reasons,
// when a sheet opens and locks, and the one attendance formula.
import { describe, expect, it } from 'vitest';
import {
  ATTENDANCE_STATUSES, LOCK_DAYS, MARKABLE_STATUSES, attendancePercent, correctionReasonText, markBody, markingWindow, tally,
} from '../../../shared/crm/attendance.js';

describe('statuses', () => {
  it('marks four statuses now and reserves make_up', () => {
    expect(MARKABLE_STATUSES).toEqual(['present', 'absent', 'late', 'excused']);
    expect(ATTENDANCE_STATUSES).toContain('make_up');
    expect(markBody.safeParse({ sessionId: 's', marks: [{ studentId: 'a', status: 'make_up' }] }).success).toBe(false);
    expect(markBody.safeParse({ sessionId: 's', marks: [{ studentId: 'a', status: 'cancelled' }] }).success).toBe(false);
  });
});

describe('markBody', () => {
  const mark = (overrides = {}) => ({ studentId: 'a', status: 'present', ...overrides });

  it('accepts a whole class and rejects duplicates or an empty sheet', () => {
    expect(markBody.safeParse({ sessionId: 's', marks: [mark(), mark({ studentId: 'b', status: 'late', note: 'Bus' })] }).success).toBe(true);
    expect(markBody.safeParse({ sessionId: 's', marks: [mark(), mark()] }).success).toBe(false);
    expect(markBody.safeParse({ sessionId: 's', marks: [] }).success).toBe(false);
  });

  it('needs a note when the correction reason is "other"', () => {
    expect(markBody.safeParse({ sessionId: 's', marks: [mark({ expectedVersion: 1, reasonKey: 'other' })] }).success).toBe(false);
    expect(markBody.safeParse({ sessionId: 's', marks: [mark({ expectedVersion: 1, reasonKey: 'other', reasonNote: 'Parent called' })] }).success).toBe(true);
    expect(markBody.safeParse({ sessionId: 's', marks: [mark({ expectedVersion: 1, reasonKey: 'arrived_late' })] }).success).toBe(true);
    expect(markBody.safeParse({ sessionId: 's', marks: [mark({ note: 'x'.repeat(201) })] }).success).toBe(false);
  });

  it('turns a reason into readable text for the audit log', () => {
    expect(correctionReasonText('arrived_late')).toBe('Arrived late');
    expect(correctionReasonText('other', 'Parent called')).toBe('Other: Parent called');
  });
});

describe('markingWindow', () => {
  it('opens on the day of the class and locks seven days later', () => {
    expect(LOCK_DAYS).toBe(7);
    expect(markingWindow('2030-01-14', '2030-01-13')).toBe('not_yet');
    expect(markingWindow('2030-01-14', '2030-01-14')).toBe('open');
    expect(markingWindow('2030-01-14', '2030-01-21')).toBe('open');
    expect(markingWindow('2030-01-14', '2030-01-22')).toBe('locked');
  });
});

describe('attendancePercent and tally', () => {
  it('counts late as attended and leaves excused out', () => {
    expect(attendancePercent({ present: 7, late: 1, absent: 2, excused: 5 })).toBe(80);
    expect(attendancePercent({ present: 0, late: 0, absent: 0, excused: 3 })).toBeNull();
    expect(attendancePercent({ present: 2, late: 0, absent: 1 })).toBe(67);
  });

  it('tallies marks by status', () => {
    expect(tally(['present', 'late', 'present', 'absent', 'excused'])).toEqual({ present: 2, absent: 1, late: 1, excused: 1 });
  });
});
