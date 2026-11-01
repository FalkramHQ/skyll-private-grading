/**
 * Grading calibration: how the grade supervisor treats partial credit.
 *
 * Since Oct 2026 no mode adds marks: the 0.5 idea-credit bump, the clamp and the
 * upward repair are removed from every mode, and so are the review tags that
 * stood in for them (idea_credit_review, partial_credit_enforced, harsh_zero).
 * The downward recheck is off unless a subject profile opts in
 * (gradingProfiles/downwardRecheckEnabled), so the modes now differ only in
 * strict's quote and thin-answer floors and calibrated's thin-answer floor. The
 * notes on each mode below record their history.
 *
 * GRADE_CALIBRATION=legacy (default) keeps the original harsh-zero behaviour:
 * zero criteria whose note admits understanding are bumped to idea credit.
 *
 * GRADE_CALIBRATION=calibrated keeps idea credit but refuses it when the note
 * itself names an error ("identified X, which is the incorrect acid"), and adds
 * the thin-answer floor and one-credit-per-answer rule.
 *
 * GRADE_CALIBRATION=strict stops the supervisor from adding marks. Instead it
 * tags those items for teacher review, audits grades whose own feedback names
 * an error, zeroes credit with no supporting quote from the student, and
 * zeroes answers with no content beyond the question's own words.
 *
 * GRADE_CALIBRATION=flag (fix plan phase 2) keeps the grader's own mark: the
 * normal grading prompt, no idea-credit bump and no clamp, so the supervisor can
 * never raise a mark. A zero whose note reads like credit is tagged
 * idea_credit_review for the teacher instead. A grade whose own feedback names an
 * error while keeping high marks gets the downward recheck (lower or keep, never
 * raise). Unlike strict it does not zero unquoted credit or thin answers, whose
 * ASCII-only tokenisers would zero Hindi answers.
 *
 * GRADE_CALIBRATION_SUBJECTS (optional, comma-separated) limits the chosen mode
 * to those subjects; every other subject, and a grade with no subject, stays
 * legacy. Names match the paper's subject case-insensitively and in full
 * (e.g. "Chemistry, Physics, SST"). Empty means the mode applies to all.
 * Evidence (Oct 2026, scripts/evalGrading.mjs, 2,103 questions): flag mode
 * moved within-one-mark +1.6 to +1.8 points for Chemistry and +2.0 to +3.0 for
 * SST, and left Physics unchanged, but cost German 12 to 13 points and Maths,
 * Geography and English 2 to 5. The bump it removes was masking a grader too
 * harsh on language answers, so turn it on per subject.
 *
 * Evidence (Oct 2026): on 25 PartnerE Chemistry papers the idea-credit bump
 * fired on 156 of 492 written answers and accounted for 77% of marks awarded
 * above an independent strict re-grade. Replayed against 1,829 teacher-reviewed
 * written answers (scripts/replayGradeCalibration.cjs), teachers keep most
 * bumps: legacy is +0.02 marks/question vs teachers, dropping all bumps is
 * -0.17, and calibrated is -0.09 overall but +0.01 for PartnerE (legacy +0.06).
 * Choose per deployment from the replay, not from the strict re-grade alone.
 */

import { gradingProfileRules } from './gradingProfiles/index.js';

export const IDEA_CREDIT_REVIEW_TAG = 'idea_credit_review';
export const STATED_ERROR_TAG = 'stated_error_high_marks';
export const UNQUOTED_CREDIT_TAG = 'unquoted_credit_removed';
export const THIN_ANSWER_TAG = 'thin_answer_zeroed';
export const DUPLICATE_EVIDENCE_TAG = 'duplicate_evidence';
export const UNCLEAR_SYMBOLS_TAG = 'symbol_answer_unclear';
// A grade whose part breakdown, criteria or stated total still disagree after
// one reconcile recheck.
export const MARKS_INCONSISTENT_TAG = 'marks_inconsistent';

const SYMBOL_SUBJECT = /math|physics|chem/i;
const SYMBOL_CHAR = /[0-9=+\-*/^√∫∑∏πθλμΔΩ°±×÷≤≥≠≈∞→←⇌()[\]{}<>|_\\]/u;

/**
 * A Maths/Physics/Chemistry answer made mostly of symbols (at least 15% of its
 * non-space characters): when it was read with low confidence, a wrong
 * character changes the answer, so it goes to the top of the teacher's queue.
 */
export function isSymbolHeavyAnswer(answer, subject = '') {
  if (!SYMBOL_SUBJECT.test(String(subject || ''))) return false;
  const chars = [...String(answer || '').replace(/\s+/g, '')];
  if (chars.length < 6) return false;
  return chars.filter((ch) => SYMBOL_CHAR.test(ch)).length / chars.length >= 0.15;
}

const MODES = new Set(['legacy', 'calibrated', 'strict', 'flag']);

export function gradingCalibrationMode(env = typeof process !== 'undefined' ? process.env : {}) {
  const value = String(env?.GRADE_CALIBRATION || '').trim().toLowerCase();
  return MODES.has(value) ? value : 'legacy';
}

const normalizeSubject = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');

export function calibrationSubjects(env = typeof process !== 'undefined' ? process.env : {}) {
  return String(env?.GRADE_CALIBRATION_SUBJECTS || '')
    .split(',')
    .map(normalizeSubject)
    .filter(Boolean);
}

// The mode for one paper's subject: GRADE_CALIBRATION, unless
// GRADE_CALIBRATION_SUBJECTS is set and does not list this subject.
export function gradingCalibrationModeFor(subject, env = typeof process !== 'undefined' ? process.env : {}) {
  const mode = gradingCalibrationMode(env);
  const subjects = calibrationSubjects(env);
  if (mode === 'legacy' || !subjects.length) return mode;
  return subjects.includes(normalizeSubject(subject)) ? mode : 'legacy';
}

export function isStrictCalibration(env) {
  return gradingCalibrationMode(env) === 'strict';
}

// A feedback sentence that names a concrete error. Used to stop "identified X,
// which is the incorrect acid" from reading as credit, and to audit grades that
// keep high marks while their own feedback lists a wrong value or concept.
const STATED_ERROR = /\b(incorrect(?:ly)?|wrong(?:ly)?|reversed|swapped|inverted|contradict\w*|confus\w*|not\s+(?:a|an|the)\s+(?:correct|valid|redox|balanced)|not\s+correct|not\s+balanced|unbalanced|instead of|misidentif\w*|mislabel\w*|fails?\s+to|did not|does not|doesn't|didn't|missing|omit\w*|no\s+(?:equation|reaction|reagent|product|explanation|example|balancing|derivation|calculation|units?))\b/i;
const NO_ISSUE = /^(?:no\s+(?:significant\s+)?(?:issues?|errors?|problems?|concerns?)|none|n\/a|the\s+(?:answer|response)\s+is\s+(?:correct|complete))\b/i;

// A sentence that names an issue but says it costs nothing ("capitalized
// mid-sentence… a spelling issue, so it does not reduce the mark") is not a stated
// error: graders often note harmless slips. Measured Oct 2026: the downward
// recheck fired on such notes and took correct marks off in German, English and
// Geography.
const NO_EFFECT = /\b(?:does(?:\s+not|n't)\s+(?:affect|reduce|change|invalidate|impact|cost|lower)|without\s+affecting|not\s+(?:a|an)\s+[\w-]+(?:\s+[\w-]+)?\s+error|(?:only\s+)?(?:a\s+)?minor\s+(?:issue|slip|error|point|lapse|orthographic|spelling|capitali[sz]ation|punctuation)|no\s+marks?\s+(?:are\s+)?(?:lost|deducted)|not\s+(?:assessed|part\s+of\s+the\s+(?:criterion|rubric)))\b/i;

export function namesError(feedback = '') {
  const value = String(feedback || '').trim();
  if (!value || NO_ISSUE.test(value)) return false;
  return value
    .split(/(?<=[.;!?])\s+/)
    .some((sentence) => STATED_ERROR.test(sentence) && !NO_EFFECT.test(sentence));
}

/**
 * The subject's own grading rules (shared/gradingProfiles), added to the grade
 * and downward-recheck prompts in every mode. `title` tells English Literature
 * from English Language when the paper is tagged plain "English".
 */
export function subjectGradingRules(subject = '', title = '') {
  return gradingProfileRules(subject, title);
}

function normalizeForMatch(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\\(?:text|mathrm|mathbf|underline|overset|underset|frac)\b/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * True when `quote` appears in the student answer once formatting is ignored
 * (LaTeX, HTML, spacing, punctuation, case). Short quotes are accepted only as
 * whole matches so a stray "2" cannot verify a criterion.
 */
export function quoteFoundInAnswer(quote, studentAnswer) {
  const needle = normalizeForMatch(quote);
  if (needle.length < 3) return false;
  return normalizeForMatch(studentAnswer).includes(needle);
}

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'to', 'and', 'or', 'in', 'on', 'for', 'is', 'are', 'by', 'with', 'from', 'into', 'as', 'at', 'be', 'it', 'its', 'this', 'that', 'give', 'write', 'explain', 'state', 'define', 'what', 'how', 'why', 'which', 'following', 'reaction', 'reactions', 'test', 'answer', 'ans', 'i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'a', 'b', 'c', 'd', 'q']);

function contentTokens(value) {
  return String(value || '')
    .replace(/\\[a-z]+/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .toLowerCase()
    .split(/[^a-z0-9+\-=]+/)
    .filter((token) => token && !STOPWORDS.has(token) && !/^[-+=]+$/.test(token) && !/^\d{1,2}$/.test(token));
}

/**
 * Number of answer tokens that are not just the question's own words or
 * sub-part labels. Formula tokens (CH3COOH, 2p, +5) count as content.
 */
export function answerContentSize(studentAnswer, questionText = '') {
  const questionWords = new Set(contentTokens(questionText));
  return contentTokens(studentAnswer).filter((token) => !questionWords.has(token)).length;
}

/**
 * Thin-answer floor: only for multi-mark written questions, so one-line answers
 * like "PbO2, Tl2SO4" or "P = +5" on short items are never touched.
 */
export function isThinAnswer({ studentAnswer, questionText, maxMarks, responseType }) {
  const type = String(responseType || '').toLowerCase();
  if (['mcq', 'numerical', 'diagram', 'table'].includes(type)) return false;
  if (!(Number(maxMarks) >= 3)) return false;
  return answerContentSize(studentAnswer, questionText) < 4;
}

// Script-agnostic: Devanagari and other non-Latin answers keep their letters
// (normalizeForMatch keeps only a-z0-9, which empties a Hindi answer).
function normalizedAnswerKey(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\\(?:text|mathrm|mathbf|underline|overset|underset|frac)\b/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, '');
}

function unicodeTokens(value) {
  return String(value || '').normalize('NFKC').toLowerCase()
    .replace(/<[^>]+>/g, ' ')
    .split(/[^\p{L}\p{N}\p{M}+\-=]+/u)
    .filter((token) => token && !STOPWORDS.has(token) && !/^[-+=]+$/.test(token) && !/^\d{1,2}$/.test(token));
}

/**
 * Find answers whose text was assigned to more than one question for the same
 * student. Keeps the question whose wording overlaps the answer most and marks
 * the rest as duplicates. Returns Map(questionNumber -> keptQuestionNumber).
 */
export function findDuplicateAnswers(items = []) {
  const groups = new Map();
  for (const item of items) {
    const key = normalizedAnswerKey(item.studentAnswer);
    if (key.length < 20) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const duplicates = new Map();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const answerWords = new Set(unicodeTokens(group[0].studentAnswer));
    const scored = group.map((item) => ({
      item,
      overlap: unicodeTokens(`${item.questionText || ''} ${item.answerKey || ''}`).filter((token) => answerWords.has(token)).length,
    }));
    scored.sort((a, b) => b.overlap - a.overlap);
    const kept = scored[0].item.questionNumber;
    for (const { item } of scored.slice(1)) duplicates.set(item.questionNumber, kept);
  }
  return duplicates;
}

/** Strict-mode partial-credit policy text for the grade prompt. */
export function strictPartialCreditPolicy() {
  return [
    'PARTIAL CREDIT POLICY (short_answer / long_answer / proof only):',
    '- Return a criteria array: one object per rubric mark band/criterion with {"id":"","max":0,"marks":0,"note":"","evidence_quote":""}.',
    '- Award a criterion only for a rubric point the student actually wrote. For every criterion with marks > 0, evidence_quote MUST be a short verbatim quote (3-15 words) copied from the student answer that earns it. If you cannot quote it, the criterion scores 0.',
    '- A heading, a label, or words copied from the question are not an answer and earn nothing.',
    '- A wrong value, wrong product/reagent, reversed concept, or contradiction costs that criterion. If needs_attention names an error in a criterion, that criterion cannot have full marks.',
    '- Partial marks (e.g. 0.5) are for a correct idea that is incompletely or poorly expressed, not for an attempt or for mentioning a related term.',
    '- marks_awarded MUST equal the sum of criteria[].marks; the system will overwrite marks_awarded with that sum.',
    '- what_went_correct may be empty. Do not describe an incorrect answer as "identified" or "stated" anything.',
    '- Do not invent work, diagrams, or numerical results that are not in the student evidence.',
    '- MCQ and numerical questions are excluded from this policy: exact/accepted answers only; omit criteria for those.',
  ].join(' ');
}

/** Repair prompt used when a grade keeps marks its own feedback contradicts. */
export function buildDownwardRepairPrompt({ question, evidence, rubric, grade, auditReasons, subject = '' }) {
  return [
    'You are the grading supervisor. The prior grade awarded marks that its own feedback contradicts (it names errors or missing parts but still gives high marks).',
    'Re-score each criterion strictly against the rubric. Remove marks only for errors or missing parts in what the rubric assesses. Keep marks for rubric points the student actually wrote, each with a verbatim evidence_quote from the student answer.',
    'Do not remove marks for capitalisation, punctuation, spelling slips or phrasing unless the rubric names them, nor for points beyond what the rubric\'s marks require (such as extra detail in the official answer). If the prior feedback says an issue does not affect the mark, keep that mark.' + subjectGradingRules(subject || question.test_subject, question.test_title),
    'marks_awarded MUST equal the sum of criteria[].marks. Never raise the total above the prior grade.',
    'Return JSON only: {"marks_awarded":0,"criteria":[{"id":"","max":0,"marks":0,"note":"","evidence_quote":""}],"confidence":"low|medium|high","needs_review":false,"review_reasons":[],"what_went_correct":"","needs_attention":"","next_step":"","grading_reasoning":""}.',
    '',
    `Audit reasons: ${JSON.stringify(auditReasons || [])}`,
    `Question: ${question.question_text || ''}`,
    `Official answer: ${question.answer_key_text || question.correct_answer || ''}`,
    `Rubric: ${rubric?.marking_rubric || ''}`,
    `Student answer: ${evidence?.student_answer || 'No answer captured.'}`,
    `Previous grade JSON: ${JSON.stringify({
      marks_awarded: grade.marks,
      criteria: grade.criteria || [],
      what_went_correct: grade.whatWentCorrect,
      needs_attention: grade.needsAttention,
      grading_reasoning: grade.reasoning,
    })}`,
  ].join('\n');
}
