import { foldNestedChoiceGroups, pickChoiceUnits, unitQuestionNumbers } from '../../shared/choiceUnits.js';

const key = (value) => String(value || '').trim().toLowerCase();

// Normalize question number for matching: "Q11a" ↔ "11(a)", "Q14iii" ↔ "14(iii)"
// Strips leading Q/q, converts trailing letter/roman to parenthesized form, and vice versa.
function normalizeNumber(raw) {
  let n = key(raw);
  // Strip leading 'q' prefix: "q11a" → "11a"
  n = n.replace(/^q/, '');
  // Strip stable suffixes before punctuation folding so "Q1A_i" ↔ "Q1A(i)".
  n = n.replace(/_main$/, '').replace(/_or$/, 'or');
  // Fold separators so scoring-plan ids match live question numbers:
  // "Q1A_i" / "Q1A(i)" / "Q1A i" → "1ai"
  n = n.replace(/[()\s_.-]/g, '');
  return n;
}

function uniqueQuestions(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || '').trim()).filter(Boolean))];
}

function normalizeUnits(group) {
  const units = Array.isArray(group?.units) ? group.units : [];
  if (units.length) return units.map((unit, index) => ({
    id: String(unit?.id || `unit_${index + 1}`),
    question_numbers: uniqueQuestions(unit?.question_numbers),
  })).filter((unit) => unit.question_numbers.length);
  return uniqueQuestions(group?.question_numbers).map((number) => ({ id: number, question_numbers: [number] }));
}

function normalizeMinimums(group) {
  return (Array.isArray(group?.at_least) ? group.at_least : []).map((minimum, index) => ({
    id: String(minimum?.id || `at_least_${index + 1}`),
    choose: Math.max(0, Number(minimum?.choose) || 0),
    question_numbers: uniqueQuestions(minimum?.question_numbers),
  })).filter((minimum) => minimum.choose > 0 && minimum.question_numbers.length);
}

/**
 * Normalizes the scoring contract stored with a rubric. A group represents a
 * set of mutually optional questions; best_score is the stated platform policy
 * when a student answers more than the permitted number. `at_least` minimums
 * ("one from each section") are met before the rest of `choose` is filled.
 */
export function normalizeScoringPlan(value) {
  const groups = foldNestedChoiceGroups(Array.isArray(value?.groups) ? value.groups : [], normalizeNumber);
  return {
    groups: groups.map((group, index) => ({
      id: String(group?.id || `optional_${index + 1}`),
      choose: Math.max(0, Number(group?.choose) || 0),
      units: normalizeUnits(group),
      at_least: normalizeMinimums(group),
      selection_policy: group?.selection_policy === 'attempt_order' ? 'attempt_order' : 'best_score',
    })).filter((group) => group.choose > 0 && group.units.length > group.choose),
  };
}

const inMinimum = (unit, minimum) => {
  const members = new Set(minimum.question_numbers.map(normalizeNumber));
  return members.has(normalizeNumber(unit.id)) || unit.question_numbers.some((number) => members.has(normalizeNumber(number)));
};

export function applyScoringPlan(questions, plan) {
  const normalized = normalizeScoringPlan(plan);
  const selected = new Set(questions.map((question) => key(question.number || question.question_number)));
  const notes = [];

  const numberOf = (question) => key(question.number || question.question_number);
  const allNumbers = questions.map(numberOf);

  for (const group of normalized.groups) {
    const units = group.units.map((unit) => ({
      ...unit,
      // Exact number first, then the folded form ("Q1A_i" ↔ "1A(i)"); a bare
      // question number ("Q4") also covers its parts (Q4.1, Q4.2…).
      questions: [...new Set(unit.question_numbers.flatMap((number) => {
        const exact = allNumbers.filter((n) => n === key(number));
        return exact.length ? exact : unitQuestionNumbers(number, allNumbers, normalizeNumber);
      }))].map((number) => questions.find((question) => numberOf(question) === number)).filter(Boolean),
    })).filter((unit) => unit.questions.length);
    // When the paper says the first *attempted* answers count (attempt_order),
    // rank units by the student's attempt sequence — derived from the earliest
    // evidence source_pages — rather than by marks. Fall back to best-score only
    // when order cannot be established for every unit in the group.
    const attemptOrder = group.selection_policy === 'attempt_order';
    const earliestPage = (unit) => unit.questions
      .flatMap((question) => (Array.isArray(question.source_pages) ? question.source_pages : []))
      .filter((value) => Number.isFinite(Number(value)))
      .map((value) => Number(value))
      .sort((a, b) => a - b)[0];
    const orderKnowable = attemptOrder && units.length > 0 && units.every((unit) => Number.isFinite(earliestPage(unit)));
    const ranked = [...units].sort((left, right) => {
      if (orderKnowable) {
        const leftOrder = earliestPage(left);
        const rightOrder = earliestPage(right);
        if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      }
      const leftAttempted = left.questions.some((question) => question.attempted !== false) ? 1 : 0;
      const rightAttempted = right.questions.some((question) => question.attempted !== false) ? 1 : 0;
      if (rightAttempted !== leftAttempted) return rightAttempted - leftAttempted;
      const markDifference = right.questions.reduce((sum, question) => sum + Number(question.marks_obtained || 0), 0) - left.questions.reduce((sum, question) => sum + Number(question.marks_obtained || 0), 0);
      if (markDifference) return markDifference;
      const possibleDifference = right.questions.reduce((sum, question) => sum + Number(question.marks_total || 0), 0) - left.questions.reduce((sum, question) => sum + Number(question.marks_total || 0), 0);
      if (possibleDifference) return possibleDifference;
      return left.id.localeCompare(right.id);
    });
    const chosen = new Set(pickChoiceUnits(ranked, group.choose, group.at_least, inMinimum).map((unit) => unit.id));
    for (const unit of units) if (!chosen.has(unit.id)) for (const question of unit.questions) selected.delete(key(question.number || question.question_number));
    notes.push({
      id: group.id,
      choose: group.choose,
      selection_policy: group.selection_policy,
      selection_basis: orderKnowable ? 'attempt_order' : 'best_score',
      selected_questions: ranked.filter((unit) => chosen.has(unit.id)).flatMap((unit) => unit.questions.map((question) => question.number || question.question_number)),
    });
  }

  const scoredQuestions = questions.map((question) => {
    const countsTowardScore = selected.has(key(question.number || question.question_number));
    return {
      ...question,
      counts_toward_score: countsTowardScore,
      scored_marks_obtained: countsTowardScore ? Number(question.marks_obtained || 0) : 0,
      scored_marks_allocated: countsTowardScore ? Number(question.marks_total || 0) : 0,
    };
  });
  return {
    questions: scoredQuestions,
    score: scoredQuestions.reduce((sum, question) => sum + Number(question.scored_marks_obtained || 0), 0),
    total: scoredQuestions.reduce((sum, question) => sum + Number(question.scored_marks_allocated || 0), 0),
    notes,
  };
}
