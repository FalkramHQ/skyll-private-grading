// Attendance rules shared by the CRM server and UI (FLKRM-327 S5/S6, D8–D11).
import { z } from 'zod';
import { addDays } from './time.js';

/** Statuses staff can mark today (D8). */
export const MARKABLE_STATUSES = Object.freeze(['present', 'absent', 'late', 'excused']);
/** Every value the table may hold; `make_up` is reserved for CRM-028 and has no UI yet. */
export const ATTENDANCE_STATUSES = Object.freeze([...MARKABLE_STATUSES, 'make_up']);

export const STATUS_LABELS = Object.freeze({ present: 'Present', absent: 'Absent', late: 'Late', excused: 'Excused', make_up: 'Make-up' });
export const STATUS_SHORT = Object.freeze({ present: 'P', absent: 'A', late: 'L', excused: 'E', make_up: 'M' });

/** Why a saved mark changed (D9). "Other" needs a short note. */
export const CORRECTION_REASONS = Object.freeze([
  { key: 'marked_by_mistake', label: 'Marked by mistake' },
  { key: 'arrived_late', label: 'Arrived late' },
  { key: 'excuse_received', label: 'Excuse received' },
  { key: 'other', label: 'Other' },
]);

export function correctionReasonText(reasonKey, reasonNote) {
  const reason = CORRECTION_REASONS.find((item) => item.key === reasonKey);
  if (!reason) return reasonNote || '';
  return reasonKey === 'other' ? `Other: ${String(reasonNote || '').trim()}` : reason.label;
}

/** A sheet locks this many days after the class for own-class markers (D9). */
export const LOCK_DAYS = 7;

/** 'not_yet' before the class's day, 'locked' after the lock, otherwise 'open' (school-local dates). */
export function markingWindow(sessionDate, today) {
  if (today < sessionDate) return 'not_yet';
  if (today > addDays(sessionDate, LOCK_DAYS)) return 'locked';
  return 'open';
}

const id = z.string().trim().min(1).max(128);

const markInput = z.object({
  studentId: id,
  status: z.enum(MARKABLE_STATUSES),
  note: z.string().trim().max(200, 'Keep notes under 200 characters').optional(),
  // The version the sheet showed for an already-saved mark.
  expectedVersion: z.coerce.number().int().positive().optional(),
  reasonKey: z.enum(CORRECTION_REASONS.map((reason) => reason.key)).optional(),
  reasonNote: z.string().trim().max(200).optional(),
}).strict().refine((mark) => mark.reasonKey !== 'other' || Boolean(mark.reasonNote), { message: 'Say why the mark changed', path: ['reasonNote'] });

/** One whole session per save (D10). */
export const markBody = z.object({
  sessionId: id,
  marks: z.array(markInput).min(1, 'Mark at least one student').max(500),
}).strict().refine((body) => new Set(body.marks.map((mark) => mark.studentId)).size === body.marks.length, { message: 'Each student once', path: ['marks'] });

/** Counts by status. */
export function tally(statuses) {
  const counts = { present: 0, absent: 0, late: 0, excused: 0 };
  for (const status of statuses) if (status in counts) counts[status] += 1;
  return counts;
}

/**
 * The one attendance formula (D11): (present + late) ÷ (present + late +
 * absent), as a whole percent. Excused, cancelled and unmarked classes are
 * left out. Null when nothing counts yet.
 */
export function attendancePercent({ present = 0, late = 0, absent = 0 }) {
  const counted = present + late + absent;
  return counted ? Math.round(((present + late) / counted) * 100) : null;
}
