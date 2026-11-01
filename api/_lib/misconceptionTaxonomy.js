import { resolveCanonicalSubject } from '../../shared/subjects.js';

export const MISCONCEPTION_CLASSES = {
  maths: [
    'sign-error',
    'distribution-misuse',
    'formula-misapplication',
    'notation-error',
    'procedural-skip',
    'concept-confusion',
    'arithmetic-slip',
    'unit-error',
    'diagram-misread',
  ],
};

const ALIASES = {
  maths: {
    'sign-error': ['sign error', 'sign mistake', 'forgot the minus sign', 'negative sign', 'sign flip', '+/- error'],
    'distribution-misuse': ['distribution', 'distributive', 'expand wrongly', 'foil error', 'bracket expansion'],
    'formula-misapplication': ['wrong formula', 'formula error', 'misapplied formula', 'used wrong formula'],
    'notation-error': ['notation', 'symbol error', 'equals sign', 'wrong symbol'],
    'procedural-skip': ['skipped step', 'missing step', 'jumped step', 'procedural', 'incomplete working'],
    'concept-confusion': ['concept', 'misunderstood', 'confused', 'wrong concept'],
    'arithmetic-slip': ['arithmetic', 'calculation error', 'calc slip', 'addition error', 'multiplication error'],
    'unit-error': ['unit', 'units', 'wrong unit', 'conversion'],
    'diagram-misread': ['diagram', 'graph', 'misread', 'wrong axis', 'figure'],
  },
};

// Maps canonical subjects (shared/subjects.js) to taxonomy keys. Production DB
// stores canonical 'Mathematics' while the taxonomy is keyed under 'maths'.
const TAXONOMY_KEYS_BY_CANONICAL = { Mathematics: 'maths' };

function resolveSubjectKey(subject) {
  const canonical = resolveCanonicalSubject(subject);
  if (canonical) return TAXONOMY_KEYS_BY_CANONICAL[canonical] || canonical.toLowerCase();
  return String(subject || '').toLowerCase();
}

export function isValidMisconceptionClass(subject, value) {
  const set = MISCONCEPTION_CLASSES[resolveSubjectKey(subject)];
  return Boolean(set && set.includes(String(value || '').toLowerCase()));
}

export function normalizeMisconceptionClass(subject, freeText) {
  const key = resolveSubjectKey(subject);
  const classes = MISCONCEPTION_CLASSES[key];
  const aliases = ALIASES[key];
  const text = String(freeText || '').toLowerCase().trim();
  if (!text) return null;
  // Exact canonical enum values pass through directly (v2 prompt emits them verbatim).
  if (classes && classes.includes(text)) return text;
  if (!aliases) return null;
  for (const [cls, words] of Object.entries(aliases)) {
    if (words.some((w) => text.includes(w))) return cls;
  }
  return null;
}
