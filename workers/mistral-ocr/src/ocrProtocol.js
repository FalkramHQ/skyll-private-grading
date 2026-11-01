import { foldNestedChoiceGroups, pickChoiceUnits } from '../../../shared/choiceUnits.js';
import { normalizeQuestionNumber } from '../../../shared/rubricGate.js';
import { suggestVisualRequirements } from '../../../shared/visualRequirements.js';

export function documentForAsset(asset) {
  if (!asset?.downloadUrl) throw new Error('OCR asset is missing its signed download URL.');
  if (asset.documentType === 'image_url') return { type: 'image_url', image_url: asset.downloadUrl };
  return { type: 'document_url', document_url: asset.downloadUrl };
}

export function normalizeOcrResult(result) {
  const pages = Array.isArray(result?.pages) ? result.pages.map((page, index) => ({
    index: Number.isFinite(Number(page?.index)) ? Number(page.index) : index,
    markdown: String(page?.markdown || ''),
    tables: Array.isArray(page?.tables) ? page.tables : [],
    blocks: Array.isArray(page?.blocks) ? page.blocks : [],
    confidenceScores: page?.confidence_scores || null,
    dimensions: page?.dimensions || null,
  })) : [];
  return {
    markdown: pages.map((page) => inlineTables(page.markdown, page.tables)).filter(Boolean).join('\n\n').trim(),
    pages,
    pageCount: pages.length,
    usage: result?.usage_info || null,
    model: String(result?.model || ''),
  };
}

/** Replace [tbl-N.html](tbl-N.html) references with plain-text table content. */
function inlineTables(markdown, tables) {
  if (!markdown || !tables?.length) return markdown;
  return markdown.replace(/\[tbl-(\d+)\.html\]\(tbl-\d+\.html\)/g, (match, idx) => {
    const entry = tables[Number(idx)];
    if (!entry) return match;
    const html = typeof entry === 'string' ? entry : entry.content;
    return html ? htmlTableToText(String(html)) : match;
  });
}

/** Convert an HTML table to plain text preserving row/cell structure. */
function htmlTableToText(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/td>/gi, ' | ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\| \n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function isRetryableMistralStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function text(value, limit = 12000) { return String(value || '').trim().slice(0, limit); }

const EXACT_MATCH_RESPONSE_TYPES = new Set(['mcq', 'numerical', 'diagram', 'table']);

/**
 * Sum explicit "N mark(s) for …" bands in a marking_rubric string.
 * Used to catch underspecified rubrics (e.g. "1 mark for any two…" on a 2-mark item).
 */
export function sumExplicitMarkBands(markingRubric = '') {
  const pattern = /(\d+(?:\.\d+)?)\s*marks?\s+for\s+/gi;
  let sum = 0;
  let count = 0;
  let match;
  while ((match = pattern.exec(String(markingRubric || ''))) !== null) {
    const value = Number(match[1]);
    if (Number.isFinite(value) && value > 0) {
      sum += value;
      count += 1;
    }
  }
  return { sum, count };
}

/**
 * Prompt policy for rubric generation: bands must cover marks_allocated.
 */
export function markingRubricPolicy() {
  return [
    'MARKING RUBRIC RULES:',
    'For every short_answer, long_answer, proof, or written question, marking_rubric MUST use explicit mark bands ("N marks for …").',
    'The sum of those mark bands MUST cover marks_allocated (highest full-credit path must be able to award all marks).',
    'Bad (rejects): marks_allocated=2 with "1 mark for any two correct differences".',
    'Good: marks_allocated=2 with "2 marks for any two correct differences; 1 mark for only one correct difference or vague wording".',
    'Also good: "1 mark for conductivity difference; 1 mark for free-electron difference".',
    'Include partial bands where a student can show the correct idea with poor wording.',
    'MCQ and numerical items stay exact-match; do not invent partial bands for them.',
  ].join(' ');
}

export function coverAllocatedMarkBands(markingRubric, marks, responseType) {
  const type = String(responseType || '').trim().toLowerCase();
  const original = String(markingRubric || '').trim();
  if (EXACT_MATCH_RESPONSE_TYPES.has(type)) return original;

  const allocated = Number(marks);
  if (!Number.isFinite(allocated) || !(allocated > 0)) return original;

  const { sum, count } = sumExplicitMarkBands(original);
  if (allocated >= 2 && count === 0) {
    return `${original} ${allocated} marks for a complete answer covering the required points from the answer key.`.trim();
  }
  if (count > 0 && sum + 0.01 < allocated) {
    const gap = Math.round((allocated - sum) * 100) / 100;
    const unit = gap === 1 ? 'mark' : 'marks';
    return `${original} ${gap} ${unit} for remaining required content from the answer key.`.trim();
  }
  return original;
}

export function assertMarkingRubricCoversAllocated({
  number,
  marks,
  markingRubric,
  responseType,
} = {}) {
  const type = String(responseType || '').trim().toLowerCase();
  if (EXACT_MATCH_RESPONSE_TYPES.has(type)) return;

  const allocated = Number(marks);
  if (!Number.isFinite(allocated) || !(allocated > 0)) return;

  const { sum, count } = sumExplicitMarkBands(markingRubric);
  if (allocated >= 2 && count === 0) {
    throw new Error(
      `Rubric package for ${number} must include explicit mark bands that sum to ${allocated} (got none in marking_rubric).`,
    );
  }
  // Underspecified only: bands that cannot reach full marks (e.g. "1 mark for any two" on a 2-mark item).
  // Allow sum > allocated for tiered alternatives ("2 marks for two differences; 1 mark for one").
  if (count > 0 && sum + 0.01 < allocated) {
    throw new Error(
      `Rubric package for ${number} has mark bands summing to ${sum} but marks_allocated is ${allocated}.`,
    );
  }
}

export function parseJsonModelResponse(content) {
  const value = String(content || '').trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');
  const start = value.indexOf('{'); const end = value.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Rubric model did not return a JSON object.');
  return JSON.parse(value.slice(start, end + 1));
}

const PLACEHOLDER_TEXT_PATTERNS = [
  /\bnot\s+provided\b/i,
  /\bunknown\b/i,
  /\bN\/?A\b/i,
  /\b(?:text|question)\s+not\s+(?:available|shown|included)\b/i,
  /\bto\s+be\s+(?:filled|provided)\b/i,
  /\bplaceholder\b/i,
  /\bTBD\b/i,
  /\bcoming\s+soon\b/i,
];

/**
 * Reject placeholder question text (e.g. "(Question text not provided)") that a
 * rubric model can emit instead of real content. The empty-string check alone
 * cannot catch these, so we denylist common placeholder phrasing.
 */
export function isPlaceholderText(questionText = '') {
  const cleaned = String(questionText || '').trim();
  if (!cleaned) return true;
  // Compare against a stripped-down skeleton of the text so a parenthetical
  // placeholder still matches even when wrapped in brackets/quotes.
  return PLACEHOLDER_TEXT_PATTERNS.some((pattern) => pattern.test(cleaned));
}

/**
 * Compute the effective (scoreable) mark total after applying the paper's
 * optional question scoring plan. A group of mutually-optional questions only
 * contributes `choose` of its members to the paper total (best_score policy
 * scores the highest-mark members). Questions outside any group count in full.
 * Returns the effective total and the set of question numbers that count.
 */
export function computeEffectiveMarks(normalizedQuestions, scoringPlan) {
  const marksByNumber = new Map(normalizedQuestions.map((q) => [q.number, Number(q.marks_allocated || 0)]));
  const groups = Array.isArray(scoringPlan?.groups) ? scoringPlan.groups : [];
  let effective = 0;
  const inGroup = new Set(); // grouped numbers are never counted standalone
  const counted = new Set(); // numbers whose marks already contributed

  for (const group of groups) {
    const memberNumbers = new Set();
    for (const unit of group.units || []) for (const n of unit.question_numbers || []) memberNumbers.add(n);
    for (const n of group.question_numbers || []) memberNumbers.add(n);
    for (const n of memberNumbers) inGroup.add(n);
    const members = [...memberNumbers]
      .filter((n) => marksByNumber.has(n) && !counted.has(n))
      .map((n) => ({ number: n, marks: marksByNumber.get(n) }));
    const choose = Math.min(Math.max(0, Number(group.choose) || 0), members.length);
    // best_score: the group's ceiling is its `choose` highest-mark members,
    // after any at_least minimum ("one from each section") is met.
    const chosen = pickChoiceUnits([...members].sort((a, b) => b.marks - a.marks), choose, group.at_least,
      (member, minimum) => (minimum.question_numbers || []).includes(member.number));
    for (const { number } of chosen) counted.add(number);
    effective += chosen.reduce((sum, c) => sum + c.marks, 0);
  }

  for (const q of normalizedQuestions) {
    if (!inGroup.has(q.number)) effective += marksByNumber.get(q.number) || 0;
  }

  return { effective, inGroup };
}

/**
 * @param {object} value raw rubric model output
 * @param {{gate?: boolean}} [options] gate: the rubric gate is on for this school, so
 *   under-covered bands are left for checkRubricGate to report instead of being padded
 *   with a filler band or failing the job.
 */
export function validateRubricPackage(value, { gate = false } = {}) {
  const questions = Array.isArray(value?.questions) ? value.questions : [];
  if (!questions.length) throw new Error('Rubric package has no questions.');
  const numbers = new Set(); let totalMarks = 0;
  const normalized = questions.map((question, index) => {
    const number = text(question?.number || question?.question_number || `Q${index + 1}`, 80);
    if (numbers.has(number)) throw new Error(`Rubric package repeats question ${number}.`);
    numbers.add(number);
    const marks = Number(question?.marks ?? question?.marks_allocated);
    if (!Number.isFinite(marks) || marks < 0 || marks > 100) throw new Error(`Rubric package has invalid marks for ${number}.`);
    const questionText = text(question?.question_text || question?.text);
    const correctAnswer = text(question?.correct_answer_summary || question?.correct_answer || question?.answer);
    const markingRubric = text(question?.marking_rubric || question?.rubric);
    if (isPlaceholderText(questionText)) {
      throw new Error(`Rubric package has placeholder question text for ${number}.`);
    }
    if (!questionText || !correctAnswer || !markingRubric) throw new Error(`Rubric package is incomplete for ${number}.`);
    const responseType = text(question?.expected_response_type || 'written', 80);
    const coveredRubric = gate ? markingRubric : coverAllocatedMarkBands(markingRubric, marks, responseType);
    if (!gate) {
      assertMarkingRubricCoversAllocated({
        number,
        marks,
        markingRubric: coveredRubric,
        responseType,
      });
    }
    const markStep = Number(question?.mark_step);
    totalMarks += marks;
    return {
      id: text(question?.id || number.replace(/[^A-Za-z0-9]+/g, '_').toLowerCase(), 120), number,
      question_text: questionText, marks_allocated: marks, topic: text(question?.topic, 200),
      expected_response_type: responseType,
      correct_answer_summary: correctAnswer, accepted_variations: Array.isArray(question?.accepted_variations) ? question.accepted_variations.map((item) => text(item, 400)).filter(Boolean).slice(0, 20) : [],
      marking_rubric: coveredRubric, answer_key_evidence: text(question?.answer_key_evidence, 6000),
      ...(Number.isFinite(markStep) && markStep > 0 ? {
        mark_step: markStep,
        mark_step_source: ['key', 'paper', 'inferred'].includes(question?.mark_step_source) ? question.mark_step_source : 'inferred',
      } : {}),
      question_source_pages: Array.isArray(question?.question_source_pages) ? question.question_source_pages.map(Number).filter(Number.isFinite) : [],
      answer_key_source_pages: Array.isArray(question?.answer_key_source_pages) ? question.answer_key_source_pages.map(Number).filter(Number.isFinite) : [],
      is_optional: Boolean(question?.is_optional), selection_group: text(question?.selection_group, 120) || null,
      visual_requirements: text(question?.visual_requirements, 2000) || suggestVisualRequirements({
        expected_response_type: responseType,
        question_text: questionText,
        correct_answer_summary: correctAnswer,
        marking_rubric: markingRubric,
        visual_requirements: question?.visual_requirements,
      }),
    };
  });
  if (!totalMarks) throw new Error('Rubric package has no scorable marks.');

  const scoringPlan = normalizeScoringPlan(value?.exam?.scoring_plan);
  const declaredTotalMarks = Number(value?.exam?.total_marks);
  const hasDeclaredTotal = Number.isFinite(declaredTotalMarks) && declaredTotalMarks > 0;
  const { effective } = computeEffectiveMarks(normalized, scoringPlan);
  const warnings = [];

  // Keep under-covered papers on the review queue instead of failing the job.
  // Grading still waits on human approval; the warning is the reviewer's signal.
  if (hasDeclaredTotal && effective + 0.01 < declaredTotalMarks) {
    warnings.push(
      `Effective mark total ${effective} is below the declared total ${declaredTotalMarks} ` +
      `(raw ${totalMarks} across ${normalized.length} questions). Reconcile before grading.`,
    );
  }
  if (!hasDeclaredTotal) {
    warnings.push('Paper declares no total_marks, so rubric/declared mark reconciliation was skipped.');
  } else if (effective + 0.01 > declaredTotalMarks && rawDiffersFromEffective(totalMarks, effective)) {
    warnings.push(`Rubric maps ${effective} effective marks against a declared ${declaredTotalMarks} total; effective exceeds declared (optional-question plan).`);
  } else if (rawDiffersFromEffective(totalMarks, effective)) {
    warnings.push(`Rubric sums to ${totalMarks} raw marks but ${effective} effective after applying the optional-question plan.`);
  }

  return {
    exam: {
      title: text(value?.exam?.title, 240), total_marks: Number(value?.exam?.total_marks) || totalMarks,
      ...(gate && hasDeclaredTotal ? { declared_total_marks: declaredTotalMarks } : {}),
      optional_rules: text(value?.exam?.optional_rules, 4000) || null,
      instructions: text(value?.exam?.instructions, 6000) || null,
      scoring_plan: scoringPlan,
    },
    questions: normalized,
    quality: {
      questionCount: normalized.length,
      totalMarks,
      declaredTotalMarks: hasDeclaredTotal ? declaredTotalMarks : null,
      effectiveTotalMarks: effective,
      mappingCoverage: { raw: totalMarks, declared: hasDeclaredTotal ? declaredTotalMarks : null, effective },
      warnings,
    },
  };
}

function rawDiffersFromEffective(raw, effective) {
  return Math.abs(raw - effective) > 0.01;
}

const planNumbers = (values) => (Array.isArray(values) ? [...new Set(values.map((number) => text(number, 80)).filter(Boolean))] : []);

export function normalizeScoringPlan(value) {
  const groups = foldNestedChoiceGroups(Array.isArray(value?.groups) ? value.groups : [], normalizeQuestionNumber);
  return {
    groups: groups.map((group, index) => ({
      id: text(group?.id || `optional_${index + 1}`, 120),
      choose: Math.max(0, Number(group?.choose) || 0),
      question_numbers: Array.isArray(group?.question_numbers) ? [...new Set(group.question_numbers.map((number) => text(number, 80)).filter(Boolean))] : [],
      units: Array.isArray(group?.units) ? group.units.map((unit, unitIndex) => ({ id: text(unit?.id || `unit_${unitIndex + 1}`, 120), question_numbers: Array.isArray(unit?.question_numbers) ? [...new Set(unit.question_numbers.map((number) => text(number, 80)).filter(Boolean))] : [] })).filter((unit) => unit.question_numbers.length) : [],
      ...(Array.isArray(group?.at_least) && group.at_least.length ? {
        at_least: group.at_least.map((minimum) => ({
          id: text(minimum?.id, 120),
          choose: Math.max(0, Number(minimum?.choose) || 0),
          question_numbers: planNumbers(minimum?.question_numbers),
        })).filter((minimum) => minimum.choose > 0 && minimum.question_numbers.length),
      } : {}),
      selection_policy: group?.selection_policy === 'attempt_order' ? 'attempt_order' : 'best_score',
    })).filter((group) => group.choose > 0 && (group.units.length || group.question_numbers.length) > group.choose),
  };
}
