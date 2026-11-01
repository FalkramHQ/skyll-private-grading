// Lead rules shared by the CRM server and UI (FLKRM-326). The request schemas
// live here so the New lead form validates with exactly the server's rules.
import { z } from 'zod';
import { normalizePhone } from '../phone.js';
import { DEFAULT_LEAD_SOURCES } from './pipeline.js';

// Why a lead was lost (D7). A fixed list so admissions reports can group
// reasons; `other` needs a note. Schools may edit the list in a later release.
export const LOST_REASONS = Object.freeze([
  { key: 'price', label: 'Price / fees' },
  { key: 'distance_timing', label: 'Distance / timing' },
  { key: 'another_institute', label: 'Chose another institute' },
  { key: 'not_interested', label: 'Not interested anymore' },
  { key: 'no_response', label: 'No response' },
  { key: 'other', label: 'Other' },
].map((reason) => Object.freeze(reason)));

export const LOST_REASON_KEYS = Object.freeze(LOST_REASONS.map((reason) => reason.key));

export function lostReasonLabel(key) {
  return LOST_REASONS.find((reason) => reason.key === key)?.label || null;
}

/**
 * Collapses case, punctuation and spacing (and Shri-/Sri- spellings) so two
 * spellings of one name compare equal. Exact equality after this is the only
 * name match the CRM uses; similar names never match (CRM_CONTRACTS §1.3).
 */
export function normalizePersonName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\bshri/g, 'sri');
}

export const LEAD_SOURCE_KEYS = Object.freeze(DEFAULT_LEAD_SOURCES.map((source) => source.key));

export const PHONE_MESSAGE = 'Enter a valid mobile number, e.g. 98200 11122';

/** A phone the server can store: the same normaliser decides both. */
export const phoneField = z.string().trim()
  .min(1, PHONE_MESSAGE)
  .max(24, PHONE_MESSAGE)
  .refine((value) => normalizePhone(value) !== null, PHONE_MESSAGE);

export const leadInterest = z.object({
  course: z.string().trim().max(120).optional(),
  schedule: z.string().trim().max(120).optional(),
}).strict();

export const createLeadBody = z.object({
  learnerName: z.string().trim().min(1, 'Enter the student name').max(120),
  learnerGrade: z.string().trim().max(32).optional(),
  sourceKey: z.enum(LEAD_SOURCE_KEYS).optional(),
  contact: z.object({
    name: z.string().trim().max(120).optional(),
    phone: phoneField,
    whatsappOptIn: z.boolean().optional(),
  }).strict().optional(),
  interest: leadInterest.optional(),
  ownerUserId: z.string().trim().min(1).max(128).optional(),
  note: z.string().trim().min(1).max(2000).optional(),
  // Set after staff saw the duplicate warning and chose "Create anyway".
  acknowledgeDuplicates: z.boolean().optional(),
}).strict().refine((body) => Boolean(body.contact || body.note), {
  message: 'Add a contact phone or a note so the lead can be followed up',
});

/** First message per field path (e.g. `contact.phone`) from a failed parse. */
export function fieldErrors(result) {
  if (result.success) return {};
  const errors = {};
  for (const issue of result.error.issues) {
    const key = issue.path.join('.');
    if (!errors[key]) errors[key] = issue.message;
  }
  return errors;
}
