// Tag rules shared by the CRM server and UI (FLKRM-326 S3). Colours are palette
// keys, not hex, so the UI maps them to design tokens.
import { z } from 'zod';

export const TAG_LABEL_MAX = 40;
export const TAG_COLORS = Object.freeze(['gray', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'violet', 'pink']);

export const tagLabelField = z.string().trim().min(1, 'Enter a tag name').max(TAG_LABEL_MAX, `Keep tags under ${TAG_LABEL_MAX} characters`);

/** One spelling per tag: collapse inner spaces; case is kept but compared case-insensitively. */
export function cleanTagLabel(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}
