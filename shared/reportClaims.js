/**
 * Guards for the AI-written report modules: they must agree with the marks.
 *
 * The subject summary ("Core strength … full credit in Q2 and Q5") and the
 * Learner DNA dimensions are written by a model. A model can keep a stale claim
 * after a teacher corrects a mark, or score a dimension on its own scale
 * (4 out of 5 shown as "4%"). These helpers check claims against the marks and
 * take dimension scores from the marks instead of the model.
 */

// A false positive only swaps in the marks-based fallback text, so this errs
// towards catching claims.
const FULL_CLAIM = /\b(full (?:credit|marks?)|fully correct|correct (?:final )?answers?|answered correctly)\b/i;
const QUESTION_REF = /\bQ\s?(\d+[a-z]?)\b/gi;

const questionKey = (value) => String(value || '').trim().toUpperCase().replace(/^Q\s?/, 'Q');

/** Marks per question number, from report questions ({ number, marks_obtained, marks_total }). */
export function marksByQuestion(questions = []) {
  const marks = new Map();
  for (const question of questions) {
    const key = questionKey(question?.number ?? question?.question_number);
    const total = Number(question?.scored_marks_allocated ?? question?.marks_total);
    if (!key || !Number.isFinite(total) || total <= 0) continue;
    marks.set(key, { obtained: Number(question?.scored_marks_obtained ?? question?.marks_obtained) || 0, total });
  }
  return marks;
}

/** Questions a text says were fully correct ("full credit in Q2 and Q5") that were not. */
export function falseFullCreditClaims(text, marks) {
  const wrong = new Set();
  for (const sentence of String(text || '').split(/(?<=[.!?])\s+/)) {
    if (!FULL_CLAIM.test(sentence)) continue;
    for (const [, number] of sentence.matchAll(QUESTION_REF)) {
      const mark = marks.get(`Q${number.toUpperCase()}`);
      if (mark && mark.obtained < mark.total) wrong.add(`Q${number.toUpperCase()}`);
    }
  }
  return [...wrong];
}

/**
 * Replaces any summary field that claims full credit on a question that did not
 * get it with the same field from the marks-based fallback.
 */
export function guardSubjectClaims(subject, fallbackSubject, marks) {
  if (!subject || !fallbackSubject) return subject;
  const fixText = (value, fallback) => (falseFullCreditClaims(value, marks).length ? fallback : value);
  const strengths = Array.isArray(subject.strengths) ? subject.strengths : [];
  const profile = subject.learning_profile || {};
  const fallbackProfile = fallbackSubject.learning_profile || {};
  return {
    ...subject,
    overall_insights: fixText(subject.overall_insights, fallbackSubject.overall_insights),
    strengths: strengths.some((item) => falseFullCreditClaims(item, marks).length) ? fallbackSubject.strengths : strengths,
    learning_profile: {
      ...profile,
      core_strength: fixText(profile.core_strength, fallbackProfile.core_strength),
      pattern_recognition: fixText(profile.pattern_recognition, fallbackProfile.pattern_recognition),
    },
  };
}

/**
 * Scores each Learner DNA dimension from the marks on the questions it cites,
 * 0-100, and sets its state from that score. A dimension with no cited
 * question has no score and is not observed.
 */
export function scoreDimensionsFromMarks(dimensions = [], marks) {
  return dimensions.map((dimension) => {
    const cited = (dimension.evidence_question_ids || []).map(questionKey).filter((key) => marks.has(key));
    if (!cited.length) return { ...dimension, score: null, state: 'not_observed' };
    const obtained = cited.reduce((sum, key) => sum + marks.get(key).obtained, 0);
    const total = cited.reduce((sum, key) => sum + marks.get(key).total, 0);
    const ratio = obtained / total;
    return {
      ...dimension,
      score: Math.round(ratio * 100),
      state: ratio >= 0.75 ? 'secure' : ratio >= 0.45 ? 'developing' : 'needs_practice',
    };
  });
}
