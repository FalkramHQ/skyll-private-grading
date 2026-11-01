// Task rules shared by the CRM server and UI (FLKRM-326 S2), so the task form
// validates with exactly the server's schema.
import { z } from 'zod';

export const TASK_PRIORITIES = Object.freeze(['low', 'normal', 'high']);

export const PRIORITY_LABELS = Object.freeze({ low: 'Low', normal: 'Normal', high: 'High' });

export const dueAtField = z.string().trim().max(40)
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Enter a valid date and time')
  .transform((value) => new Date(value).toISOString());

export const relatedRecord = z.object({ type: z.enum(['lead', 'student']), id: z.string().min(1).max(128) }).strict();

export const createTaskBody = z.object({
  title: z.string().trim().min(1, 'Enter what needs doing').max(160),
  details: z.string().trim().max(2000).optional(),
  dueAt: dueAtField,
  priority: z.enum(TASK_PRIORITIES).default('normal'),
  // Omitted: assigned to the creator. `null`: unassigned (school-wide access only).
  ownerUserId: z.string().trim().min(1).max(128).nullable().optional(),
  related: relatedRecord.optional(),
}).strict();
