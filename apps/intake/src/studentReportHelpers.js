import { normalizeLearnerDna } from '@skyll/web-lib/learnerDna.js';

function asText(value, fallback = '') {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number') return String(value);
  return fallback;
}

/**
 * Resolve subjects for a selected exam from the merged student-context report.
 * API shape: exams[], term1 = latest, plus per-exam keys report[examId].
 */
export function getExamBundle(report = {}, examId = '') {
  const exams = Array.isArray(report.exams) ? report.exams : [];
  const selectedId = examId || exams[0]?.id || '';
  const selectedExam = exams.find((exam) => exam.id === selectedId) || exams[0] || null;
  const keyed = selectedId && report[selectedId] ? report[selectedId] : null;
  const fallback = report.term1 || {};
  const bundle = keyed || (selectedId === exams[0]?.id ? fallback : keyed) || fallback;
  const subjects = bundle?.subjects || report.subjects || [];
  return {
    exams,
    selectedId: selectedExam?.id || selectedId || '',
    selectedExam,
    subjects,
    insights: bundle?.overall_insights || fallback.overall_insights || {},
  };
}

export function examScore(subjects = []) {
  const total = subjects.reduce((sum, subject) => sum + (Number(subject.total) || 0), 0);
  const score = subjects.reduce((sum, subject) => sum + (Number(subject.score) || 0), 0);
  return { score, total };
}

/**
 * Resolve the exact subject + exam a push notification should open, so a tapped
 * "report ready" lands on the specific subject instead of the dashboard.
 * `route.testId` maps to report.exams[].id (the worker's test_id) and
 * `route.subject` is the subject name. Prefers the exam matching testId, then
 * falls back to any exam (most recent first) containing that subject, then to
 * the default bundle — so a stale/missing testId still opens the right report.
 * Returns null when nothing matches (caller stays on the dashboard).
 */
export function resolveNotificationSubject(report, route = {}) {
  const wanted = asText(route?.subject).toLowerCase();
  if (!report || !wanted) return null;
  const matches = (subjects) => (Array.isArray(subjects)
    ? subjects.find((subject) => asText(subject?.name).toLowerCase() === wanted)
    : undefined);
  const exams = Array.isArray(report.exams) ? report.exams : [];
  const testId = asText(route?.testId);
  const preferred = testId ? exams.find((exam) => asText(exam?.id) === testId) : null;
  const ordered = preferred ? [preferred, ...exams.filter((exam) => exam !== preferred)] : exams;
  for (const exam of ordered) {
    const bundle = getExamBundle(report, exam?.id || '');
    const found = matches(bundle.subjects);
    if (found) return { subject: found, exam: bundle.selectedExam };
  }
  const fallback = getExamBundle(report, '');
  const fallbackSubject = matches(fallback.subjects);
  return fallbackSubject ? { subject: fallbackSubject, exam: fallback.selectedExam } : null;
}

const STATE_LABEL = {
  secure: 'Secure',
  developing: 'Developing',
  needs_practice: 'Build next',
  not_observed: 'Not measured',
};

/**
 * Student-facing Learning DNA summary aligned with web normalizeLearnerDna.
 */
export function dnaSummary(rawDna = {}) {
  const dna = normalizeLearnerDna(rawDna);
  if (!dna) {
    return {
      title: 'Your learning profile is still taking shape',
      body: 'Skyll will strengthen this view as it sees more of your work across assessments.',
      next: '',
      growth: '',
      scope: '',
      modes: [],
    };
  }

  const primary = dna.primary_mode || {};
  const growth = dna.growth_edge || {};
  const next = dna.next_move || {};
  const modes = (dna.dimensions || [])
    .filter((dimension) => dimension.state && dimension.state !== 'not_observed')
    .map((dimension) => ({
      id: dimension.id,
      label: dimension.label,
      state: dimension.state,
      stateLabel: STATE_LABEL[dimension.state] || dimension.state,
    }));

  return {
    title: asText(primary.title || dna.identity?.label, 'Current learning snapshot'),
    body: asText(
      primary.description || dna.identity?.subtitle || dna.identity?.evidence,
      'Use question-level feedback to build a clearer picture over later assessments.',
    ),
    next: asText(next.action || growth.action, ''),
    nextTitle: asText(next.title, 'Next best move'),
    growth: asText(growth.title, ''),
    growthAction: asText(growth.action, ''),
    scope: asText(dna.assessment_scope?.label, ''),
    modes,
  };
}

export function formatExamDate(value) {
  const raw = asText(value);
  if (!raw) return '';
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
