// Public inquiry form rules shared by the server and the public page
// (FLKRM-326 S6, D8, D9). The school is never part of the body: the server
// takes it from the URL slug only.
import { z } from 'zod';
import { phoneField } from './leads.js';

export const INQUIRY_LIMITS = Object.freeze({ perIpPerHour: 5, perSchoolPerHour: 50 });

export const inquiryBody = z.object({
  parentName: z.string().trim().min(1, 'Enter your name').max(120),
  parentPhone: phoneField,
  learnerName: z.string().trim().min(1, 'Enter the student’s name').max(120),
  learnerGrade: z.string().trim().max(32).optional(),
  course: z.string().trim().max(120).optional(),
  schedule: z.string().trim().max(120).optional(),
  message: z.string().trim().max(1000).optional(),
  // Required: permission for the school to contact the family about admissions.
  consent: z.literal(true, { error: 'Please agree so the school can contact you' }),
  whatsappOptIn: z.boolean().optional(),
  // Honeypot: a field people never see. Anything in it means a bot.
  website: z.string().max(200).optional(),
}).strict();

export const inquirySettingsBody = z.object({
  enabled: z.boolean(),
  defaultOwnerUserId: z.string().trim().min(1).max(128).nullable(),
  // 0 when the school has no settings row yet.
  expectedVersion: z.coerce.number().int().min(0),
}).strict().refine((body) => !body.enabled || Boolean(body.defaultOwnerUserId), {
  message: 'Choose who receives new inquiries before turning the form on',
  path: ['defaultOwnerUserId'],
});
