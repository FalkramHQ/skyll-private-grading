import {
  LEAKED_REASONING_TAG,
  feedbackHasDevanagari,
  feedbackLeaksReasoning,
  gradingLanguageInstruction,
  isSubjectiveResponseType,
  mergeReviewTags,
  normalizeCriteria,
  parseRubricCriteria,
  resolveGradingLanguage,
  subjectivePartialCreditPolicy,
} from '../../shared/harshZero.js';
import { hasUnreadRegion, UNREAD_REGION_MARKER, UNREAD_REGION_TAG } from '../../shared/unreadRegion.js';
import {
  DUPLICATE_EVIDENCE_TAG,
  THIN_ANSWER_TAG,
  UNCLEAR_SYMBOLS_TAG,
  UNQUOTED_CREDIT_TAG,
  gradingCalibrationModeFor,
  isSymbolHeavyAnswer,
  subjectGradingRules,
  isThinAnswer,
  strictPartialCreditPolicy,
} from '../../shared/gradingCalibration.js';

const VISUAL_UNVERIFIED_REASON = /\b(?:visual|image|diagram|figure)\b[^.;]{0,60}\b(?:unverified|not verified|cannot be verified|not visible|human review)\b|\bunverified\b[^.;]{0,40}\b(?:visual|image|diagram|figure)/i;

function text(value, limit = 12000) {
  return String(value || '').trim().slice(0, limit);
}

function scoreStatus(marks, total, attempted = true) {
  if (!attempted) return 'not_attempted';
  if (Number(marks) >= Number(total)) return 'correct';
  return Number(marks) > 0 ? 'partial' : 'incorrect';
}

function roundMarks(value) {
  return Math.round(Number(value) * 100) / 100;
}

const PART_STATUSES = ['correct', 'partial', 'incorrect', 'not_attempted'];

/* Normalize free-form parts[] returned by the model for compound questions.
 * Each sub-part is coerced to a stable, typed shape (no `any`). Marks default to
 * 0 and rounds to two decimals; status is derived from marks when the model
 * omits or contradicts it; the part list is capped to guard against runaway
 * output. When no parts are provided we return null so callers can fall back to
 * the legacy flattened-prose rendering. */
export function normalizeParts(rawParts) {
  if (!Array.isArray(rawParts)) return null;
  const parts = rawParts.slice(0, 50).map((part, index) => {
    const marksObtained = roundMarks(Number(part?.marks_obtained ?? part?.marks_awarded ?? part?.marks ?? 0) || 0);
    const marks_total = roundMarks(Number(part?.marks_total ?? part?.max_marks ?? 0) || 0);
    const rawStatus = String(part?.status || '').trim().toLowerCase();
    let status = PART_STATUSES.includes(rawStatus) ? rawStatus : null;
    if (!status) {
      status = marksObtained >= marks_total && marks_total > 0
        ? 'correct'
        : marksObtained > 0 ? 'partial' : 'incorrect';
    }
    return {
      label: text(part?.label ?? part?.number ?? `Part ${index + 1}`, 200),
      prompt: text(part?.prompt ?? part?.question ?? '', 4000),
      response: text(part?.response ?? part?.student_response ?? part?.student_answer ?? '', 6000),
      expected: text(part?.expected ?? part?.expected_answer ?? part?.correct_answer ?? '', 4000),
      marks_obtained: marksObtained,
      marks_total,
      status,
    };
  });
  return parts.length ? parts : null;
}

/**
 * Parse MCQ +4 / 0 / -1 (or similar) schemes from rubric or exam instructions.
 * Returns null when the paper has no negative marking.
 */
export function parseMcqMarkScheme(rubricText = '', maxMarks = 0) {
  const source = String(rubricText || '');
  if (!source.trim()) return null;
  const neg = source.match(/negative\s*marks?\s*:\s*-?\s*(\d+(?:\.\d+)?)/i)
    || source.match(/deduct(?:s|ion)?\s*(?:of\s*)?-?\s*(\d+(?:\.\d+)?)/i)
    || source.match(/-\s*(\d+(?:\.\d+)?)\s*(?:marks?)?\s*(?:for|in)\s+(?:any\s+other|incorrect|wrong|all\s+other)/i)
    || source.match(/-\s*(\d+(?:\.\d+)?)\s*in\s+all\s+other/i)
    || source.match(/(?:award|give|score)\s*-?\s*(\d+(?:\.\d+)?)\s*(?:marks?)?\s*(?:for|on)\s+(?:any\s+other|incorrect|wrong|other\s+selection)/i);
  if (!neg) return null;
  const incorrect = -Math.abs(Number(neg[1]));
  if (!Number.isFinite(incorrect) || incorrect >= 0) return null;
  const correctMatch = source.match(/full\s*marks?\s*:\s*\+?\s*(\d+(?:\.\d+)?)/i)
    || source.match(/award\s*\+?\s*(\d+(?:\.\d+)?)/i)
    || source.match(/\+?\s*(\d+(?:\.\d+)?)\s*(?:marks?)?\s*(?:for\s+)?(?:correct|only\s+the\s+alphabet|selected\s+option\s+is\s+exactly)/i)
    || source.match(/(\d+(?:\.\d+)?)\s*marks?\s+for\s+correct/i);
  const correct = Number.isFinite(Number(correctMatch?.[1]))
    ? Number(correctMatch[1])
    : Number(maxMarks) || 0;
  return {
    correct: correct > 0 ? correct : Number(maxMarks) || 0,
    blank: 0,
    incorrect,
  };
}

function hasMcqAnswerEvidence(evidence = {}) {
  if (evidence.attempted === false || evidence.attempted === 0 || evidence.attempted === '0') return false;
  const chunks = [
    evidence.student_answer,
    evidence.option_letter,
    evidence.optionLetter,
  ].map((value) => text(value, 400));
  return chunks.some(Boolean);
}

/**
 * Enforce three-valued MCQ scoring when a negative scheme is present.
 * Wrong attempted answers become the penalty; blanks stay 0; correct stays full.
 */
export function applyMcqMarkScheme(scheme, { maxMarks, attempted, hasAnswer, rawMarks }) {
  if (!scheme) return null;
  const correct = Number(scheme.correct) || Number(maxMarks) || 0;
  const blank = Number(scheme.blank) || 0;
  const incorrect = Number(scheme.incorrect);
  if (!Number.isFinite(incorrect) || incorrect >= 0) return null;
  if (!attempted || !hasAnswer) return blank;
  if (Number(rawMarks) >= correct || Number(rawMarks) >= Number(maxMarks)) return correct;
  return incorrect;
}

/**
 * Normalize a model grade payload.
 * Subjective items: prefer criteria[].marks sum; enforce idea credit when prose
 * admits understanding but a criterion (or the total) is still 0.
 */
export function normalizeGradeResult(raw, question, evidence, responseType = '', options = {}) {
  const max = Number(question.marks_total || 0);
  const attempted = evidence.attempted !== false;
  const resolvedType = responseType || question.expected_response_type || '';
  const subjective = isSubjectiveResponseType(resolvedType)
    && !['mcq', 'numerical', 'diagram', 'table'].includes(String(resolvedType).toLowerCase());
  const whatWentCorrect = text(raw?.what_went_correct, 4000);
  const mode = options.mode || gradingCalibrationModeFor(options.subject || question.test_subject);
  // The grader's own doubts, minus restatements of an unverified diagram, which
  // the visual_evidence_unverified tag already carries (83 of 104 free-text
  // reasons, Oct 2026). A needs_review with no reason left is not a doubt.
  const visualUnverified = Boolean(evidence.needs_visual_rescue && !evidence.visual_rescue?.usable);
  const modelReasons = (Array.isArray(raw?.review_reasons) ? raw.review_reasons : [])
    .map((item) => text(item, 240))
    .filter(Boolean)
    .filter((reason) => !(visualUnverified && VISUAL_UNVERIFIED_REASON.test(reason)));
  let review = (Boolean(raw?.needs_review) && modelReasons.length > 0)
    || evidence.extraction_confidence === 'low'
    || (evidence.needs_visual_rescue && !evidence.visual_rescue?.usable)
    || hasUnreadRegion(evidence.student_answer);

  const rubricText = options.markingRubric
    || question.marking_rubric
    || '';
  const stubs = subjective
    ? (Array.isArray(options.rubricCriteria) && options.rubricCriteria.length
      ? options.rubricCriteria
      : parseRubricCriteria(rubricText, max))
    : [];

  const type = String(resolvedType || '').toLowerCase();
  const isMcq = type === 'mcq';
  const markScheme = isMcq
    ? parseMcqMarkScheme([
      options.markingRubric,
      question.marking_rubric,
      options.examInstructions,
      question.exam_instructions,
    ].filter(Boolean).join('\n'), max)
    : null;
  const minMark = markScheme ? Number(markScheme.incorrect) : 0;

  let criteria = [];
  let marks = Math.max(minMark, Math.min(max, Number(raw?.marks_awarded) || 0));
  const calibrationTags = [];

  if (subjective && attempted) {
    const normalized = normalizeCriteria(raw?.criteria, stubs, {
      whatWentCorrect,
      mode,
      studentAnswer: evidence.student_answer || '',
    });
    criteria = normalized.criteria;
    if (criteria.length) {
      marks = Math.max(0, Math.min(max, roundMarks(normalized.sum)));
    }
    if (normalized.unquotedIds?.length) calibrationTags.push(UNQUOTED_CREDIT_TAG);
  }

  // Every mode: an answer already credited under another question scores 0 for
  // review, so one answer is never credited twice. Calibrated/strict only: one
  // with no content beyond the question's own words also scores 0 (not in flag
  // or legacy mode: that floor's ASCII-only tokeniser reads Hindi as empty).
  const thinFloor = mode === 'calibrated' || mode === 'strict';
  if (subjective && attempted && marks > 0 && (evidence.duplicate_of || thinFloor)) {
    const zeroReason = evidence.duplicate_of
      ? DUPLICATE_EVIDENCE_TAG
      : isThinAnswer({
        studentAnswer: evidence.student_answer || '',
        questionText: question.question_text || '',
        maxMarks: max,
        responseType: resolvedType,
      }) ? THIN_ANSWER_TAG : null;
    if (zeroReason) {
      marks = 0;
      criteria = criteria.map((c) => ({ ...c, marks: 0 }));
      calibrationTags.push(zeroReason);
    }
  }
  if (calibrationTags.length) review = true;

  const answered = hasMcqAnswerEvidence(evidence);
  // The batch grader never returned a verdict for this question. We do not know
  // whether the selected option was right or wrong, so treat it like a blank
  // (0, or the scheme's blank value) and leave it flagged. Applying the
  // negative-marking penalty here would punish the student for a model gap.
  const answerUnknown = Array.isArray(raw?.review_reasons)
    && raw.review_reasons.includes('missing_from_batch_response');
  const schemeMarks = applyMcqMarkScheme(markScheme, {
    maxMarks: max,
    attempted,
    hasAnswer: answered && !answerUnknown,
    rawMarks: Number(raw?.marks_awarded) || marks,
  });
  if (schemeMarks != null) {
    marks = schemeMarks;
  } else if (isMcq) {
    // MCQs are never partial: full credit, blank/wrong zero, or an explicit negative scheme.
    if (!answered || attempted === false || answerUnknown) marks = 0;
    else if (marks > 0 && marks < max) marks = 0;
    else marks = marks >= max ? max : 0;
  }
  const effectiveAttempted = markScheme ? answered : attempted;

  let reasoning = text(raw?.grading_reasoning, 6000);
  if (!reasoning && effectiveAttempted) {
    reasoning = marks === max || (markScheme && marks === markScheme.correct)
      ? 'Full marks awarded — answer matches the expected response.'
      : marks > 0
        ? `Partial credit (${marks}/${max}) — answer is partially correct.`
        : marks < 0
          ? `Negative marking applied (${marks}) — incorrect option selected.`
          : 'No marks awarded — answer does not match the expected response.';
  } else if (!reasoning && markScheme && !answered) {
    reasoning = 'No option selected — scored as unattempted (0).';
  }

  const reviewReasons = mergeReviewTags(
    modelReasons,
    evidence.needs_visual_rescue && !evidence.visual_rescue?.usable ? ['visual_evidence_unverified'] : [],
    hasUnreadRegion(evidence.student_answer) ? [UNREAD_REGION_TAG] : [],
    evidence.extraction_confidence === 'low' ? ['low_extraction_confidence'] : [],
    evidence.extraction_confidence === 'low' && isSymbolHeavyAnswer(evidence.student_answer, options.subject || question.test_subject)
      ? [UNCLEAR_SYMBOLS_TAG] : [],
    calibrationTags,
  );

  let needsAttention = text(raw?.needs_attention, 4000);
  let nextStep = text(raw?.next_step, 4000);
  let cleanWhatWentCorrect = whatWentCorrect;
  const rawParts = normalizeParts(raw?.parts, max);
  // Keep displayed sub-part marks consistent when strict calibration zeroed the item.
  const parts = rawParts && marks === 0 && calibrationTags.some((tag) => tag === THIN_ANSWER_TAG || tag === DUPLICATE_EVIDENCE_TAG)
    ? rawParts.map((part) => ({ ...part, marks_obtained: 0, status: part.status === 'not_attempted' ? part.status : 'incorrect' }))
    : rawParts;
  const language = resolveGradingLanguage({
    subject: options.subject || question.test_subject || '',
    studentAnswer: evidence.student_answer || '',
    explicit: options.language,
  });
  const safeReasoning = () => (marks === max || (markScheme && marks === markScheme.correct)
    ? 'Full marks awarded — answer matches the expected response.'
    : marks > 0
      ? `Partial credit (${marks}/${max}) — answer is partially correct.`
      : marks < 0
        ? `Negative marking applied (${marks}) — incorrect option selected.`
        : effectiveAttempted
          ? 'No marks awarded — answer does not match the expected response.'
          : 'No response captured for this question.');
  if (language === 'english' && feedbackHasDevanagari(cleanWhatWentCorrect, needsAttention, nextStep, reasoning)) {
    // Model ignored English-only policy — keep marks, replace prose with safe English.
    cleanWhatWentCorrect = '';
    needsAttention = '';
    nextStep = '';
    reasoning = safeReasoning();
    reviewReasons.push('feedback_language_fallback_english');
  }
  if (feedbackLeaksReasoning(cleanWhatWentCorrect, needsAttention, nextStep, reasoning)) {
    // The model wrote its own working notes into the feedback ("I will output the
    // JSON"). Students see this text, so drop each leaking field; the mark came
    // from a confused response, so a teacher confirms it.
    if (feedbackLeaksReasoning(cleanWhatWentCorrect)) cleanWhatWentCorrect = '';
    if (feedbackLeaksReasoning(needsAttention)) needsAttention = '';
    if (feedbackLeaksReasoning(nextStep)) nextStep = '';
    if (feedbackLeaksReasoning(reasoning)) reasoning = safeReasoning();
    review = true;
    reviewReasons.push(LEAKED_REASONING_TAG);
  }

  return {
    marks,
    attempted: effectiveAttempted,
    status: scoreStatus(marks, max, effectiveAttempted),
    confidence: ['low', 'medium', 'high'].includes(raw?.confidence) ? raw.confidence : review ? 'low' : 'medium',
    whatWentCorrect: cleanWhatWentCorrect,
    needsAttention,
    nextStep,
    reasoning,
    needsReview: review,
    reviewReasons: [...new Set(reviewReasons)],
    // A zero whose note reads like credit is no longer flagged: the note-reading
    // heuristic misread "is not mentioned" as credit, and the grader's mark stands.
    isHarshZero: false,
    criteria,
    criteriaEnforced: false,
    enforcedCriterionIds: [],
    markScheme: markScheme || null,
    parts,
  };
}

/**
 * One-call grading prompt for all-MCQ papers.
 * Expects the model to return marks for every listed question in a single JSON object.
 */
export function buildMcqBatchGradePrompt({ items, subject = '' }) {
  const rows = (items || []).map((item, index) => {
    const maxMarks = Number(item.question?.marks_total || item.rubric?.marks_allocated || 0);
    const markScheme = parseMcqMarkScheme([
      item.rubric?.marking_rubric,
      item.rubric?.exam_instructions,
      item.question?.exam_instructions,
    ].filter(Boolean).join('\n'), maxMarks);
    const schemeNote = markScheme
      ? ` scheme=+${markScheme.correct}/0/${markScheme.incorrect}`
      : ` max=${maxMarks}`;
    return `${index + 1}. ${item.question?.question_number || item.questionNumber || `Q${index + 1}`}${schemeNote}
Question: ${text(item.question?.question_text, 800)}
Official answer: ${text(item.question?.answer_key_text || item.question?.correct_answer || item.rubric?.correct_answer_summary, 400)}
Student attempted: ${item.evidence?.attempted !== false}
Student answer: ${text(item.evidence?.student_answer || item.evidence?.option_letter || 'No answer captured.', 600)}`;
  }).join('\n\n');

  const language = resolveGradingLanguage({
    subject,
    studentAnswer: (items || []).map((item) => item.evidence?.student_answer || '').join(' '),
  });
  const languagePolicy = gradingLanguageInstruction(language);

  return `Grade every MCQ below for one student in a single response. Use only the official answer and student evidence. Do not invent work. A correct option letter or unmistakably correct option content earns full credit. Blank / unattempted answers score 0 (or the blank value when a negative scheme is stated). Wrong selected options use the stated negative mark when present (e.g. "deduct 1" / "-1" means marks_awarded=-1, never max-1), otherwise 0. Never award partial marks between 0 and full credit.${languagePolicy}
Return JSON only: {"grades":[{"question_number":"Q1","marks_awarded":0,"confidence":"low|medium|high","needs_review":false,"review_reasons":[],"what_went_correct":"","needs_attention":"","grading_reasoning":""}]}. Include exactly one grades[] entry per question listed, using the same question_number strings.

${rows}`;
}

const PART_LABEL = /(?:^|[\s.;:])\(([a-h])\)\s/gi;

/**
 * Guidance for matching sub-answers to sub-questions by content. Students label
 * answers by the order they write them, so when a paper prints its parts out of
 * order ("(a) … (c) … [3] (b) … [4]") an answer labelled (b) can answer the
 * printed (c): on the PartnerD ICSE History & Civics semi-prelim a correct "impacts"
 * answer was marked against the "clauses" criterion (Oct 2026). Empty for a
 * question without lettered parts.
 */
export function partOrderPolicy(questionText = '') {
  const labels = [];
  let match;
  PART_LABEL.lastIndex = 0;
  while ((match = PART_LABEL.exec(String(questionText || ''))) !== null) {
    const label = match[1].toLowerCase();
    if (!labels.includes(label)) labels.push(label);
  }
  if (labels.length < 2) return '';
  const base = ' Match each part of the student answer to the sub-question it actually answers by its content, not only by its label: students often number answers by position or misnumber them. Credit a correct answer against the sub-question it answers.';
  const inOrder = labels.every((label, index) => index === 0 || label > labels[index - 1]);
  if (inOrder) return base;
  const printed = labels.map((label) => `(${label})`).join(', ');
  return `${base} This question prints its parts out of order (${printed}), so an answer labelled by position (for example "(b)" for the second part printed) may answer a differently lettered sub-question.`;
}

export function buildGradePrompt({ question, rubric, evidence, maxMarks, subject = '' }) {
  const responseType = String(rubric.expected_response_type || question.expected_response_type || '').toLowerCase();
  const subjective = isSubjectiveResponseType(responseType)
    && !['mcq', 'numerical', 'diagram', 'table'].includes(responseType);
  // An MCQ block graded item by item: its options (a)-(d) are not sub-questions.
  const mcqBlock = String(rubric.source_response_type || '').toLowerCase() === 'mcq';
  const calibration = gradingCalibrationModeFor(subject || question.test_subject || rubric.subject);
  const strict = calibration === 'strict';
  const partialPolicy = subjective ? `\n${strict ? strictPartialCreditPolicy() : subjectivePartialCreditPolicy()}` : '';
  const language = resolveGradingLanguage({
    subject: subject || question.test_subject || rubric.subject,
    studentAnswer: evidence.student_answer || '',
  });
  // The subject's own rules (shared/gradingProfiles) apply in every mode now that
  // no mode adds idea credit to offset over-strict marking.
  const subjectRules = subjectGradingRules(subject || question.test_subject || rubric.subject, question.test_title);
  const languagePolicy = gradingLanguageInstruction(language) + subjectRules;
  const stubs = subjective
    ? parseRubricCriteria(rubric.marking_rubric || '', maxMarks)
    : [];
  const criteriaHint = subjective && stubs.length
    ? `\nRubric criteria to score (use these ids/max values): ${JSON.stringify(stubs.map((s) => ({ id: s.id, max: s.max, label: s.label })))}`
    : '';
  const markScheme = responseType === 'mcq'
    ? parseMcqMarkScheme([rubric.marking_rubric, rubric.exam_instructions, question.exam_instructions].filter(Boolean).join('\n'), maxMarks)
    : null;
  const minMark = markScheme ? markScheme.incorrect : 0;
  // Only a single MCQ is all-or-nothing; a block of MCQs graded per item
  // (gradingResponseType) must not read this as "0 unless every item is right".
  const mcqSchemePolicy = responseType !== 'mcq'
    ? ''
    : markScheme
      ? `\nMCQ MARKING SCHEME (mandatory): award exactly ${markScheme.correct} for the correct option, ${markScheme.blank} if no option is selected, and ${markScheme.incorrect} for any other selected option. "Deduct 1" means the mark is ${markScheme.incorrect}, NOT ${markScheme.correct - Math.abs(markScheme.incorrect)}. Never award partial marks between 0 and full credit.`
      : '\nMCQ scoring is binary: full marks or 0 (or the stated negative mark). Never award partial marks.';
  const jsonShape = subjective
    ? `{"marks_awarded":0,"criteria":[{"id":"","max":0,"marks":0,"note":""${strict ? ',"evidence_quote":""' : ''}}],"parts":[{"label":"(ia)","prompt":"sub-question text","response":"student answer for this sub-part","expected":"expected answer for this sub-part","marks_obtained":0,"marks_total":1,"status":"correct|partial|incorrect|not_attempted"}],"confidence":"low|medium|high","needs_review":false,"review_reasons":[],"what_went_correct":"","needs_attention":"","next_step":"","grading_reasoning":""}`
    : '{"marks_awarded":0,"confidence":"low|medium|high","needs_review":false,"review_reasons":[],"what_went_correct":"","needs_attention":"","next_step":"","grading_reasoning":""}';
  const unreadPolicy = hasUnreadRegion(evidence.student_answer)
    ? ` The student answer contains ${UNREAD_REGION_MARKER} where part of the handwriting (often a formula, equation or order line) could not be read. Do not call content missing or wrong because it may be in that region: award marks only for what you can read, set needs_review to true, and in the feedback say that part of the answer could not be read and the teacher will check it.`
    : '';
  const partsHint = subjective
    ? `${mcqBlock ? '' : partOrderPolicy(question.question_text)}\nWhen the question has independently graded sub-parts (e.g. "1. (a) ... (b) ... (c) ..." or ten separate synonyms), ALSO return a "parts" array with one entry per sub-part: label, prompt (the sub-question text), response (the student's answer to that sub-part, empty if unattempted), expected (expected answer), marks_obtained, marks_total (the marks allocated to that sub-part), and status. The per-part marks_obtained MUST sum to the question's total marks_awarded. If the question is a single undivided item, omit "parts" entirely. Do not invent sub-parts that are not explicitly numbered in the question.`
    : '';
  return `Grade exactly one exam response. Use the question, official answer, rubric, and student evidence only. Do not invent work. Crossed-out work is not the final answer when a clear correction follows. Treat an unambiguous spelling or phonetic variation of the correct scientific term as correct unless spelling is explicitly assessed; a correct option letter or unmistakably correct option content earns full MCQ credit. The mark must be between ${minMark} and ${maxMarks}.${mcqSchemePolicy} If visual evidence is unverified, do not pretend to see it; flag review rather than guessing.${unreadPolicy}${languagePolicy}${partialPolicy}${criteriaHint}${partsHint} Return JSON only: ${jsonShape}.

Question: ${question.question_text}
Expected response type: ${responseType || 'unspecified'}
Official answer: ${question.answer_key_text || question.correct_answer || ''}
Rubric: ${rubric.marking_rubric || ''}
Accepted variations: ${JSON.stringify(rubric.accepted_variations || [])}
Student attempted: ${evidence.attempted !== false}
Student answer (OCR / reviewer text only — grade this, do not complete or correct it): ${evidence.student_answer || 'No answer captured.'}
Crossed-out work: ${evidence.crossed_out_work || 'None'}
Visual evidence: ${evidence.visual_rescue?.usable ? evidence.visual_rescue.description : evidence.needs_visual_rescue ? 'Unverified; require human review.' : 'Not required'}`;
}
