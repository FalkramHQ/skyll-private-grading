// Datalab sometimes labels a handwritten line as a Figure (often a formula or an
// order such as "CH3I < CH3Br < CH3Cl < CH3F") and returns no text for it, so the
// line vanished from the answer and the grader marked it missing (PartnerD 12th
// Chemistry, 23 Oct 2026). OCR now puts this marker where each such region was:
// extraction keeps it in place, grading does not treat that part as missing, and
// the question is flagged so a teacher checks the answer sheet.
export const UNREAD_REGION_MARKER = '[unread region]';
export const UNREAD_REGION_TAG = 'ocr_region_unread';

const MARKDOWN_IMAGE = /!\[[^\]]*\]\([^)\s]*\)/g;

/** Replace each markdown image reference left by OCR with the unread-region marker. */
export function markUnreadRegions(markdown) {
  return String(markdown || '').replace(MARKDOWN_IMAGE, UNREAD_REGION_MARKER);
}

/** Whether a piece of answer text contains a region the OCR could not read. */
export function hasUnreadRegion(text) {
  return String(text || '').includes(UNREAD_REGION_MARKER);
}
