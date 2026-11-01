// Note rules shared by the CRM server and UI (FLKRM-326 S3).
import { z } from 'zod';

export const NOTE_MAX = 2000;
export const NOTE_ENTITY_TYPES = Object.freeze(['lead', 'student']);

export const noteBodyField = z.string().trim().min(1, 'Write something first').max(NOTE_MAX, `Keep notes under ${NOTE_MAX} characters`);

export const recordRef = {
  entityType: z.enum(NOTE_ENTITY_TYPES),
  entityId: z.string().min(1).max(128),
};

export const addNoteBody = z.object({ ...recordRef, body: noteBodyField }).strict();
