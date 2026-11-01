export const REVIEW_QUEUE_FILTERS = [
  'pending', 'complete', 'flagged', 'harsh-zeros', 'rechecks', 'student-rechecks', 'teacher-rechecks', 'awaiting-regrade',
  'edited-awaiting-regrade', 'low-confidence', 'approved', 'all',
];

const ACTIVE_RECHECK_STATUSES = new Set(['open', 'in_review', 'awaiting_regrade']);

export function recheckRequesterKind(request = {}) {
  return String(request.requestedByRole || '').trim().toLowerCase() === 'student' ? 'student' : 'teacher';
}

export function recheckMatchesReviewItem(item = {}, request = {}) {
  const question = String(item.questionNumber || '').replace(/^Q/i, '');
  return request.review_student_id === item.studentId
    && String(request.question_number || '').replace(/^Q/i, '') === question;
}

function matchingRechecks(item, rechecks = []) {
  return rechecks.filter((request) => recheckMatchesReviewItem(item, request));
}

export function reviewItemMatchesFilter(item, filter, rechecks = []) {
  if (filter === 'pending') return item.reviewStatus === 'pending';
  if (filter === 'approved') return item.reviewStatus === 'approved';
  if (filter === 'complete') return item.reviewStatus === 'approved' && !item.needsRegrade;
  if (filter === 'flagged') return Boolean(item.isFlagged || item.reviewPriority === 'flagged' || item.reviewTags?.includes('flagged'));
  if (filter === 'harsh-zeros') return Boolean(item.isHarshZero || item.reviewTags?.includes('harsh_zero'));
  if (filter === 'edited-awaiting-regrade') return Boolean(item.needsRegrade || (item.editedAt && (item.reviewRevision || 0) > (item.regradedRevision || 0)));
  if (filter === 'low-confidence') return item.grade?.confidence === 'low' || item.studentAnswer?.confidence === 'low' || item.visualReview?.usable === false;
  if (filter === 'rechecks') return matchingRechecks(item, rechecks).some((request) => ACTIVE_RECHECK_STATUSES.has(request.status));
  if (filter === 'student-rechecks') return matchingRechecks(item, rechecks)
    .some((request) => ACTIVE_RECHECK_STATUSES.has(request.status) && recheckRequesterKind(request) === 'student');
  if (filter === 'teacher-rechecks') return matchingRechecks(item, rechecks)
    .some((request) => ACTIVE_RECHECK_STATUSES.has(request.status) && recheckRequesterKind(request) === 'teacher');
  if (filter === 'awaiting-regrade') return matchingRechecks(item, rechecks)
    .some((request) => request.status === 'awaiting_regrade');
  return true;
}

export function reviewLocation({ cohort, student, question, filter = 'pending', search = '' } = {}) {
  const params = new URLSearchParams();
  if (cohort) params.set('cohort', cohort);
  if (student) params.set('student', student);
  if (question) params.set('question', question);
  if (filter && filter !== 'pending') params.set('filter', REVIEW_QUEUE_FILTERS.includes(filter) ? filter : 'pending');
  if (search?.trim()) params.set('search', search.trim());
  return params.toString();
}

export function parseReviewLocation(search = '') {
  const params = new URLSearchParams(search);
  const filter = params.get('filter');
  return {
    cohort: params.get('cohort') || '', student: params.get('student') || '', question: params.get('question') || '',
    filter: REVIEW_QUEUE_FILTERS.includes(filter) ? filter : 'pending', search: params.get('search') || '',
  };
}

// Resolve a deep-linked review location once after its cohort queue loads.
// Navigation must not continually reapply this initial target: reviewers need
// Prev/Next to move freely after opening a shared review URL.
export function initialReviewTarget(items = [], location = {}, filter = 'pending', rechecks = [], search = '') {
  const requestedStudent = location.student || '';
  const requestedQuestion = location.question || '';
  const scoped = items
    .filter((item) => !requestedStudent || item.studentId === requestedStudent)
    .filter((item) => reviewItemMatchesFilter(item, filter, rechecks));
  const needle = String(search || '').trim().toLowerCase();
  const visible = needle
    ? scoped.filter((item) => [item.studentName, item.studentId, item.questionNumber, item.questionText, item.topic]
      .some((value) => String(value || '').toLowerCase().includes(needle)))
    : scoped;
  const index = requestedQuestion
    ? visible.findIndex((item) => item.questionNumber === requestedQuestion)
    : -1;

  return {
    studentId: requestedStudent && items.some((item) => item.studentId === requestedStudent) ? requestedStudent : null,
    index: index >= 0 ? index : 0,
  };
}

export const COHORT_STATUS_FILTERS = ['all', 'needs-review', 'regrade-pending', 'completed'];

// Reviewers triage recent papers, so the landing view orders by exam date
// newest-first. Presets rather than a free-form range: the common question is
// "what came in lately", not an exact window.
export const COHORT_DATE_FILTERS = ['all', '7d', '30d', '90d'];

const COHORT_DATE_WINDOW_DAYS = { '7d': 7, '30d': 30, '90d': 90 };

// exam_date is a date (YYYY-MM-DD), not a timestamp. Compare on the date part
// only and keep everything in UTC so a reviewer's timezone cannot shift which
// exams fall inside the window.
export function cohortDateValue(cohort = {}) {
  const raw = String(cohort.examDate || '').trim();
  if (!raw) return null;
  const parsed = Date.parse(raw.length <= 10 ? `${raw}T00:00:00Z` : raw);
  return Number.isNaN(parsed) ? null : parsed;
}

export function cohortWithinDateFilter(cohort = {}, dateFilter = 'all', now = Date.now()) {
  if (!dateFilter || dateFilter === 'all') return true;
  const days = COHORT_DATE_WINDOW_DAYS[dateFilter];
  if (!days) return true;
  const value = cohortDateValue(cohort);
  // An exam with no date cannot be shown to fall inside a window, so it is
  // excluded rather than passed through.
  if (value === null) return false;
  return value >= now - days * 24 * 60 * 60 * 1000;
}

// Newest first, with the previous school/grade/title ordering kept as a stable
// tiebreak. Cohorts without an exam date sort last.
export function compareCohortsByExamDate(a = {}, b = {}) {
  const left = cohortDateValue(a);
  const right = cohortDateValue(b);
  if (left !== right) {
    if (left === null) return 1;
    if (right === null) return -1;
    return right - left;
  }
  return [a.school, a.grade, a.examName || a.subject]
    .map(String).join('\u0000')
    .localeCompare([b.school, b.grade, b.examName || b.subject].map(String).join('\u0000'));
}

// Status labels are non-exclusive: a cohort with pending reviews AND pending
// regrade changes matches either chip. "Completed" means neither remains.
//
// A reviewer can override that derivation for one cohort ("mark as done") when
// the remaining items are known to be non-blocking. The marker is an input here
// rather than a stored status: un-marking simply drops it and the live counts
// take over again.
export function cohortStatusLabels(cohort = {}) {
  if (cohort.completionOverride) return ['completed'];
  const labels = [];
  if ((cohort.pending || 0) > 0) labels.push('needs-review');
  if ((cohort.changedQuestions || 0) > 0) labels.push('regrade-pending');
  return labels.length ? labels : ['completed'];
}

// A cohort sits in Review Complete with unresolved questions only because a
// reviewer said so. The UI must keep that visibly distinct from a cohort that
// finished naturally, otherwise the override is indistinguishable from real work.
export function cohortOverrideHasUnresolved(cohort = {}) {
  return Boolean(cohort.completionOverride) && ((cohort.pending || 0) > 0 || (cohort.changedQuestions || 0) > 0);
}

export function cohortMatchesFilters(cohort = {}, filters = {}) {
  if (filters.school && cohort.school !== filters.school) return false;
  if (filters.grade && cohort.grade !== filters.grade) return false;
  if (filters.subject && cohort.subject !== filters.subject) return false;
  if (filters.status && filters.status !== 'all' && !cohortStatusLabels(cohort).includes(filters.status)) return false;
  if (!cohortWithinDateFilter(cohort, filters.date || 'all', filters.now)) return false;
  return true;
}

// Cohort-screen filters share the review URL space (fSchool/fGrade/fSubject/
// fStatus/fDate/showCompleted) so a filtered dashboard link survives refresh
// and hand-off, exactly like a deep review link does.
export function cohortFilterLocation(filters = {}) {
  const params = new URLSearchParams();
  if (filters.school) params.set('fSchool', filters.school);
  if (filters.grade) params.set('fGrade', filters.grade);
  if (filters.subject) params.set('fSubject', filters.subject);
  if (filters.status && filters.status !== 'all' && COHORT_STATUS_FILTERS.includes(filters.status)) params.set('fStatus', filters.status);
  if (filters.date && filters.date !== 'all' && COHORT_DATE_FILTERS.includes(filters.date)) params.set('fDate', filters.date);
  if (filters.showCompleted) params.set('showCompleted', '1');
  return params.toString();
}

export function parseCohortFilters(search = '') {
  const params = new URLSearchParams(search);
  const status = params.get('fStatus');
  const date = params.get('fDate');
  return {
    school: params.get('fSchool') || '',
    grade: params.get('fGrade') || '',
    subject: params.get('fSubject') || '',
    status: COHORT_STATUS_FILTERS.includes(status) ? status : 'all',
    date: COHORT_DATE_FILTERS.includes(date) ? date : 'all',
    showCompleted: params.get('showCompleted') === '1',
  };
}
