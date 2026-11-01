/**
 * Canonical subject & grade registry for teacher dashboard filters.
 * Subject allowlist lives in shared/subjects.js - keep this file as a thin re-export.
 */

export {
  SUBJECTS,
  SUBJECT_ALIASES,
  normalizeSubject,
  resolveCanonicalSubject,
  isCanonicalSubject,
  availableSubjects,
  subjectValidationError,
} from '../../shared/subjects.js';

export const GRADES = ['6th', '7th', '8th', '9th', '10th', '11th', '12th'];
