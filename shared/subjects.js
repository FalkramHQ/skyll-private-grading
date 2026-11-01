/**
 * Canonical subject catalog for intake, API validation, and UI filters.
 * New assessments must use SUBJECTS only; aliases exist to backfill/read legacy rows.
 */

export const SUBJECTS = Object.freeze([
  'Mathematics',
  'Physics',
  'Chemistry',
  'Biology',
  'Science',
  'Accounts',
  'English',
  'Hindi',
  'German',
  'History',
  'Geography',
]);

/** Lowercase alias / legacy spelling → canonical SUBJECTS entry. */
export const SUBJECT_ALIASES = Object.freeze({
  maths: 'Mathematics',
  math: 'Mathematics',
  mathematics: 'Mathematics',
  physics: 'Physics',
  chemistry: 'Chemistry',
  chem: 'Chemistry',
  biology: 'Biology',
  bio: 'Biology',
  science: 'Science',
  accounts: 'Accounts',
  accountancy: 'Accounts',
  english: 'English',
  'english language': 'English',
  'eng language': 'English',
  eng: 'English',
  hindi: 'Hindi',
  german: 'German',
  deutsch: 'German',
  'german language': 'German',
  // ICSE pairs History with Civics in one paper ("History & Civics").
  history: 'History',
  hist: 'History',
  civics: 'History',
  'history and civics': 'History',
  'history & civics': 'History',
  'history civics': 'History',
  'history/civics': 'History',
  geography: 'Geography',
  geo: 'Geography',
});

function cleanSubjectInput(raw) {
  const cleaned = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!cleaned) return '';
  const setMatch = cleaned.match(/^(.*?)\s+set\s+[A-Za-z0-9]+$/i);
  return (setMatch ? setMatch[1] : cleaned).trim();
}

/**
 * Map raw subject text to a canonical SUBJECTS value.
 * Returns '' for empty input; null when the value is not in the allowlist (even after aliases).
 */
export function resolveCanonicalSubject(raw) {
  const cleaned = cleanSubjectInput(raw);
  if (!cleaned) return '';
  const lower = cleaned.toLowerCase();
  if (SUBJECT_ALIASES[lower]) return SUBJECT_ALIASES[lower];
  const exact = SUBJECTS.find((name) => name.toLowerCase() === lower);
  return exact || null;
}

/** Display helper: canonical name when known, otherwise trimmed original (legacy rows). */
export function normalizeSubject(raw) {
  if (!raw) return '';
  return resolveCanonicalSubject(raw) || String(raw).trim().replace(/\s+/g, ' ');
}

export function isCanonicalSubject(raw) {
  return SUBJECTS.includes(resolveCanonicalSubject(raw) || '');
}

export function availableSubjects(examSubjects) {
  const present = new Set((examSubjects || []).map((s) => normalizeSubject(s)));
  return SUBJECTS.filter((s) => present.has(s));
}

export function subjectValidationError(raw) {
  const resolved = resolveCanonicalSubject(raw);
  if (resolved === '') return 'subject is required';
  if (!resolved) {
    return `subject must be one of: ${SUBJECTS.join(', ')}`;
  }
  return null;
}
