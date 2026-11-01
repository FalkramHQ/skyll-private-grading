// Pipeline requirements and lead → student conversion rules shared by the CRM
// server and UI (FLKRM-326 S5, D1–D6).
import { z } from 'zod';
import { RELATIONSHIP_KEYS } from './guardians.js';
import { STAGE_NAME_MAX } from './pipeline.js';

// What a school can require before a lead is enrolled (D5). All off by default.
export const REQUIREMENTS = Object.freeze([
  { key: 'guardianPhone', label: 'A parent contact with a phone number' },
  { key: 'learnerGrade', label: 'The learner’s grade or class' },
  { key: 'source', label: 'Where the lead came from (source)' },
  { key: 'applicantStage', label: 'The lead reached an application stage first' },
].map((item) => Object.freeze(item)));
export const REQUIREMENT_KEYS = Object.freeze(REQUIREMENTS.map((item) => item.key));

/** Stored JSON → `{ key: boolean }` with every key present. */
export function parseRequirements(json) {
  let raw = {};
  try { raw = JSON.parse(json || '{}') || {}; } catch { raw = {}; }
  return Object.fromEntries(REQUIREMENT_KEYS.map((key) => [key, raw[key] === true]));
}

export const requirementsField = z.object(Object.fromEntries(REQUIREMENT_KEYS.map((key) => [key, z.boolean()]))).strict();

// New stages can only be open or applicant: there is exactly one won and one lost stage (D6).
export const ADDABLE_CATEGORIES = Object.freeze(['open', 'applicant']);

export const addStageBody = z.object({
  name: z.string().trim().min(1, 'Enter a stage name').max(STAGE_NAME_MAX),
  category: z.enum(ADDABLE_CATEGORIES),
  expectedVersion: z.coerce.number().int().positive(),
}).strict();

export const convertLeadBody = z.object({
  leadId: z.string().min(1).max(128),
  expectedVersion: z.coerce.number().int().positive(),
  mode: z.enum(['create', 'link']),
  studentId: z.string().min(1).max(128).optional(),
  batchIds: z.array(z.string().min(1).max(128)).min(1, 'Choose at least one batch').max(10),
  relationship: z.enum(RELATIONSHIP_KEYS).default('guardian'),
  // Required when creating a student while possible matches exist (CRM_CONTRACTS §1.3).
  confirmNoMatch: z.boolean().optional(),
}).strict().refine((body) => (body.mode === 'link') === Boolean(body.studentId), {
  message: 'Choose the student to link to, or create a new one',
  path: ['studentId'],
});
