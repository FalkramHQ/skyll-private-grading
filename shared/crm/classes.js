// Course, batch and room rules shared by the CRM server and UI (FLKRM-327 S1),
// so the forms validate with exactly the server's schemas.
import { z } from 'zod';

export const DELIVERY_MODES = Object.freeze(['classroom', 'online', 'hybrid']);
export const DELIVERY_MODE_LABELS = Object.freeze({ classroom: 'Classroom', online: 'Online', hybrid: 'Hybrid' });

export const DURATION_UNITS = Object.freeze(['weeks', 'months', 'years']);
export const DURATION_UNIT_LABELS = Object.freeze({ weeks: 'weeks', months: 'months', years: 'years' });

/** Case- and space-insensitive key for "is this name taken?". */
export function nameKey(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` that is a real calendar date. */
export function isDateOnly(value) {
  if (!DATE.test(String(value || ''))) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export const dateOnly = z.string().trim().refine(isDateOnly, 'Enter a valid date');

/** Adds a course duration to a `YYYY-MM-DD` date (the day before the same date N units later). */
export function addDuration(startsOn, value, unit) {
  if (!isDateOnly(startsOn) || !value || !DURATION_UNITS.includes(unit)) return '';
  const [year, month, day] = startsOn.split('-').map(Number);
  let end;
  if (unit === 'weeks') end = new Date(Date.UTC(year, month - 1, day + value * 7));
  else if (unit === 'months') end = new Date(Date.UTC(year, month - 1 + value, day));
  else end = new Date(Date.UTC(year + value, month - 1, day));
  end.setUTCDate(end.getUTCDate() - 1);
  return end.toISOString().slice(0, 10);
}

const id = z.string().trim().min(1).max(128);
const optionalId = id.nullable().optional();
const optionalText = (max) => z.string().trim().max(max).optional().transform((value) => value || null);

export const onlineUrl = z.string().trim().max(500)
  .refine((value) => /^https?:\/\/\S+$/i.test(value), 'Enter a full link starting with https://');

const courseFields = {
  name: z.string().trim().min(1, 'Enter a course name').max(120),
  program: optionalText(60),
  subjectId: optionalId,
  level: optionalText(40),
  durationValue: z.coerce.number().int().min(1, 'At least 1').max(520).nullable().optional(),
  durationUnit: z.enum(DURATION_UNITS).nullable().optional(),
  deliveryMode: z.enum(DELIVERY_MODES).default('classroom'),
  academicYearId: optionalId,
  description: optionalText(500),
};

const durationPaired = (body) => Boolean(body.durationValue) === Boolean(body.durationUnit);
const durationMessage = { message: 'Enter both a number and a unit for the duration', path: ['durationValue'] };

export const courseBody = z.object(courseFields).strict().refine(durationPaired, durationMessage);

export const updateCourseBody = z.object({
  courseId: id,
  expectedVersion: z.coerce.number().int().positive(),
  ...courseFields,
}).strict().refine(durationPaired, durationMessage);

const batchFields = {
  name: z.string().trim().min(1, 'Enter a batch name').max(120),
  courseId: optionalId,
  academicYearId: z.string().trim().min(1, 'Choose an academic year').max(128),
  grade: optionalText(40),
  subjectId: optionalId,
  startsOn: dateOnly.nullable().optional(),
  endsOn: dateOnly.nullable().optional(),
  capacity: z.coerce.number().int().min(1, 'At least 1').max(1000).nullable().optional(),
  defaultRoomId: optionalId,
  defaultOnlineUrl: onlineUrl.nullable().optional(),
};

const datesInOrder = (body) => !body.startsOn || !body.endsOn || body.endsOn >= body.startsOn;
const datesMessage = { message: 'The end date must be on or after the start date', path: ['endsOn'] };

export const batchBody = z.object(batchFields).strict().refine(datesInOrder, datesMessage);

// `expectedVersion` is the CRM settings version; 0 when the batch has never
// been edited in the CRM (no settings row yet).
export const updateBatchBody = z.object({
  batchId: id,
  expectedVersion: z.coerce.number().int().min(0),
  ...batchFields,
}).strict().refine(datesInOrder, datesMessage);

export const roomBody = z.object({
  name: z.string().trim().min(1, 'Enter a room name').max(60),
  seats: z.coerce.number().int().min(1, 'At least 1').max(1000).nullable().optional(),
}).strict();
