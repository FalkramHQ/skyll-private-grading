/** Defaults + heuristics for when a question needs visual rescue (VL). */

export const DEFAULT_VISUAL_REQUIREMENT = 'Student-drawn diagram/figure must be verified visually';

const DIAGRAM_CUE = /\b(neat\s+diagram|labelled\s+diagram|labeled\s+diagram|circuit\s+diagram|ray\s+diagram|draw\s+(a\s+)?(neat\s+)?(diagram|figure|circuit|graph|sketch)|with\s+the\s+help\s+of\s+(a\s+)?(neat\s+)?diagram|sketch\s+(the|a)\b|draw\s+and\s+(explain|describe)|figure\s+showing|ph\s*diagram|energy\s+level\s+diagram|block\s+diagram)\b/i;

const RUBRIC_DIAGRAM_CUE = /\b(\d+(\.\d+)?\s*marks?\s+[^\n.]{0,40}\bdiagram|diagram\b[^\n.]{0,40}\b\d+(\.\d+)?\s*marks?|marks?\s+for\s+(a\s+)?(neat\s+)?(labelled\s+|labeled\s+)?diagram)\b/i;

/**
 * Suggest visual_requirements text when the pack left it empty but the
 * question clearly expects a student-drawn figure.
 * @returns {string|null}
 */
export function suggestVisualRequirements(question = {}) {
  const existing = String(question.visual_requirements || '').trim();
  if (existing) return existing;

  const type = String(question.expected_response_type || '').toLowerCase();
  if (type === 'diagram') return DEFAULT_VISUAL_REQUIREMENT;

  const blob = [
    question.question_text,
    question.correct_answer_summary,
    question.marking_rubric,
  ].map((value) => String(value || '')).join('\n');

  if (!DIAGRAM_CUE.test(blob) && !RUBRIC_DIAGRAM_CUE.test(blob)) return null;

  if (/wheatstone/i.test(blob)) return 'Wheatstone bridge / network diagram with labelled arms';
  if (/ray\s+diagram/i.test(blob)) return 'Ray diagram as required by the question';
  if (/circuit/i.test(blob)) return 'Circuit diagram with labelled components';
  return DEFAULT_VISUAL_REQUIREMENT;
}

export function withSuggestedVisualRequirements(question) {
  if (!question || String(question.visual_requirements || '').trim()) return question;
  const suggested = suggestVisualRequirements(question);
  if (!suggested) return question;
  return { ...question, visual_requirements: suggested };
}
