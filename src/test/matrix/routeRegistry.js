// Every API entry point and where its role × school authorization is tested
// (FLKRM-386). The guard in role-school-matrix.test.js fails when a route is
// discovered (discoverRoutes.js) that is missing here, or listed here but gone.
//
//   matrix   — exercised by the role × school matrix in role-school-matrix.test.js
//   covered  — has dedicated tenancy tests; `by` names the file(s)
//   public   — no tenant data behind it; `why` says what it returns instead
//   self     — returns or changes only the caller's own record; `by` names the test
export const ROUTE_REGISTRY = {
  // ── /api/auth/* ──────────────────────────────────────────────────────────
  'auth/login': { kind: 'covered', by: ['auth-login-handler.test.js', 'session-tenancy-pinning.test.js'] },
  'auth/session': { kind: 'self', why: "returns the caller's own session; tenancy pinned at login", by: ['session-tenancy-pinning.test.js'] },
  'auth/schools': { kind: 'public', why: 'portal branding by slug (display name, logo); no tenant data' },
  'auth/schools/provision': { kind: 'covered', by: ['school-id-authz.test.js'] },
  'auth/schools/roster': { kind: 'covered', by: ['crm/guardian-contacts.integration.test.js', 'classes-first-growth.test.js'] },
  'auth/profile': { kind: 'self', why: "student's own profile", by: ['student-profile-auth.test.js'] },
  'auth/change-password': { kind: 'self', why: "caller's own credential", by: ['student-profile-auth.test.js'] },
  'auth/teacher-profile': { kind: 'self', why: "teacher's own profile", by: ['teacher-roster-auth.test.js'] },
  'auth/features': { kind: 'self', why: "feature flags for the caller's own school_id", by: ['crm/staff-isolation.test.js'] },
  'auth/teacher-roster': { kind: 'matrix' },
  'auth/exam': { kind: 'matrix' },
  'auth/operations': { kind: 'matrix' },
  'auth/operationsDetail': { kind: 'matrix' },
  'auth/health': { kind: 'matrix' },
  'auth/events': { kind: 'matrix' },
  'auth/billing-profiles': { kind: 'matrix' },
  'auth/invoices': { kind: 'matrix' },
  'auth/parent': { kind: 'covered', by: ['parent-report-http-authz.test.js'] },
  'auth/crm/*': { kind: 'covered', by: ['crm/staff-isolation.test.js', 'crm/students-guardians.integration.test.js', 'crm/conversion.integration.test.js'] },

  // ── /api/ai/* ────────────────────────────────────────────────────────────
  'ai/health': { kind: 'public', why: 'service liveness and model availability; no tenant data' },
  'ai/hive': { kind: 'covered', by: ['hive-route-school-scope.test.js', 'ai-context-school-scope.test.js'] },
  'ai/hive-synthesize': { kind: 'covered', by: ['hive-route-school-scope.test.js'] },
  'ai/hive/synthesize': { kind: 'covered', by: ['hive-route-school-scope.test.js'], why: 'alias of ai/hive-synthesize' },
  'ai/hive-class': { kind: 'matrix' },
  'ai/hive/class': { kind: 'matrix', why: 'alias of ai/hive-class' },
  'ai/tutor': { kind: 'covered', by: ['ai-route-tenant-scope.test.js', 'ai-context-school-scope.test.js'] },
  'ai/revision': { kind: 'covered', by: ['ai-route-tenant-scope.test.js'] },
  'ai/readiness': { kind: 'covered', by: ['ai-route-tenant-scope.test.js'] },
  'ai/practice': { kind: 'covered', by: ['ai-route-tenant-scope.test.js'] },
  'ai/mastery': { kind: 'covered', by: ['masteryRoute.test.js'] },
  'ai/copilot': { kind: 'matrix' },
  'ai/lesson-plan': { kind: 'matrix' },
  'ai/quiz-gen': { kind: 'matrix' },
  'ai/briefing': { kind: 'matrix' },
  'ai/intervention': { kind: 'matrix' },
  'ai/warnings': { kind: 'matrix' },
  'ai/coverage': { kind: 'matrix' },
  'ai/artifacts': { kind: 'matrix' },
  'ai/parent-report': { kind: 'matrix' },

  // ── /api/intake/* ────────────────────────────────────────────────────────
  'intake/batches': { kind: 'matrix' },
  'intake/devices': { kind: 'matrix' },
  'intake/tests': { kind: 'matrix' },
  'intake/jobs': { kind: 'matrix' },
  'intake/uploads': { kind: 'matrix' },

  // ── single-function routes ───────────────────────────────────────────────
  'images/reference': { kind: 'matrix' },
  'images/answer-sheet': { kind: 'matrix' },
  query: { kind: 'matrix' },
  'rechecks/[[...route]]': { kind: 'matrix' },
  'student-answer-sheet': { kind: 'covered', by: ['student-answer-sheet-api.test.js'] },
  'student-context': { kind: 'matrix' },
  'teacher-dashboard': { kind: 'matrix' },
  'vl-review/[id]': { kind: 'matrix' },

  // ── /api/vl-queue ────────────────────────────────────────────────────────
  'vl-queue/GET': { kind: 'matrix' },
  'vl-queue/answer-locations': { kind: 'matrix' },
  'vl-queue/approve-cohort': { kind: 'matrix' },
  'vl-queue/edit-answer': { kind: 'matrix' },
  'vl-queue/finalize-cohort': { kind: 'covered', by: ['vl-queue-http-authz.test.js'] },
  'vl-queue/release-to-students': { kind: 'covered', by: ['release-to-students.test.js'] },
  'vl-queue/get-cohort-regrade': { kind: 'covered', by: ['vl-queue-http-authz.test.js'] },
  'vl-queue/preview-cohort-regrade': { kind: 'matrix' },
  'vl-queue/start-cohort-regrade': { kind: 'matrix' },
  'vl-queue/retry-cohort-regrade': { kind: 'matrix' },
  'vl-queue/mark-cohort-complete': { kind: 'matrix' },
  'vl-queue/unmark-cohort-complete': { kind: 'matrix' },
  'vl-queue/list-rubric-reviews': { kind: 'matrix' },
  'vl-queue/get-rubric-review': { kind: 'matrix' },
  'vl-queue/save-rubric-review': { kind: 'matrix' },
  'vl-queue/approve-rubric': { kind: 'matrix' },
};
