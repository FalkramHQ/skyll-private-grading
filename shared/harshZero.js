/**
 * Harsh-zero detection + structured criteria helpers.
 * Detection tags contradictions for review. Criteria normalization and the
 * Grade Supervisor own enforceable partial credit (sum criteria; clamp when
 * prose admits understanding but marks stay 0).
 */

import { quoteFoundInAnswer } from './gradingCalibration.js';

export const HARSH_ZERO_TAG = 'harsh_zero';
export const PARTIAL_CREDIT_ENFORCED_TAG = 'partial_credit_enforced';

export const SUBJECTIVE_RESPONSE_TYPES = new Set([
  'short_answer',
  'long_answer',
  'proof',
  'written',
  'other',
]);

const ATTEMPT_ONLY = /^(the\s+)?student\s+(attempted|tried|wrote|answered)|attempt(ed)?\s+(to\s+)?answer|no\s+credit|blank|empty|not\s+attempted/i;
const NEGATED_CORRECT = /\b(no correct|nothing correct|did not|didn't|does not|doesn't|incorrect|not\s+correct|lacks? the|failed to|missing the required|were not identified|was not provided)\b/i;
const POSITIVE_CORRECT = /\b(correct(?:ly)?|right(?:ly)?|identified|stated|mentioned|showed|shows|referenced|recognised|recognized|used the term|valid)\b/i;
const DEVANAGARI = /[\u0900-\u097F]/;

/**
 * Resolve feedback/grade language.
 * - Explicit override wins
 * - Hindi subject → Hindi
 * - Otherwise → English
 *
 * Do not infer Hindi from Devanagari OCR noise in STEM answers — that caused
 * models to freelance Hindi feedback on English Physics/Chemistry papers.
 */
export function resolveGradingLanguage({ subject, studentAnswer, explicit } = {}) {
  const forced = String(explicit || '').trim().toLowerCase();
  if (forced === 'hindi' || forced === 'english') return forced;
  if (/hindi/i.test(String(subject || ''))) return 'hindi';
  void studentAnswer;
  return 'english';
}

export function gradingLanguageInstruction(language) {
  if (language === 'hindi') {
    return ' LANGUAGE REQUIREMENT: Write ALL reasoning fields (what_went_correct, needs_attention, next_step, grading_reasoning) in Hindi using Devanagari script. Use Hindi educational terminology. Do not write these fields in English.';
  }
  return ' LANGUAGE REQUIREMENT (mandatory): Write ALL reasoning fields (what_went_correct, needs_attention, next_step, grading_reasoning) in clear English only. Never use Hindi, Devanagari, or any other language in these fields — even if the student answer contains non-English text.';
}

/** True when feedback prose still contains Devanagari (model ignored English policy). */
export function feedbackHasDevanagari(...parts) {
  return parts.some((part) => DEVANAGARI.test(String(part || '')));
}

export const LEAKED_REASONING_TAG = 'feedback_reasoning_leaked';

// The model talking to itself about the output it is writing ("I will set
// marks_awarded to 1… I will output the JSON"). Feedback is written about the
// student in the third person, so these never belong in it.
const LEAKED_REASONING = [
  /\bI(?:'ll| will| need to| should| must| can) (?:output|set|follow|return|write|produce|re-?check|recompute|re-?calculate|use)\b/i,
  /\bthe (?:instructions?|prompt|schema|system|example output) (?:says?|said|requires?|asks?|shows?)\b/i,
  /\b(?:marks_awarded|marks_obtained|grading_reasoning|what_went_correct|needs_attention|criteria\[\]\.marks)\b/,
  /\b(?:output|return) (?:the |this |valid )?JSON\b/i,
  /\bLet me (?:re-?check|re-?count|reconsider|recalculate|re-?read|think)\b/i,
  /(?:^|[.!?]\s+)Wait,\s/,
];

/** True when feedback prose contains the grader's own working notes about its output. */
export function feedbackLeaksReasoning(...parts) {
  return parts.some((part) => {
    const value = String(part || '');
    return value && LEAKED_REASONING.some((pattern) => pattern.test(value));
  });
}

/**
 * True when what_went_correct credits a real correct fragment — not a hollow
 * "they attempted" line and not a negation that only explains the zero.
 */
export function hasSubstantiveCorrectFragment(whatWentCorrect = '') {
  const text = String(whatWentCorrect || '').trim();
  if (text.length < 24) return false;
  if (ATTEMPT_ONLY.test(text) && text.length < 80) return false;
  if (/^(the\s+)?student\s+attempted to answer\.?$/i.test(text)) return false;
  // "No correct differences were identified…" is not evidence of credit.
  if (NEGATED_CORRECT.test(text) && !POSITIVE_CORRECT.test(text)) return false;
  // Prefer an explicit positive credit signal when the prose is mixed.
  if (NEGATED_CORRECT.test(text) && POSITIVE_CORRECT.test(text)) {
    // e.g. "mentioned X which indicates some understanding" wins over a later "but".
    const positiveIdx = text.search(POSITIVE_CORRECT);
    const negativeIdx = text.search(NEGATED_CORRECT);
    if (negativeIdx >= 0 && (positiveIdx < 0 || negativeIdx < positiveIdx)) return false;
  }
  return POSITIVE_CORRECT.test(text) || /\b(opposes|flux|formula|expression|difference|law)\b/i.test(text);
}

export function isSubjectiveResponseType(value) {
  const type = String(value || '').trim().toLowerCase();
  if (!type) return true; // unknown written work — treat as subjective for detection
  if (['mcq', 'numerical', 'diagram', 'table'].includes(type)) return false;
  return SUBJECTIVE_RESPONSE_TYPES.has(type) || type.includes('answer');
}

/**
 * @param {{ marks?: number, allocated?: number, attempted?: boolean, whatWentCorrect?: string, responseType?: string }} input
 */
export function isHarshZero(input = {}) {
  const marks = Number(input.marks ?? 0);
  const allocated = Number(input.allocated ?? input.marksAllocated ?? 0);
  const attempted = input.attempted !== false;
  if (!attempted) return false;
  if (!(allocated >= 2)) return false;
  if (!(marks === 0)) return false;
  if (!hasSubstantiveCorrectFragment(input.whatWentCorrect)) return false;
  if (input.responseType != null && !isSubjectiveResponseType(input.responseType)) return false;
  return true;
}

export function mergeReviewTags(existing = [], ...extra) {
  const tags = [
    ...(Array.isArray(existing) ? existing : []),
    ...extra.flatMap((value) => (Array.isArray(value) ? value : [value])),
  ]
    .map((tag) => String(tag || '').trim())
    .filter(Boolean);
  return [...new Set(tags)];
}

export function withHarshZeroTag(item = {}) {
  const rationale = item.gradeRationale || {};
  const harsh = isHarshZero({
    marks: item.grade?.marks ?? item.overrideMarks ?? item.ai_marks,
    allocated: item.grade?.allocated ?? item.marksAllocated,
    attempted: item.studentAnswer?.attempted,
    whatWentCorrect: rationale.whatWentCorrect || rationale.what_went_correct,
    responseType: item.expectedResponseType || item.expected_response_type,
  });
  if (!harsh) return item;
  return {
    ...item,
    reviewTags: mergeReviewTags(item.reviewTags, HARSH_ZERO_TAG),
    isHarshZero: true,
  };
}

const PART_BREAK = /\n|\(\s*(?:[a-h]|i{1,3}|iv|vi{0,3}|ix|x)\s*\)/i;
// The label of a lower rung in a mark ladder: a count or a quality of the same
// point ("two correct differences", "only one benefit", "a partial explanation",
// "a letter with major format errors", "a very poor attempt").
const BAND_RUNG = /^(?:only\s+)?(?:(?:any|a|an|the)\s+)?(?:one|two|three|four|five|six|single)\b|\b(?:partial(?:ly)?|vague|incomplete|minor|basic|good|limited|poor|weak|lacking|major|some|fewer)\b/i;

/**
 * Parse "N mark(s) for …" style rubric lines into criterion stubs.
 * Falls back to a single overall criterion when allocated >= 2 and nothing parsed.
 */
export function parseRubricCriteria(markingRubric = '', allocated = 0) {
  const text = String(markingRubric || '').trim();
  const maxTotal = Number(allocated) || 0;
  let found = [];
  const pattern = /(\d+(?:\.\d+)?)\s*marks?\s+for\s+([^.;\n]+)/gi;
  let match;
  let segment = 0;
  let lastEnd = 0;
  while ((match = pattern.exec(text)) !== null) {
    // A new line or a part marker ("(b)", "(ii)") starts a new part of the question.
    if (found.length && PART_BREAK.test(text.slice(lastEnd, match.index))) segment += 1;
    lastEnd = match.index + match[0].length;
    const max = Number(match[1]);
    const label = String(match[2] || '').trim().replace(/\s+/g, ' ');
    if (!(max > 0) || !label) continue;
    const id = label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 48) || `criterion_${found.length + 1}`;
    found.push({ id, max, label, perItem: /^(?:each|every)\b/i.test(label), segment });
  }
  // A mark ladder ("3 marks for any three differences; 2 marks for two; 1 mark for
  // one") lists the marks one point can earn, not points to add up. Read as
  // separate criteria, its rungs summed past the question's marks: on the PartnerD
  // ICSE History & Civics semi-prelim (Oct 2026) a Q3 the grader itself totalled
  // at 6/10 was stored as 10/10. When the rubric's lines add up to more than the
  // question, a lower rung that only restates the count or quality of the point
  // above it in the same part is dropped; "2 marks for the meaning; 1 mark for
  // Lord Wellesley" stays two criteria.
  const fixedSum = found.filter((c) => !c.perItem).reduce((sum, c) => sum + c.max, 0);
  if (maxTotal > 0 && fixedSum > maxTotal + 0.01) {
    const topBySegment = new Map();
    found = found.filter((c) => {
      const top = topBySegment.get(c.segment);
      if (top != null && c.max < top && BAND_RUNG.test(c.label)) return false;
      topBySegment.set(c.segment, Math.max(top ?? 0, c.max));
      return true;
    });
  }
  // Two parts can share a label ("2 marks for correct meaning" in (a) and (b));
  // each criterion needs its own id or both match the same graded criterion.
  const seen = new Map();
  found = found.map(({ segment: _segment, ...criterion }) => {
    const count = (seen.get(criterion.id) || 0) + 1;
    seen.set(criterion.id, count);
    return count > 1 ? { ...criterion, id: `${criterion.id}_${count}` } : criterion;
  });
  if (found.length) {
    // "1 mark for each correct option" repeats, so its face value is not its
    // ceiling: a per-item band is worth what the fixed bands leave of the
    // question's marks. Reading it as a 1-mark criterion capped a 15-mark MCQ
    // block at 1 (PartnerD ICSE Physics, 22 Oct 2026), and any "1 mark for each
    // point" question at that one band.
    const fixed = found.filter((c) => !c.perItem).reduce((sum, c) => sum + c.max, 0);
    const perItem = found.filter((c) => c.perItem);
    const room = maxTotal - fixed;
    return found.map(({ perItem: isPerItem, ...criterion }) => (isPerItem && perItem.length === 1 && room > criterion.max
      ? { ...criterion, max: room }
      : criterion));
  }
  if (maxTotal >= 2) return [{ id: 'overall', max: maxTotal, label: 'overall response' }];
  if (maxTotal > 0) return [{ id: 'overall', max: maxTotal, label: 'overall response' }];
  return [];
}

/**
 * Normalize model criteria against rubric stubs. Clamps marks to [0, max].
 * Returns { criteria, sum, enforcedIds }.
 */
export function normalizeCriteria(rawCriteria, rubricStubs = [], options = {}) {
  const strict = options.mode === 'strict';
  const raw = Array.isArray(rawCriteria) ? rawCriteria : [];
  // parseRubricCriteria falls back to one synthetic "overall" band when the rubric
  // has no "N marks for …" lines. When the grader returned its own criteria, those
  // replace it: keeping both made the criteria worth twice the question.
  const syntheticOnly = Array.isArray(rubricStubs) && rubricStubs.length === 1 && rubricStubs[0].id === 'overall'
    && raw.length > 0 && !raw.some((item) => String(item?.id || item?.name || '').trim() === 'overall');
  const stubs = Array.isArray(rubricStubs) && !syntheticOnly ? rubricStubs : [];
  const byId = new Map();
  for (const item of raw) {
    const id = String(item?.id || item?.name || '').trim() || `criterion_${byId.size + 1}`;
    const max = Number(item?.max ?? item?.marks_allocated ?? item?.allocated) || 0;
    const marks = Number(item?.marks ?? item?.marks_awarded) || 0;
    const note = String(item?.note || item?.reason || '').trim();
    byId.set(id, {
      id,
      max: max > 0 ? max : 0,
      marks,
      note,
      label: String(item?.label || id),
      evidenceQuote: String(item?.evidence_quote || item?.evidenceQuote || '').trim(),
    });
  }

  const criteria = [];
  const used = new Set();
  for (const stub of stubs) {
    const hit = byId.get(stub.id)
      || [...byId.values()].find((c) => !used.has(c.id) && (
        c.label.toLowerCase().includes(String(stub.label || '').toLowerCase().slice(0, 20))
        || String(stub.label || '').toLowerCase().includes(c.label.toLowerCase().slice(0, 20))
      ));
    const max = Number(stub.max) || Number(hit?.max) || 0;
    const marks = hit ? Number(hit.marks) || 0 : 0;
    const note = hit?.note || '';
    const id = stub.id || hit?.id || `criterion_${criteria.length + 1}`;
    if (hit) used.add(hit.id);
    criteria.push({
      id,
      max,
      marks: Math.max(0, Math.min(max || marks, marks)),
      note,
      label: stub.label || hit?.label || id,
      ...(hit?.evidenceQuote ? { evidenceQuote: hit.evidenceQuote } : {}),
    });
  }
  for (const [id, item] of byId) {
    if (used.has(id)) continue;
    const max = item.max > 0 ? item.max : item.marks;
    criteria.push({
      id,
      max,
      marks: Math.max(0, Math.min(max || item.marks, item.marks)),
      note: item.note,
      label: item.label || id,
      ...(item.evidenceQuote ? { evidenceQuote: item.evidenceQuote } : {}),
    });
  }

  // No mode adds marks. The 0.5 idea-credit bump (and flag mode's "zero may
  // deserve credit" tag in its place) is gone: a criterion keeps the grader's mark.
  if (strict) return strictCriteria(criteria, { studentAnswer: options.studentAnswer });
  const sum = criteria.reduce((acc, c) => acc + (Number(c.marks) || 0), 0);
  return { criteria, sum, enforcedIds: [], flaggedIds: [], unquotedIds: [] };
}

/**
 * Strict calibration: when the grader supplies an evidence_quote convention
 * (any criterion has one), credited criteria without a quote found in the
 * student answer are zeroed.
 */
function strictCriteria(criteria, { studentAnswer }) {
  const unquotedIds = [];
  const quoting = criteria.some((c) => c.evidenceQuote);
  for (const criterion of criteria) {
    if (quoting && studentAnswer != null && Number(criterion.marks) > 0
      && !quoteFoundInAnswer(criterion.evidenceQuote, studentAnswer)) {
      criterion.marks = 0;
      criterion.note = [criterion.note, 'Credit removed: no supporting quote found in the student answer.'].filter(Boolean).join(' ');
      unquotedIds.push(criterion.id);
    }
  }
  const sum = criteria.reduce((acc, c) => acc + (Number(c.marks) || 0), 0);
  return { criteria, sum, enforcedIds: [], flaggedIds: [], unquotedIds };
}

/** Instructions appended to the grade prompt for subjective response types. */
export function subjectivePartialCreditPolicy() {
  return [
    'PARTIAL CREDIT POLICY (short_answer / long_answer / proof only):',
    '- Return a criteria array: one object per rubric mark band/criterion with {"id":"","max":0,"marks":0,"note":""}.',
    '- Score criterion-by-criterion against the rubric mark bands. marks_awarded MUST equal the sum of criteria[].marks; the system will overwrite marks_awarded with that sum.',
    '- If a criterion band lists a partial mark (e.g. 0.5 for correct idea with poor wording), award that band when the student shows the idea even if wording is broken or incomplete.',
    '- Each criterion note and its marks must agree: a note that credits a correct point carries that point\'s marks; a note that says the point is missing, wrong or not mentioned carries 0 for it. Do not round a missing point up to part credit.',
    '- Reserve marks_awarded = 0 only for blank, wholly wrong concept, or off-topic answers with no scorable fragment.',
    '- Do not invent work, diagrams, or numerical results that are not in the student evidence. Do not award buzzword-only credit when the concept is clearly inverted or absent.',
    '- MCQ and numerical questions are excluded from this policy: exact/accepted answers only; omit criteria for those.',
  ].join(' ');
}

/** Extra rubric-generation instructions for mark bands on subjective items. */
export function rubricBandPolicy() {
  return [
    'For every short_answer, long_answer, or proof question with marks_allocated >= 1, marking_rubric MUST spell explicit mark bands, not only binary all-or-nothing lines.',
    'Mark bands in marking_rubric MUST cover marks_allocated (full-credit path must be able to award all marks).',
    'Bad: marks_allocated=2 with "1 mark for any two correct differences". Good: "2 marks for any two correct differences; 1 mark for only one correct / vague wording".',
    'Include partial bands where a student can show the correct idea with poor wording (e.g. "1.0 clear statement; 0.5 correct idea, poor wording; 0 missing/wrong").',
    'Split multi-part explanations into separate scored criteria with their own marks (e.g. approach case 1 + recede case 1).',
    'MCQ and numerical items stay exact-match; do not invent partial bands for them.',
  ].join(' ');
}
