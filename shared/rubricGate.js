import { foldNestedChoiceGroups, pickChoiceUnits, unitQuestionNumbers } from './choiceUnits.js';
// Rubric gate (grading fix plan, phase 1): checks a marking package must pass
// before an admin can mark it for grading. Shared by the worker (at build time),
// the review API (on save and on approval) and the Rubric Review panel.
//
// Off unless RUBRIC_GATE_SCHOOLS names the school ("*" for every school), so
// enabling it is per school and needs no migration.

const EXACT_MATCH_TYPES = new Set(['mcq', 'numerical', 'diagram', 'table']);

export const OVERRIDE_REASON_MIN_CHARS = 15;

/** Whether the gate applies to a test's school (by name or id). */
export function rubricGateEnabled({ school, schoolId } = {}, env = typeof process !== 'undefined' ? process.env : {}) {
  const raw = String(env?.RUBRIC_GATE_SCHOOLS || '').trim();
  if (!raw) return false;
  if (raw === '*') return true;
  const allowed = new Set(raw.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean));
  return [school, schoolId].some((value) => value && allowed.has(String(value).trim().toLowerCase()));
}

/**
 * Same folding as apps/processing-worker/scoringPlan.js, so the gate matches
 * choice-group members to questions exactly the way scoring does
 * ("Q1A_i" / "Q1A(i)" / "1a i" are one question).
 */
export function normalizeQuestionNumber(raw) {
  return String(raw || '').trim().toLowerCase()
    .replace(/^q/, '')
    .replace(/_main$/, '')
    .replace(/_or$/, 'or')
    .replace(/[()\s_.-]/g, '');
}

const FILLER_BAND = /\b(?:marks?|mark)\s+for\s+(?:remaining required content from the answer key|a complete answer covering the required points from the answer key)/i;
const BAND = /(\d+(?:\.\d+)?|½)\s*marks?\s+for\s+/gi;
const PER_ITEM_BAND = /\bmarks?\s+(?:for|per)\s+(?:each|every)\b|\bmarks?\s+per\b|\beach\s+carr(?:y|ies)\b/i;

/**
 * The type to grade a question as. A block of MCQs stored as one "mcq" question
 * ("Q1: 15 MCQs, 1 mark for each correct option") was scored all-or-nothing, so
 * 12 of 15 right scored 0 (PartnerD ICSE Physics, 22 Oct 2026). An mcq worth more
 * than 1 mark whose rubric awards marks per item is graded as a short answer, one
 * item at a time; a single MCQ stays all-or-nothing.
 */
export function gradingResponseType(type, { marks, markingRubric } = {}) {
  const value = String(type || '').toLowerCase();
  if (value === 'mcq' && Number(marks) > 1 && PER_ITEM_BAND.test(String(markingRubric || ''))) return 'short_answer';
  return type;
}
const BLANK = /_{3,}|\.{5,}|…{2,}/g;
const ANY_N = /\b(?:attempt|answer|do)\s+any\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i;

/** Every "N mark(s) for …" band value in a marking rubric ("½" counts as 0.5). */
export function markBands(markingRubric = '') {
  const values = [];
  for (const match of String(markingRubric || '').matchAll(BAND)) {
    const value = match[1] === '½' ? 0.5 : Number(match[1]);
    if (Number.isFinite(value) && value > 0) values.push(value);
  }
  return values;
}

const isMultiple = (value, step) => Math.abs(value / step - Math.round(value / step)) < 1e-6;

/**
 * Option letters printed in an MCQ's text: "(a) …", "b) …", "C. …". Empty unless a
 * run starting at (a) is printed (a, b, c at least): assertion-reason items print
 * "(A)" and "(R)" with their options in the instructions, and must not be read as a/d.
 */
export function printedOptionLetters(questionText = '') {
  const letters = new Set();
  for (const match of String(questionText || '').matchAll(/(?:^|[\s(])([a-dA-D])\s*[).:]\s+\S/g)) letters.add(match[1].toLowerCase());
  return ['a', 'b', 'c'].every((letter) => letters.has(letter)) ? letters : new Set();
}

/** Leading option letter of an MCQ key ("(b) 14 amu" -> "b"), or null. */
export function keyOptionLetter(answer = '') {
  const match = String(answer || '').trim().match(/^\(?([a-dA-D])(?:\)|\.|:|\s|$)/);
  return match ? match[1].toLowerCase() : null;
}

/** Effective total after choice groups (best_score ceiling), with scoring's number folding. */
export function effectiveTotal(questions, scoringPlan) {
  const byKey = new Map(questions.map((q) => [normalizeQuestionNumber(q.number), Number(q.marks_allocated || 0)]));
  const numbers = questions.map((q) => q.number);
  const inGroup = new Set();
  let total = 0;
  for (const group of foldNestedChoiceGroups(scoringPlan?.groups || [], normalizeQuestionNumber)) {
    const units = (group.units?.length ? group.units : (group.question_numbers || []).map((n) => ({ question_numbers: [n] })))
      .map((unit) => ({
        names: [unit.id, ...(unit.question_numbers || [])].filter(Boolean).map(normalizeQuestionNumber),
        keys: [...new Set((unit.question_numbers || [])
          .flatMap((member) => unitQuestionNumbers(member, numbers, normalizeQuestionNumber))
          .map(normalizeQuestionNumber))].filter((key) => byKey.has(key) && !inGroup.has(key)),
      }))
      .filter((unit) => unit.keys.length)
      .map((unit) => ({ ...unit, marks: unit.keys.reduce((sum, key) => sum + byKey.get(key), 0) }));
    for (const unit of units) for (const key of unit.keys) inGroup.add(key);
    const choose = Math.min(Math.max(0, Number(group.choose) || 0), units.length);
    const minimums = (group.at_least || []).map((minimum) => ({ choose: minimum.choose, members: new Set((minimum.question_numbers || []).map(normalizeQuestionNumber)) }));
    const ranked = [...units].sort((a, b) => b.marks - a.marks);
    total += pickChoiceUnits(ranked, choose, minimums, (unit, minimum) => unit.names.some((name) => minimum.members.has(name)))
      .reduce((sum, unit) => sum + unit.marks, 0);
  }
  for (const [key, marks] of byKey) if (!inGroup.has(key)) total += marks;
  return Math.round(total * 100) / 100;
}

/**
 * Check a marking package. Returns blocking errors and advisory warnings, each
 * `{ code, question, message }` (question is null for paper-level findings).
 * @param {{exam?: object, questions?: object[]}} rubric
 */
export function checkRubricGate(rubric = {}) {
  const questions = Array.isArray(rubric.questions) ? rubric.questions : [];
  const exam = rubric.exam || {};
  const errors = [];
  const warnings = [];
  const error = (code, question, message) => errors.push({ code, question, message });

  for (const q of questions) {
    const number = q.number;
    const marks = Number(q.marks_allocated || 0);
    const type = String(q.expected_response_type || '').toLowerCase();
    const rubricText = String(q.marking_rubric || '');
    const step = Number(q.mark_step);
    const hasStep = Number.isFinite(step) && step > 0;

    if (type === 'mcq' && gradingResponseType(type, { marks, markingRubric: rubricText }) !== 'mcq') {
      warnings.push({ code: 'MCQ_BLOCK_PER_ITEM', question: number, message: `${number} holds several MCQs worth ${marks} marks; it is graded one mark per item, not all-or-nothing.` });
    }
    if (type === 'mcq') {
      const letters = printedOptionLetters(q.question_text);
      const key = keyOptionLetter(q.correct_answer_summary);
      if (letters.size && key && !letters.has(key)) {
        error('MCQ_KEY_NOT_OPTION', number, `Key answer (${key}) is not one of the printed options (${[...letters].join(', ')}).`);
      }
    }
    if (!EXACT_MATCH_TYPES.has(type) && marks > 0) {
      const bands = markBands(rubricText);
      const sum = bands.reduce((a, b) => a + b, 0);
      if (FILLER_BAND.test(rubricText)) {
        error('FILLER_BAND', number, 'Marking rubric contains the automatic "remaining required content" band. Replace it with the points the key actually expects.');
      }
      if (marks >= 2 && !bands.length) {
        error('BANDS_MISSING', number, `No "N marks for …" bands for a ${marks}-mark question.`);
      } else if (bands.length && sum + 0.01 < marks && !PER_ITEM_BAND.test(rubricText)) {
        // "1 mark for each correct point" repeats, so its face value is not its ceiling.
        error('BANDS_BELOW_MARKS', number, `Bands add up to ${sum}, short of the ${marks} marks allocated.`);
      }
      const tooBig = bands.filter((value) => value > marks + 0.01);
      if (tooBig.length) error('BAND_ABOVE_MARKS', number, `A band awards ${tooBig[0]} marks on a ${marks}-mark question.`);
      if (hasStep) {
        const offStep = bands.filter((value) => !isMultiple(value, step));
        if (offStep.length) error('BAND_OFF_STEP', number, `Band value ${offStep[0]} is not a multiple of this question's mark step (${step}).`);
      }
      const blanks = (String(q.question_text || '').match(BLANK) || []).length;
      if (blanks >= 3) error('MULTI_BLANK_SINGLE_UNIT', number, `${blanks} blanks are scored as one unit. Split them into one question per blank.`);
    }
    if (q.key_check?.status === 'open') {
      const found = String(q.key_check.checker_answer || '').slice(0, 160);
      const what = q.key_check.verdict === 'alternative'
        ? `The independent check found another correct option (${found})`
        : `An independent check answered "${found}", which disagrees with the key`;
      error('KEY_CHECK_UNRESOLVED', number, `${what}. Keep the key, accept the alternative, or correct the key.`);
    } else if (q.key_check?.verdict === 'unsupported') {
      warnings.push({ code: 'KEY_CHECK_UNSUPPORTED', question: number, message: 'The independent check could not find what the key states in the paper. Fine for questions answered from the textbook; otherwise check the key was not invented.' });
    }
  }

  const numbers = questions.map((q) => q.number);
  const groups = Array.isArray(exam.scoring_plan?.groups) ? exam.scoring_plan.groups : [];
  const grouped = new Set();
  for (const group of groups) {
    const members = [...(group.units || []).flatMap((unit) => unit.question_numbers || []), ...(group.question_numbers || [])];
    for (const member of members) {
      // A bare question number ("Q4") covers its parts (Q4.1, Q4.2…), as in scoring.
      const covered = unitQuestionNumbers(member, numbers, normalizeQuestionNumber);
      grouped.add(normalizeQuestionNumber(member));
      for (const number of covered) grouped.add(normalizeQuestionNumber(number));
      if (!covered.length) error('CHOICE_GROUP_UNKNOWN_QUESTION', null, `Choice group "${group.id || '?'}" names ${member}, which is not a question in this rubric.`);
    }
  }
  // Groups that still share a question after nested groups are folded into
  // at_least minimums are scored one after another, each discarding the other's picks.
  const owner = new Map();
  for (const group of foldNestedChoiceGroups(groups, normalizeQuestionNumber)) {
    const members = [...(group.units || []).flatMap((unit) => unit.question_numbers || []), ...(group.question_numbers || [])];
    for (const number of new Set(members.flatMap((member) => unitQuestionNumbers(member, numbers, normalizeQuestionNumber)))) {
      const other = owner.get(normalizeQuestionNumber(number));
      if (other !== undefined && other !== group) {
        error('CHOICE_GROUPS_OVERLAP', null, `Choice groups "${other.id || '?'}" and "${group.id || '?'}" both include ${number}. Use one group with at_least minimums for "N from each section and M more".`);
        break;
      }
      owner.set(normalizeQuestionNumber(number), group);
    }
  }
  const rulesText = `${exam.optional_rules || ''} ${exam.instructions || ''}`;
  if (!groups.length && (ANY_N.test(rulesText) || questions.some((q) => q.is_optional || q.selection_group))) {
    error('CHOICE_RULE_NOT_ENCODED', null, 'The paper has optional questions ("any N" or marked optional) but no choice group encodes them.');
  }
  for (const q of questions) {
    if (/\bor\b/i.test(String(q.number)) && !grouped.has(normalizeQuestionNumber(q.number))) {
      error('CHOICE_RULE_NOT_ENCODED', q.number, `${q.number} is an OR alternative but belongs to no choice group, so both alternatives would be scored.`);
    }
  }

  if (rubric.key_check?.error) {
    warnings.push({ code: 'KEY_CHECK_UNAVAILABLE', question: null, message: `The independent key check could not run: ${rubric.key_check.error}` });
  }

  // The paper's own printed total. exam.total_marks falls back to the raw question sum
  // when the paper declares none, so it cannot be used here.
  const declared = Number(exam.declared_total_marks ?? rubric.quality?.declaredTotalMarks);
  if (Number.isFinite(declared) && declared > 0 && questions.length) {
    const effective = effectiveTotal(questions, exam.scoring_plan);
    if (Math.abs(effective - declared) > 0.01) {
      error('TOTAL_MISMATCH', null, `Questions add up to ${effective} marks after choice rules, but the paper's total is ${declared}.`);
    }
  }
  return { errors, warnings };
}

/** An override needs a written reason; returns the trimmed reason or null. */
export function validOverrideReason(reason) {
  const value = String(reason || '').trim();
  return value.length >= OVERRIDE_REASON_MIN_CHARS ? value : null;
}
