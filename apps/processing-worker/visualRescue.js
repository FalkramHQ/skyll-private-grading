/**
 * Visual-rescue page targeting + description validation.
 * Prevents whole-sheet VL from describing the wrong question (e.g. Q2 for Q8).
 */

export function questionNumberValue(raw) {
  const match = String(raw || '').match(/(\d+)/);
  return match ? Number(match[1]) : null;
}

/** Match handwritten/OCR labels like "Q.8", "Q 8)", "8)", "Q. 8". */
export function questionLabelRegex(questionNumber) {
  const n = questionNumberValue(questionNumber);
  if (!Number.isFinite(n)) return null;
  return new RegExp(
    String.raw`(?:^|[^\d])(?:Q\.?\s*)?${n}(?!\d)\s*[).:\-]`,
    'im',
  );
}

export function markdownMentionsQuestion(markdown, questionNumber) {
  const re = questionLabelRegex(questionNumber);
  if (!re) return false;
  return re.test(String(markdown || ''));
}

export function extractQuestionLabels(markdown) {
  const found = new Set();
  const re = /(?:^|[^\dA-Za-z])Q\.?\s*(\d{1,2})(?!\d)/gim;
  let match;
  while ((match = re.exec(String(markdown || ''))) !== null) {
    found.add(Number(match[1]));
  }
  return [...found].sort((a, b) => a - b);
}

export function dedupeAssetsPreserveOrder(assetIds) {
  const seen = new Set();
  const out = [];
  for (const id of assetIds || []) {
    const key = String(id || '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * Rank answer-sheet pages for a target question.
 * Prefer OCR pages that mention the question label; fall back to source_pages;
 * never prefer a page that only shows earlier unrelated questions when a labeled page exists.
 */
export function rankVisualPages({
  orderedAssetIds,
  sourcePages = [],
  pageMarkdownByAssetId = {},
  questionNumber,
}) {
  const deduped = dedupeAssetsPreserveOrder(orderedAssetIds);
  if (!deduped.length) return [];

  const target = questionNumberValue(questionNumber);
  // source_pages are 1-based sheet pages located by OCR text matching (#343).
  // Older rows carry a meaningless [0] from the model; page 0 never matches.
  const sourceHits = new Set();
  for (const page of Array.isArray(sourcePages) ? sourcePages.map(Number) : []) {
    if (Number.isInteger(page) && page >= 1 && deduped[page - 1]) sourceHits.add(deduped[page - 1]);
  }

  const scored = deduped.map((assetId, index) => {
    const md = pageMarkdownByAssetId[assetId] || '';
    const labels = extractQuestionLabels(md);
    const mentionsTarget = Number.isFinite(target) && labels.includes(target);
    const onlyEarlier = Number.isFinite(target)
      && labels.length > 0
      && !mentionsTarget
      && labels.every((n) => n < target);
    let score = 0;
    if (mentionsTarget) score += 20;
    if (sourceHits.has(assetId)) score += 5;
    if (onlyEarlier) score -= 8;
    if (!md) score -= 1;
    return { assetId, index, score, mentionsTarget, labels, sourceHit: sourceHits.has(assetId) };
  });

  scored.sort((a, b) => b.score - a.score || a.index - b.index);

  const labeled = scored.filter((row) => row.mentionsTarget);
  if (labeled.length) return labeled;

  const sourceRanked = scored.filter((row) => sourceHits.has(row.assetId));
  if (sourceRanked.length) return sourceRanked;

  // No OCR label and no usable source_pages — try non-penalized pages first.
  const neutral = scored.filter((row) => row.score >= 0);
  return neutral.length ? neutral : scored;
}

const ANCHOR_CHARS = 240;

/**
 * The opening of the answer the OCR reader linked to a page, to point the vision
 * model at it when the page carries no question label. Students often write only
 * "(iii)" under a heading on an earlier page, or draw a map on a fresh sheet, so
 * a label-only prompt answered QUESTION_NOT_ON_PAGE for answers that were there
 * (29 of 29 unverified diagrams, Oct 2026). Empty when there is no usable text.
 */
export function visualAnswerAnchor(studentAnswer) {
  const value = String(studentAnswer || '').replace(/\s+/g, ' ').trim();
  if (value.length < 12) return '';
  return value.length > ANCHOR_CHARS ? `${value.slice(0, ANCHOR_CHARS)}…` : value;
}

export function buildVisualRescuePrompt(question, rubric = {}) {
  const number = question?.question_number || question?.number || '';
  const questionText = question?.question_text || '';
  const visualReq = rubric.visual_requirements || 'none stated';
  const anchor = String(question?.visual_answer_anchor || '').trim();
  if (anchor) {
    return [
      `Describe ONLY the student's handwritten answer for ${number}.`,
      `The text reader matched this page to that answer. Its text begins: "${anchor}"`,
      `The question number may not be written on this page: students often write only a sub-part label such as "(iii)" or "b)", or start a map or diagram on a fresh sheet. Find the answer by that opening text and the drawn figure, not by a "${number}" label.`,
      'If the image shows other questions too, describe only the answer that matches the text above.',
      `Reply exactly QUESTION_NOT_ON_PAGE only if no part of that answer is on this image.`,
      `Include visible structures, reaction schemes, map labels and positions, values, and crossings-out. Do not grade.`,
      `Question: ${questionText}`,
      `Expected visual requirement: ${visualReq}`,
    ].join('\n');
  }
  return [
    `Describe ONLY the student's handwritten answer for ${number}.`,
    `The image may contain other questions. Ignore every block that is not labeled ${number} / Q.${questionNumberValue(number)}.`,
    `If ${number} is not visibly labeled on this image, reply exactly: QUESTION_NOT_ON_PAGE`,
    `Do not describe, summarize, or substitute another question (for example Q.1 or Q.2) when ${number} is missing.`,
    `Include visible structures, reaction schemes, labels, values, and crossings-out for ${number} only. Do not grade.`,
    `Question: ${questionText}`,
    `Expected visual requirement: ${visualReq}`,
  ].join('\n');
}

/**
 * Reject VL output that admits the wrong question or invents a substitute.
 */
// Only phrases about the answer or question itself: "the refracted ray is not
// shown" or "does not show an ammeter" describe what a student left out of a
// diagram that is there, and must not read as a miss.
const ANSWER_ABSENT = /\b(?:does not (?:contain|show|include)|do(?:es)? not see)\s+(?:the|an?|any)\s+(?:student'?s?\s+)?(?:handwritten\s+)?(?:answer|response|question)\b|\b(?:answer|response)\b[^.;]{0,60}\bis not (?:present|visible|shown|on)\b|\bnot (?:present|visible) on (?:this|the) (?:page|image)\b|\bno (?:answer|response) (?:for|to)\b|\bnot in syllabus\b/i;

export function validateVisualRescueDescription(description, questionNumber, { anchored = false } = {}) {
  const text = String(description || '').trim();
  const target = questionNumberValue(questionNumber);
  if (!text) {
    return { ok: false, reason: 'Empty visual description.' };
  }
  if (/QUESTION_NOT_ON_PAGE/i.test(text)) {
    return { ok: false, reason: `Question ${questionNumber} not found on provided page(s).` };
  }
  // Said in prose instead of the sentinel ("The provided image does not contain
  // the answer…", "is not present on this page"), seen on anchored prompts.
  if (ANSWER_ABSENT.test(text)) {
    return { ok: false, reason: `Visual description says the answer to ${questionNumber} is not on the page.` };
  }
  if (!Number.isFinite(target)) {
    return { ok: true, reason: '' };
  }
  // An anchored page was found by the answer's own text, so a description that
  // says the number is not written on it is expected, not a miss. A described
  // substitute question is still rejected below.

  const missingSelf = new RegExp(
    String.raw`(?:no (?:question|q\.?)\s*(?:labeled|labelled|explicitly)?\s*(?:as\s*)?(?:q\.?\s*)?${target}\b|does not contain (?:a )?(?:question )?q\.?\s*${target}\b|not (?:contain|show|include).{0,40}q\.?\s*${target}\b)`,
    'i',
  );
  if (!anchored && missingSelf.test(text)) {
    return { ok: false, reason: `Visual description says ${questionNumber} is not on the page.` };
  }

  const assumesOther = new RegExp(
    String.raw`(?:assuming|instead|rather than|despite.{0,40}(?:prompt|request).{0,40}(?:q\.?\s*)?${target}).{0,80}(?:q\.?\s*)?(\d{1,2})\b`,
    'i',
  );
  const assumed = text.match(assumesOther);
  if (assumed && Number(assumed[1]) !== target) {
    return { ok: false, reason: `Visual description substituted Q.${assumed[1]} for ${questionNumber}.` };
  }

  // First Q-prefixed label should be the target. Ignore bare "1." / "2." step lists
  // in model prose (e.g. "1. The phenol reacts...") — those are not question markers.
  const qPrefixed = [];
  const reQ = /(?:^|[^\dA-Za-z])Q\.?\s*(\d{1,2})(?!\d)/gim;
  let match;
  while ((match = reQ.exec(text)) !== null) qPrefixed.push(Number(match[1]));
  const primary = qPrefixed[0];
  if (Number.isFinite(primary) && primary !== target) {
    return { ok: false, reason: `Visual description focused on Q.${primary} instead of ${questionNumber}.` };
  }

  return { ok: true, reason: '' };
}

export function isReviewerTouchedQuestion({
  reviewRevision = 0,
  reviewState = null,
  reviewerId = null,
} = {}) {
  if (Number(reviewRevision || 0) > 0) return true;
  if (reviewerId) return true;
  const state = String(reviewState || '').toLowerCase();
  return ['approved', 'flagged', 'corrected'].includes(state);
}
