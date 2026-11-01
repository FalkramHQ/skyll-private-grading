// The role × school matrix (FLKRM-386): every route registered as `matrix` in
// routeRegistry.js, called as each actor against School A's records.
//
// Expectations per actor:
//   allow  — 2xx, and the body contains School A's marker (proves the fixture
//            really reached the data, so a deny elsewhere is meaningful)
//   reach  — passes authorization: anything but 401/403/404/5xx (writes whose
//            business rules may still answer 400/409 with this fixture)
//   scoped — not a 5xx and never School A's marker: the route serves the
//            actor's own school (or nothing), not School A's
//   deny   — 401/403/404 (or the row's denyStatuses) and never the marker
import { A } from './twoSchoolFixture.js';

const ROLES = ['studentA', 'peerA', 'teacherA', 'adminA', 'teacherB', 'adminB', 'skyll'];

/** Build an expectation map: everyone denied unless listed. */
function expect(overrides) {
  return Object.fromEntries(ROLES.map((role) => [role, overrides[role] || 'deny']));
}

// Common shapes.
const STAFF = expect({ teacherA: 'allow', adminA: 'allow', skyll: 'allow' });
const ADMINS = expect({ adminA: 'allow', skyll: 'allow' });
const STAFF_LIST = expect({ teacherA: 'allow', adminA: 'allow', teacherB: 'scoped', adminB: 'scoped', skyll: 'allow' });
const ADMIN_LIST = expect({ adminA: 'allow', adminB: 'scoped', skyll: 'allow' });
// Intake and exam notes scope platform staff to their own school too.
const ADMIN_OWN_SCHOOL_LIST = expect({ adminA: 'allow', adminB: 'scoped', skyll: 'scoped' });
const ADMIN_OWN_SCHOOL_ITEM = expect({ adminA: 'allow', skyll: 'scoped' });

const get = (query = {}) => ({ method: 'GET', query });
const post = (body = {}, query = {}) => ({ method: 'POST', query, body });

const auth = (file) => () => import(`../../../server/${file}`).then((m) => m.default);
const ai = (name) => () => import('../../../server/ai/teacher.js').then((m) => m[name]);
const vlQueue = () => import('../../../api/vl-queue.js').then((m) => m.default);
const cohort = { school: A.school.name, subject: A.subject, grade: A.grade, testId: A.testId };

export const MATRIX_ROUTES = [
  // ── /api/auth ───────────────────────────────────────────────────────────
  { route: 'auth/teacher-roster', load: auth('auth/teacherRoster.js'), request: get(),
    expect: expect({ teacherA: 'allow', adminA: 'allow', teacherB: 'scoped', adminB: 'scoped' }) },
  { route: 'auth/exam', name: 'list collections', load: auth('exam.js'), request: post({ action: 'list_collections' }), expect: ADMIN_OWN_SCHOOL_LIST },
  { route: 'auth/exam', name: 'load a collection', load: auth('exam.js'), request: post({ action: 'load_collection', collectionId: A.collectionId }), expect: ADMIN_OWN_SCHOOL_ITEM },
  { route: 'auth/operations', load: auth('admin/operations.js'), request: get(), expect: ADMIN_LIST },
  { route: 'auth/operationsDetail', load: auth('admin/operationsDetail.js'), request: get({ id: A.jobId }), expect: ADMINS },
  { route: 'auth/health', load: auth('admin/health.js'), request: get(), expect: ADMIN_LIST },
  { route: 'auth/events', load: auth('auth/events.js'), request: get(), expect: ADMIN_LIST },
  // Billing profiles are platform-only: a school admin never sees even its own.
  { route: 'auth/billing-profiles', name: 'list', load: auth('billing/profiles.js'), request: get(), expect: expect({ skyll: 'allow' }) },
  { route: 'auth/billing-profiles', name: 'save (PUT)', load: auth('billing/profiles.js'),
    request: { method: 'PUT', query: {}, body: { schoolId: A.school.id, legalName: 'ALPHA_SECRET Pvt Ltd', address: 'Pune', placeOfSupply: 'Maharashtra' } },
    expect: expect({ skyll: 'reach' }) },
  // Invoices: platform-only, like billing profiles.
  ...[
    ['list', get(), 'allow'],
    ['detail', get({ id: A.invoiceId }), 'allow'],
    ['pdf download', get({ id: A.invoiceId, format: 'pdf' }), 'reach'],
    ['preview', post({ action: 'preview', schoolId: A.school.id, period: '2026-09' }), 'reach'],
    ['generate', post({ action: 'generate', schoolId: A.school.id, period: '2026-09' }), 'reach'],
    ['mark paid', post({ action: 'mark-paid', invoiceId: A.invoiceId, paidOn: '2026-10-03', reference: 'UTR1' }), 'reach'],
    ['unmark paid', post({ action: 'unmark-paid', invoiceId: A.invoiceId }), 'reach'],
    ['void', post({ action: 'void', invoiceId: A.invoiceId, reason: 'matrix' }), 'reach'],
  ].map(([name, request, skyll]) => ({ route: 'auth/invoices', name, load: auth('billing/invoices.js'), request, expect: expect({ skyll }) })),

  // ── /api/intake ─────────────────────────────────────────────────────────
  { route: 'intake/batches', load: auth('intake/batches.js'), request: get(), expect: ADMIN_OWN_SCHOOL_LIST },
  { route: 'intake/devices', load: auth('intake/devices.js'), request: get(), expect: ADMIN_OWN_SCHOOL_LIST },
  { route: 'intake/tests', name: 'list', load: auth('intake/tests.js'), request: get(), expect: ADMIN_OWN_SCHOOL_LIST },
  { route: 'intake/tests', name: 'detail', load: auth('intake/tests.js'), request: get({ id: A.testId }), expect: ADMIN_OWN_SCHOOL_ITEM },
  { route: 'intake/tests', name: 'rename (PATCH)', load: auth('intake/tests.js'),
    request: { method: 'PATCH', query: {}, body: { testId: A.testId, title: 'ALPHA_SECRET renamed' } }, expect: ADMIN_OWN_SCHOOL_ITEM },
  { route: 'intake/tests', name: 'delete', load: auth('intake/tests.js'), request: { method: 'DELETE', query: { id: A.testId } },
    expect: expect({ adminA: 'reach', skyll: 'scoped' }) },
  { route: 'intake/jobs', name: 'list', load: auth('intake/jobs.js'), request: get(), expect: ADMIN_OWN_SCHOOL_LIST },
  { route: 'intake/jobs', name: 'start processing', load: auth('intake/jobs.js'), request: post({ testId: A.testId }),
    expect: expect({ adminA: 'reach', skyll: 'scoped' }) },
  { route: 'intake/uploads', name: 'complete an asset', load: auth('intake/uploads.js'), request: post({ action: 'complete', assetId: A.assetId, byteSize: 10 }),
    expect: expect({ adminA: 'reach', skyll: 'scoped' }) },

  // ── /api/ai (teacher tools: teacherGate) ─────────────────────────────────
  ...[
    ['ai/copilot', 'postCopilot', post({ schoolId: A.school.id, question: 'How is the class doing?' })],
    ['ai/lesson-plan', 'postLessonPlan', post({ schoolId: A.school.id, topic: 'Optics' })],
    ['ai/quiz-gen', 'postQuizGen', post({ schoolId: A.school.id, topic: 'Optics' })],
    ['ai/briefing', 'briefing', post({ schoolId: A.school.id })],
    ['ai/intervention', 'postIntervention', post({ schoolId: A.school.id })],
    ['ai/parent-report', 'postParentReport', post({ schoolId: A.school.id, studentId: A.studentId })],
    ['ai/warnings', 'getWarnings', get({ schoolId: A.school.id })],
    ['ai/artifacts', 'getArtifacts', get({ schoolId: A.school.id })],
  ].map(([route, handler, request]) => ({ route, load: ai(handler), request, expect: STAFF })),
  { route: 'ai/coverage', load: ai('getCoverage'), request: get({ schoolId: A.school.id }),
    expect: expect({ teacherA: 'reach', adminA: 'reach', skyll: 'reach' }) },
  ...['ai/hive-class', 'ai/hive/class'].map((route) => ({
    route, load: () => import('../../../server/ai/hive.js').then((m) => m.getHiveClass), request: get({ schoolId: A.school.id }),
    expect: expect({ teacherA: 'reach', adminA: 'reach', skyll: 'reach' }),
  })),

  // ── single-function routes ──────────────────────────────────────────────
  { route: 'images/reference', load: () => import('../../../api/images/[...route].js').then((m) => m.default),
    request: get({ route: 'reference', testId: A.testId, kind: 'question_paper' }), expect: STAFF },
  { route: 'images/answer-sheet', load: () => import('../../../api/images/[...route].js').then((m) => m.default),
    request: get({ route: 'answer-sheet' }), expect: expect({}), denyStatuses: [403, 410],
    note: 'retired: staff get 410 Gone, everyone else 403' },
  { route: 'query', load: () => import('../../../api/query.js').then((m) => m.default), request: post({ q: 'physics scores' }),
    expect: expect({ teacherA: 'allow', adminA: 'allow', teacherB: 'scoped', adminB: 'scoped', skyll: 'scoped' }) },
  { route: 'rechecks/[[...route]]', load: () => import('../../../api/rechecks/[[...route]].js').then((m) => m.default), request: get(),
    expect: expect({ studentA: 'allow', peerA: 'scoped', teacherA: 'allow', adminA: 'allow', teacherB: 'scoped', adminB: 'scoped', skyll: 'allow' }) },
  { route: 'student-context', load: () => import('../../../api/student-context.js').then((m) => m.default), request: get({ username: A.username }),
    expect: expect({ studentA: 'allow', teacherA: 'allow', adminA: 'allow', skyll: 'allow' }) },
  { route: 'teacher-dashboard', load: () => import('../../../api/teacher-dashboard.js').then((m) => m.default), request: get(),
    expect: expect({ teacherA: 'allow', adminA: 'allow', teacherB: 'scoped', adminB: 'scoped', skyll: 'scoped' }) },
  { route: 'vl-review/[id]', load: () => import('../../../api/vl-review/[id].js').then((m) => m.default),
    request: post({ status: 'approved', comment: 'matrix' }, { id: A.questionId }),
    expect: expect({ teacherA: 'reach', adminA: 'reach', skyll: 'reach' }) },

  // ── /api/vl-queue ───────────────────────────────────────────────────────
  { route: 'vl-queue/GET', name: 'summary', load: vlQueue, request: get({ summary: 'true' }), expect: STAFF_LIST },
  { route: 'vl-queue/GET', name: 'full list', load: vlQueue, request: get({ school: A.school.name, subject: A.subject }), expect: STAFF_LIST },
  { route: 'vl-queue/preview-cohort-regrade', load: vlQueue, request: post({ action: 'preview-cohort-regrade', ...cohort }), expect: STAFF },
  { route: 'vl-queue/start-cohort-regrade', load: vlQueue, request: post({ action: 'start-cohort-regrade', ...cohort }),
    expect: expect({ teacherA: 'reach', adminA: 'reach', skyll: 'reach' }) },
  { route: 'vl-queue/retry-cohort-regrade', load: vlQueue, request: post({ action: 'retry-cohort-regrade', runId: A.runId }),
    expect: expect({ teacherA: 'reach', adminA: 'reach', skyll: 'reach' }) },
  { route: 'vl-queue/mark-cohort-complete', load: vlQueue, request: post({ action: 'mark-cohort-complete', school: A.school.name, testId: 'test_a_other' }),
    expect: expect({ teacherA: 'reach', adminA: 'reach', skyll: 'reach' }) },
  { route: 'vl-queue/unmark-cohort-complete', load: vlQueue, request: post({ action: 'unmark-cohort-complete', school: A.school.name, testId: A.testId }),
    expect: expect({ teacherA: 'reach', adminA: 'reach', skyll: 'reach' }) },
  { route: 'vl-queue/approve-cohort', load: vlQueue, request: post({ action: 'approve-cohort', studentId: A.studentId, testId: A.testId }),
    expect: expect({ adminA: 'reach', skyll: 'reach' }) },
  { route: 'vl-queue/edit-answer', load: vlQueue,
    request: post({ action: 'edit-answer', itemId: A.questionId, studentAnswer: { attempted: true, studentWrote: 'ALPHA_SECRET edited', confidence: 'high' } }),
    expect: STAFF },
  // Locations carry no answer text, so there is no marker to prove the read; staff
  // must pass authorization and everyone else must be denied.
  { route: 'vl-queue/answer-locations', load: vlQueue, request: post({ action: 'answer-locations', testId: A.testId, testStudentId: A.testStudentId }),
    expect: expect({ teacherA: 'reach', adminA: 'reach', skyll: 'reach' }) },
  { route: 'vl-queue/list-rubric-reviews', load: vlQueue, request: post({ action: 'list-rubric-reviews' }), expect: ADMIN_LIST },
  { route: 'vl-queue/get-rubric-review', load: vlQueue, request: post({ action: 'get-rubric-review', testId: A.rubricTestId }), expect: ADMINS },
  { route: 'vl-queue/save-rubric-review', load: vlQueue,
    request: post({ action: 'save-rubric-review', testId: A.rubricTestId, questions: [{ number: 'Q1', marks: 5, question_text: 'Q', answer_key: 'a' }] }),
    expect: expect({ adminA: 'reach', skyll: 'reach' }) },
  { route: 'vl-queue/approve-rubric', load: vlQueue, request: post({ action: 'approve-rubric', testId: A.rubricTestId }),
    expect: expect({ adminA: 'reach', skyll: 'reach' }) },
];
