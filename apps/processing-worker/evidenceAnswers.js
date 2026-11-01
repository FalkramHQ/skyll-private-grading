import { text } from './workerUtils.js';

const CONFIDENCE = ['low', 'medium', 'high'];

/**
 * Canonical question-number key. All places that key answers by question
 * number must normalize identically, otherwise "Q1" vs "q1" vs "1" mismatch
 * (gap-fill keying, presence counting, answer unification).
 */
export function questionKey(value) {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * Normalize raw model-extracted answers against the rubric.
 *
 * FIX (FLKRM-152): `absence` of an answer entry is NOT evidence that a student
 * left the question blank. Previously a missing entry defaulted `confidence` to
 * `'medium'`, so the evidence_blocked guard never fired and the question was
 * graded 0 with no review flag — indistinguishable from a genuine blank.
 *
 * Rules now:
 *  - Missing answer entry  -> confidence `'low'`, attempted `false` (blocked).
 *  - The model's explicit `attempted` flag is honored in BOTH directions:
 *    `attempted: true` stays attempted, `attempted: false` stays not-attempted
 *    (never inferred from leftover text — the keyword-bleed bug).
 *  - Only when the model gives no attempted signal do we infer it from text
 *    presence, and only for a confident (non-low) answer.
 *  - Low-confidence questions are routed to review, never graded confidently.
 */
// OCR strike-through markup. cleanOcrText turns <del>/<s>/<strike> into ~~…~~.
const STRUCK = /~~([\s\S]+?)~~|<(del|s|strike)\b[^>]*>([\s\S]*?)<\/\2>/gi;

/**
 * Splits struck-through text out of an extracted answer, so crossed-out work
 * is never graded even when the model copied the OCR markup into the answer.
 */
export function splitStruckText(value) {
  const struck = [];
  const kept = String(value || '').replace(STRUCK, (match, tilde, tag, inner) => {
    const part = String(tilde ?? inner ?? '').trim();
    if (part) struck.push(part);
    return ' ';
  });
  return {
    kept: kept.replace(/[ \t]{2,}/g, ' ').replace(/ *\n */g, '\n').trim(),
    struck: struck.join('\n'),
  };
}

const verbatimWords = (value) => String(value || '').normalize('NFKC').toLowerCase()
  .replace(/~~|<[^>]+>/g, ' ')
  .replace(/\\[a-z]+/gi, ' ')
  .split(/[^\p{L}\p{N}\p{M}]+/u)
  .filter((word) => word.length > 1);

/**
 * Whether an extracted answer is really in the student's OCR text: at least
 * `minShare` of its words appear there. Catches the extraction model rewriting
 * ("correcting") what the student wrote, e.g. German verb forms. Answers under
 * `minWords` words are not judged (single letters, short numerics).
 */
export function answerFoundInOcr(answerText, ocrText, { minWords = 5, minShare = 0.75 } = {}) {
  const words = verbatimWords(answerText);
  if (words.length < minWords) return true;
  const ocr = new Set(verbatimWords(ocrText));
  return words.filter((word) => ocr.has(word)).length / words.length >= minShare;
}

export function normalizeEvidenceAnswers(raw, rubric) {
  const byNumber = new Map(
    (Array.isArray(raw?.answers) ? raw.answers : []).map((item) => [
      questionKey(item.question_number || item.number),
      item,
    ]),
  );
  return rubric.questions.map((question) => {
    const value = byNumber.get(questionKey(question.number));
    const confidence = CONFIDENCE.includes(value?.confidence)
      ? value.confidence
      : 'low';
    const hasText = Boolean(text(value?.student_answer || value?.student_wrote));
    // Respect the model's explicit `attempted` flag in BOTH directions:
    //  - attempted:true  -> always treated as attempted
    //  - attempted:false -> never inferred from text presence (a leftover-OCR
    //    "answer" at medium confidence is the old keyword-bleed bug and must not
    //    be graded confidently just because there is text).
    // Only when the model gives no attempted signal do we infer it from text
    // presence, and only for a confident (non-low) answer.
    const hasExplicitAttempted = value?.attempted !== undefined && value?.attempted !== null;
    const attempted = hasExplicitAttempted
      ? Boolean(value.attempted)
      : (confidence !== 'low' && hasText);
    const pages = Array.isArray(value?.source_pages)
      ? value.source_pages.map(Number).filter(Number.isFinite)
      : [];
    // withSourcePages (#343) replaces the model's page claim (always the
    // prompt's [0]) with text-match pages, which are always [] for a blank. The
    // claim survives only as this verdict: a confident, explicit attempted:false
    // entry that names a page means the student skipped the question. The
    // all-MCQ parser's placeholders name no page, so a parse miss stays blocked.
    const confirmedBlank = hasExplicitAttempted && !attempted && confidence !== 'low' && pages.length > 0;
    // VL is ONLY triggered when the question itself requires visual content.
    // needs_visual_rescue from the mapper is IGNORED for text-only questions.
    const questionRequiresVisual = Boolean(question.visual_requirements) ||
      /\[image\]|\[diagram\]|\[img-/i.test(question.question_text || '');
    const visual = questionRequiresVisual && (
      Boolean(value?.needs_visual_rescue) || Boolean(question.visual_requirements)
    );
    const { kept, struck } = splitStruckText(value?.student_answer || value?.student_wrote || '');
    return {
      question,
      attempted,
      // Verbatim OCR mapping only — never keep model-invented "final_answer" polish.
      studentAnswer: text(kept, 30000),
      finalAnswer: '',
      crossedOutWork: text([value?.crossed_out_work, struck].filter((part) => String(part || '').trim()).join('\n'), 12000),
      sourcePages: pages,
      confirmedBlank,
      confidence,
      needsVisualRescue: visual,
      visualReason: text(value?.visual_reason || question.visual_requirements || '', 2000),
    };
  });
}

/**
 * Decide how a normalized answer is surfaced.
 *
 * A low-confidence blank is not evidence that a student left the question
 * blank — hold it for evidence repair/review rather than silently turning it
 * into zero. Missing-answer entries become `evidence_blocked` (flagged), never
 * a confident 0.
 */
export function evidenceOutcome(answer, { ocrIncomplete = false } = {}) {
  // Block when there is NO usable gradeable evidence: no student text AND no
  // source pages. A truncated { attempted: true, student_answer: '' }, a
  // low-confidence blank, a missing entry, or a confident-but-empty attempted
  // entry all carry nothing to grade and must be flagged, never silently scored
  // 0 (FLKRM-152). The one exception is the model's confident verdict that the
  // student skipped the question (confirmedBlank): that is not_attempted.
  const confirmedBlank = Boolean(answer.confirmedBlank) && !answer.attempted;
  const noUsableEvidence = !answer.studentAnswer && !answer.sourcePages.length && !confirmedBlank;
  // When part of the student's OCR never reached the extraction prompt, a blank
  // is not evidence of a skipped question: the answer may be on a page the model
  // never saw. Block it even if the model echoed source_pages or said "high".
  const blocked = noUsableEvidence || (ocrIncomplete && !answer.studentAnswer);
  const flagged = Boolean(answer.needsVisualRescue) || answer.confidence === 'low' || blocked;
  return {
    blocked,
    status: blocked
      ? 'evidence_blocked'
      : answer.attempted ? 'pending' : 'not_attempted',
    flagged,
    reviewPriority: flagged ? 'flagged' : 'normal',
  };
}

/**
 * Count how many rubric questions got ANY answer entry from the model
 * (presence, independent of whether it was attempted). Used to detect
 * truncated JSON / chunk drops before persisting.
 */
export function answerPresenceCount(raw, rubric) {
  const present = new Set(
    (Array.isArray(raw?.answers) ? raw.answers : [])
      .map((item) => questionKey(item.question_number || item.number)),
  );
  return rubric.questions.filter((q) => present.has(questionKey(q.number))).length;
}
