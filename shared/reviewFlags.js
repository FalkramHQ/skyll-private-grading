import { HARSH_ZERO_TAG, LEAKED_REASONING_TAG, PARTIAL_CREDIT_ENFORCED_TAG } from './harshZero.js';
import {
  DUPLICATE_EVIDENCE_TAG,
  IDEA_CREDIT_REVIEW_TAG,
  MARKS_INCONSISTENT_TAG,
  STATED_ERROR_TAG,
  THIN_ANSWER_TAG,
  UNQUOTED_CREDIT_TAG,
} from './gradingCalibration.js';
import { UNREAD_REGION_TAG } from './unreadRegion.js';
import { MCQ_LETTER_UNCLEAR_TAG } from './mcqBlock.js';

// Plain-English labels for the grading tags the worker writes to
// render_json.reviewTags, so a teacher reviewing a question sees why it was
// flagged instead of a bare "Flagged". `tone` maps to StatusBadge statuses.
// "flagged" and harsh_zero have their own badges and are not repeated here.
export const REVIEW_TAG_LABELS = {
  [IDEA_CREDIT_REVIEW_TAG]: { label: 'Zero may deserve credit', tone: 'caution', hint: 'The grader gave 0 but its note reads like the student showed some understanding. Check whether part marks are due.' },
  [STATED_ERROR_TAG]: { label: 'High mark despite an error', tone: 'caution', hint: 'The grader named a mistake but kept high marks. It was rechecked and could only be lowered; confirm the mark.' },
  [PARTIAL_CREDIT_ENFORCED_TAG]: { label: 'Partial credit added', tone: 'caution', hint: 'The grader gave 0 on a part its own note credits, so part marks were added automatically. Confirm they are earned.' },
  [LEAKED_REASONING_TAG]: { label: 'Grader notes removed', tone: 'caution', hint: 'The grader wrote its own working notes into the feedback, so that text was replaced. The mark came from a confused response; confirm it.' },
  [UNQUOTED_CREDIT_TAG]:{ label: 'Credit removed', tone: 'caution', hint: 'Marks were removed because the grader could not point to supporting words in the answer.' },
  [THIN_ANSWER_TAG]: { label: 'Answer judged too thin', tone: 'caution', hint: 'The answer adds little beyond the question\'s own words, so it was scored 0.' },
  [DUPLICATE_EVIDENCE_TAG]: { label: 'Same answer as another question', tone: 'caution', hint: 'This answer matches the one given for another question; it should be credited once.' },
  // Written by the Phase 3 extraction checks (#375's follow-up): a low-confidence, mostly-symbol answer.
  symbol_answer_unclear: { label: 'Maths answer unclear', tone: 'critical', hint: 'This working was read with low confidence and is mostly symbols, where one misread character changes the answer. Check it against the answer sheet before approving.' },
  low_extraction_confidence: { label: 'Answer hard to read', tone: 'caution', hint: 'The answer text was read with low confidence. Compare it with the answer sheet before approving.' },
  [UNREAD_REGION_TAG]: { label: 'Part of answer unreadable', tone: 'critical', hint: 'The page reader skipped part of this answer, often a formula or an order line, so marks for it may be missing. Check the answer sheet before approving.' },
  visual_evidence_unverified: { label: 'Diagram not verified', tone: 'caution', hint: 'The answer depends on a diagram or figure that could not be checked automatically.' },
  visual_evidence_required: { label: 'Needs the diagram', tone: 'caution', hint: 'This question is marked on a diagram or figure; check the answer sheet.' },
  evidence_capture_incomplete: { label: 'Answer may be incomplete', tone: 'caution', hint: 'Part of the answer may not have been captured from the pages.' },
  ocr_input_truncated: { label: 'Pages cut short', tone: 'caution', hint: 'The answer sheet text was too long and was cut off before grading.' },
  [MARKS_INCONSISTENT_TAG]: { label: 'Marks disagree', tone: 'critical', hint: 'The part breakdown, the criteria or the stated total did not add up to the mark, even after one re-mark. Check the mark before approving.' },
  [MCQ_LETTER_UNCLEAR_TAG]: { label: 'MCQ choice unreadable', tone: 'critical', hint: 'The chosen option could not be read for some items (an overwrite or an unreadable letter), so they scored 0. Check them against the answer sheet.' },
  missing_from_batch_response: { label: 'Not graded in batch', tone: 'critical', hint: 'The grader returned no mark for this question; it needs a manual mark.' },
  feedback_language_fallback_english: { label: 'Feedback in English', tone: 'neutral', hint: 'Feedback could not be written in the paper\'s language and is in English.' },
};

const OWN_BADGES = new Set(['flagged', HARSH_ZERO_TAG]);

const humanize = (tag) => String(tag).replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

const KEY_CHECK_RESOLUTION_TEXT = {
  open: 'Approved without resolving this finding.',
  kept: 'The admin kept the key.',
  alternative: 'The admin accepted this as an alternative answer.',
  corrected: 'The admin corrected the key.',
};

/**
 * What a teacher should know about the independent key check for this question:
 * only findings that needed an admin decision (open, kept, alternative,
 * corrected). Returns null otherwise.
 */
export function keyCheckFinding(keyCheck) {
  if (!keyCheck || typeof keyCheck !== 'object') return null;
  const resolution = KEY_CHECK_RESOLUTION_TEXT[keyCheck.status];
  if (!resolution) return null;
  const answer = String(keyCheck.checker_answer || '').trim();
  const verdict = keyCheck.verdict === 'alternative'
    ? 'Another printed option also looks correct'
    : 'An independent check disagreed with the key';
  return {
    status: keyCheck.status,
    summary: answer ? `${verdict}: ${answer}` : verdict,
    note: String(keyCheck.note || '').trim(),
    resolution,
  };
}

/**
 * The flags to show on one review item, most important first: grading tags
 * with labels, an answer credited under another question, and a key-check
 * finding. Unknown tags still show, humanized.
 */
export function reviewFlagsFor(item = {}) {
  const flags = [];
  const seen = new Set();
  for (const tag of Array.isArray(item.reviewTags) ? item.reviewTags : []) {
    if (!tag || OWN_BADGES.has(tag) || seen.has(tag)) continue;
    seen.add(tag);
    const known = REVIEW_TAG_LABELS[tag];
    flags.push({ key: tag, label: known?.label || humanize(tag), tone: known?.tone || 'neutral', hint: known?.hint || '' });
  }
  if (item.duplicateOf) {
    flags.push({ key: 'duplicate_of', label: `Credited under ${item.duplicateOf}`, tone: 'caution', hint: `This answer was matched to ${item.duplicateOf} as well, which fits it better; it should earn credit there only.` });
  }
  const finding = keyCheckFinding(item.keyCheck);
  if (finding) {
    flags.push({ key: 'key_check', label: finding.status === 'open' ? 'Key disputed' : 'Key was checked', tone: finding.status === 'open' ? 'critical' : 'info', hint: `${finding.summary}. ${finding.resolution}` });
  }
  const rank = { critical: 0, caution: 1, info: 2, neutral: 3 };
  return flags.sort((a, b) => rank[a.tone] - rank[b.tone]);
}
