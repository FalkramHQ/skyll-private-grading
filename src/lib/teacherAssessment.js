function normalizedSubject(value) {
  return String(value || '').toLowerCase().replace('mathematics', 'maths');
}

export function subjectsForAssessment(report, { testId, subject } = {}) {
  const subjects = report?.term1?.subjects || [];
  // A canonical cohort is already scoped by test ID. Historic report labels
  // must not make valid students disappear from that assessment.
  if (testId) return subjects;
  if (!subject) return subjects;
  return subjects.filter((entry) => normalizedSubject(entry.name) === normalizedSubject(subject));
}

export function assessmentScore(report, scope) {
  return subjectsForAssessment(report, scope).reduce((result, subject) => {
    result.score += Number(subject.score) || 0;
    result.total += Number(subject.total) || 0;
    return result;
  }, { score: 0, total: 0, pct: 0, });
}

export function withPercentage(result) {
  return { ...result, pct: result.total > 0 ? Math.round((result.score / result.total) * 100) : 0 };
}

export function validClassFilter(selectedClass, classes) {
  return classes.includes(selectedClass) ? selectedClass : '';
}
