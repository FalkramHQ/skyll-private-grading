import {
  normalizeRecommendation as normalizeRecommendationShape,
  normalizeStrategies,
} from '../../shared/reportActionItems.js';

const DEFAULT_INSIGHTS = { strongest_area: '', focus_needed: [], pattern: '' };

const toText = (value) => (value == null ? '' : String(value));

export function cleanLabel(value) {
  return toText(value)
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\\n/g, ' ')
    .replace(/\*\*/g, '')
    .replace(/^\s*[-*]\s+/, '')
    .replace(/^\s*\d+[.)]\s+/, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([:;,.])/g, '$1')
    .replace(/[:.]$/, '')
    .trim();
}

export function cleanMarkdown(value) {
  return toText(value)
    .replace(/\\n/g, '\n')
    .replace(/^#{1,6}\s+/gm, '')
    .trim();
}

/** Preserve student work while stripping internal extraction provenance. */
export function cleanStudentAnswer(value) {
  return cleanMarkdown(value)
    .replace(/(?:^|\n)\s*From\s+asset_[a-z0-9-]+:\s*(?:Q?\d+\]\s*)?/gi, '\n\n')
    .trim();
}

export function cleanPlainText(value) {
  return cleanMarkdown(value)
    .replace(/\*\*/g, '')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function shortText(value, maxLength = 140) {
  const text = cleanPlainText(value).replace(/\$[^$]*\$/g, 'the formula');
  if (text.length <= maxLength) return text;

  const sentenceEnd = text.slice(0, maxLength).search(/[.!?]\s/);
  if (sentenceEnd > 60) return text.slice(0, sentenceEnd + 1);

  return `${text.slice(0, maxLength).replace(/\s+\S*$/, '')}...`;
}

const asArray = (value) => (Array.isArray(value) ? value : []);

const scorePct = (score, total) => {
  const denominator = Number(total) || 1;
  return Math.max(0, Math.min(100, Math.round(((Number(score) || 0) / denominator) * 100)));
};

function normalizeInsights(insights = DEFAULT_INSIGHTS) {
  return {
    strongest_area: cleanMarkdown(insights.strongest_area),
    focus_needed: asArray(insights.focus_needed).map(cleanLabel).filter(Boolean),
    pattern: cleanMarkdown(insights.pattern),
  };
}

function firstUsefulPhrase(value) {
  const text = cleanPlainText(value);
  const [firstPart] = text.split(/\s[|;]\s|[|;]/);
  return cleanLabel(firstPart || text);
}

function summarizePattern(value) {
  const text = cleanPlainText(value);
  const [primaryPattern] = text.split(/\s\|\s|\|/);
  const quotedTerms = [...primaryPattern.matchAll(/"([^"]+)"/g)].map((match) => cleanLabel(match[1]));

  if (quotedTerms.some((term) => /visual-conceptual/i.test(term))) {
    return 'Connect diagrams, concepts, and formulas before solving.';
  }

  if (quotedTerms.some((term) => /formula/i.test(term))) {
    return 'Choose the method from the concept, not only from numbers.';
  }

  if (/latent heat|logical flow|conceptual/i.test(primaryPattern) && !/struggle|incorrect|gap/i.test(primaryPattern)) {
    return 'Strong concept explanations; now build speed and precision.';
  }

  return shortText(primaryPattern || text, 88);
}

function buildDashboardInsights(insights) {
  const strongest = firstUsefulPhrase(insights.strongest_area);
  const focusTopics = insights.focus_needed.slice(0, 3);

  return {
    strongest: shortText(strongest, 58) || 'Consistent effort',
    focusTopics,
    focus: focusTopics.length > 0 ? focusTopics.join(', ') : 'No urgent focus area',
    pattern: summarizePattern(insights.pattern),
    patternLabel: insights.pattern ? 'Learning pattern' : 'Pattern',
  };
}

function normalizeRecommendation(rec = {}, index) {
  const shaped = normalizeRecommendationShape(rec, index);
  if (!shaped) return null;

  const action = cleanMarkdown(shaped.action || '');
  const topic = cleanLabel(shaped.topic) || `Step ${index + 1}`;
  const resources = asArray(rec?.resources).map(cleanLabel).filter(Boolean);
  const tip = cleanMarkdown(shaped.tip || '');

  if (!action && resources.length === 0) return null;

  return {
    ...shaped,
    topic,
    action,
    shortAction: shortText(action || resources.join(', '), 132),
    priority: shaped.priority || 'important',
    resources,
    tip,
  };
}

const naturalCmp = (a, b) => {
  const ax = String(a || '').split(/(\d+)/);
  const bx = String(b || '').split(/(\d+)/);
  for (let i = 0; i < Math.min(ax.length, bx.length); i++) {
    const an = Number(ax[i]);
    const bn = Number(bx[i]);
    const av = Number.isNaN(an) ? ax[i] : an;
    const bv = Number.isNaN(bn) ? bx[i] : bn;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
};

export const PART_STATUS_LABELS = {
  correct: 'Correct',
  partial: 'Partial',
  incorrect: 'Incorrect',
  not_attempted: 'Not attempted',
};

/* Normalize structured sub-part grades for the report UI. Preserves the exact
 * canonical shape and always keeps a human-readable status label so state is
 * never conveyed by colour alone. Falls back to cleanLabel for the prompt and
 * cleanMarkdown for free text. Returns [] when the question has no parts so
 * callers fall back to the legacy flattened-prose rendering. */
export function normalizePartsForReport(parts) {
  if (!Array.isArray(parts) || parts.length === 0) return [];
  return parts.map((part) => ({
    label: cleanLabel(part.label) || 'Part',
    prompt: cleanMarkdown(part.prompt),
    response: cleanStudentAnswer(part.response),
    expected: cleanMarkdown(part.expected),
    marks_obtained: Number(part.marks_obtained) || 0,
    marks_total: Number(part.marks_total) || 0,
    status: ['correct', 'partial', 'incorrect', 'not_attempted'].includes(part.status) ? part.status : 'not_attempted',
    statusLabel: PART_STATUS_LABELS[['correct', 'partial', 'incorrect', 'not_attempted'].includes(part.status) ? part.status : 'not_attempted'],
  }));
}

function normalizeSubject(subject = {}) {
  const recommendations = asArray(subject.recommendations)
    .map(normalizeRecommendation)
    .filter(Boolean);
  const learningProfile = {
    ...(subject.learning_profile || {}),
    strategies: normalizeStrategies(subject.learning_profile?.strategies || []),
  };

  return {
    ...subject,
    name: cleanLabel(subject.name) || 'Subject',
    learning_profile: learningProfile,
    sections: asArray(subject.sections)
      .map((section) => ({
        ...section,
        name: cleanLabel(section.name),
        pct: scorePct(section.score, section.total),
      }))
      .filter((section) => section.name),
    strengths: asArray(subject.strengths)
      .map((strength) => ({
        ...strength,
        concept: cleanLabel(strength.concept) || 'Strength',
        evidence: cleanMarkdown(strength.evidence),
        detail: cleanMarkdown(strength.detail),
        questions: asArray(strength.questions).map(cleanLabel).filter(Boolean),
      }))
      .filter((strength) => strength.evidence || strength.detail || strength.questions.length > 0),
    misconceptions: asArray(subject.misconceptions)
      .map((gap) => ({
        ...gap,
        issue: cleanLabel(gap.issue) || 'Learning gap',
        what_student_did: cleanMarkdown(gap.what_student_did),
        what_this_means: cleanMarkdown(gap.what_this_means),
        impact: cleanMarkdown(gap.impact),
        questions: asArray(gap.questions).map(cleanLabel).filter(Boolean),
      }))
      .filter((gap) => gap.what_student_did || gap.what_this_means || gap.impact || gap.questions.length > 0),
    questions: asArray(subject.questions)
      .map((question) => ({
        ...question,
        number: cleanLabel(question.number),
        // Question text can contain OCR tables. Keep its line structure for the
        // expanded renderer; the compact header creates its own one-line preview.
        summary: cleanMarkdown(question.summary || question.number),
        // Map grading rationale fields to the UI-expected names.
        // The report payload stores grading reasoning as `grading_reason`,
        // `what_went_correct`, and `missing_or_wrong` - but the UI expects
        // `diagnosis`, `why_correct`, and `next_step`.
        diagnosis: cleanMarkdown(question.diagnosis || question.missing_or_wrong),
        grading_reason: cleanMarkdown(question.grading_reason),
        what_went_correct: cleanMarkdown(question.what_went_correct),
        missing_or_wrong: cleanMarkdown(question.missing_or_wrong),
        why_correct: cleanMarkdown(question.why_correct || question.what_went_correct),
        student_answer: cleanStudentAnswer(question.student_answer),
        correct_answer: cleanMarkdown(question.correct_answer),
        pct: scorePct(question.marks_obtained, question.marks_total),
        parts: normalizePartsForReport(question.parts),
      }))
      .sort((a, b) => naturalCmp(a.number, b.number)),
    recommendations,
    nextAction: recommendations[0] || null,
    root_cause: cleanMarkdown(subject.root_cause),
    pct: scorePct(subject.score, subject.total),
  };
}

function buildLearningPlan(subjects) {
  const focusSubject = [...subjects]
    .filter((subject) => subject.nextAction)
    .sort((a, b) => (a.pct || 0) - (b.pct || 0))[0];

  return {
    focusSubject,
    nextAction: focusSubject?.nextAction || null,
    strongCount: subjects.filter((subject) => subject.status === 'strong').length,
    focusCount: subjects.filter((subject) => subject.status !== 'strong').length,
  };
}

export function createStudentReportView(data) {
  if (!data) return null;

  const classRanks = data.classRanks || {};
  const subjects = asArray(data.subjects).map((subject) => {
    const normalized = normalizeSubject(subject);
    const rankKey = subject.id || subject.name;
    normalized.classRank = classRanks[rankKey] || null;
    return normalized;
  });
  const overallInsights = normalizeInsights(data.overall_insights);

  return {
    ...data,
    overall_insights: overallInsights,
    dashboardInsights: buildDashboardInsights(overallInsights),
    subjects,
    learningPlan: buildLearningPlan(subjects),
  };
}
