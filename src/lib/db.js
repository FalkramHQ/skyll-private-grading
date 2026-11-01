// API helpers for the frontend. All fetch calls go through apiClient
// for retry, dedup, and normalized error handling.
import { apiGet, apiSend, apiPost } from './apiClient';

// ─── Student ──────────────────────────────────────────────────────────────────
export function getStudentContext(username) {
  const params = new URLSearchParams();
  if (username) params.set('username', username);
  const suffix = params.toString() ? `?${params}` : '';
  return apiGet(`/api/student-context${suffix}`);
}

export function getStudentProfile() {
  return apiGet('/api/auth/profile', 'Could not load your profile');
}

// ─── Teacher ──────────────────────────────────────────────────────────────────
export function getTeacherDashboard(params = {}) {
  const qs = new URLSearchParams();
  if (params.year) qs.set('year', params.year);
  const suffix = qs.toString() ? `?${qs}` : '';
  return apiGet(`/api/teacher-dashboard${suffix}`);
}

export function getTeacherProfile() { return apiGet('/api/auth/teacher-profile'); }
export function getTeacherRoster() { return apiGet('/api/auth/teacher-roster'); }
export function saveTeacherRoster(method, body) {
  return apiSend('/api/auth/teacher-roster', method, body, 'Could not update the school roster');
}
export function changePassword(currentPassword, newPassword) {
  return apiPost('/api/auth/change-password', { currentPassword, newPassword }, 'Could not change password');
}

// ─── Hive ─────────────────────────────────────────────────────────────────────
export function getHive(username) {
  const params = new URLSearchParams();
  if (username) params.set('username', username);
  const suffix = params.toString() ? `?${params}` : '';
  return apiGet(`/api/ai/hive${suffix}`, 'Could not load Learning Hive');
}

export function getHiveClass({ className, schoolId } = {}) {
  const params = new URLSearchParams();
  if (className) params.set('class', className);
  if (schoolId) params.set('schoolId', schoolId);
  const suffix = params.toString() ? `?${params}` : '';
  return apiGet(`/api/ai/hive-class${suffix}`, 'Could not load class Hive');
}

export function requestHiveSynthesis({ username, studentId, schoolId } = {}) {
  return apiPost('/api/ai/hive-synthesize', { username, studentId, schoolId }, 'Could not queue Hive synthesis');
}

// ─── Tutor ────────────────────────────────────────────────────────────────────
export function askTutor({ question, sessionId, username, studentId } = {}) {
  return apiPost('/api/ai/tutor', { question, sessionId, username, studentId }, 'Tutor request failed');
}

export function getTutorHistory(sessionId) {
  const params = new URLSearchParams({ sessionId });
  return apiGet(`/api/ai/tutor?${params}`, 'Could not load tutor history');
}

export function listTutorSessions({ limit } = {}) {
  const params = new URLSearchParams({ list: '1' });
  if (limit) params.set('limit', String(limit));
  return apiGet(`/api/ai/tutor?${params}`, 'Could not load tutor sessions');
}

// ─── Revision ──────────────────────────────────────────────────────────────────
export function createRevisionPlan({ username, studentId, subject, schoolId } = {}) {
  return apiPost('/api/ai/revision', { username, studentId, subject, schoolId }, 'Could not create revision plan');
}

export function listRevisionPlans({ username, limit } = {}) {
  const params = new URLSearchParams({ list: '1' });
  if (username) params.set('username', username);
  if (limit) params.set('limit', String(limit));
  return apiGet(`/api/ai/revision?${params}`, 'Could not load revision plans');
}

// ─── Readiness ─────────────────────────────────────────────────────────────────
export function getReadinessScore({ username, subject, topics } = {}) {
  const params = new URLSearchParams();
  if (username) params.set('username', username);
  if (subject) params.set('subject', subject);
  if (Array.isArray(topics) && topics.length) params.set('topics', topics.join('|'));
  const suffix = params.toString() ? `?${params}` : '';
  return apiGet(`/api/ai/readiness${suffix}`, 'Could not load readiness');
}

// ─── Practice ──────────────────────────────────────────────────────────────────
export function generatePracticeTest({ username, studentId, subject, topics, count, schoolId } = {}) {
  return apiPost('/api/ai/practice', {
    action: 'generate',
    username, studentId, subject, topics, count, schoolId,
  }, 'Could not generate practice test');
}

export function gradePracticeTest({ practiceTestId, answers, username, studentId, schoolId } = {}) {
  return apiPost('/api/ai/practice', {
    action: 'grade',
    practiceTestId, answers, username, studentId, schoolId,
  }, 'Could not grade practice test');
}

export function getPracticeTest(id) {
  const params = new URLSearchParams({ id });
  return apiGet(`/api/ai/practice?${params}`, 'Could not load practice test');
}

export function listPracticeTests({ username, limit } = {}) {
  const params = new URLSearchParams({ list: '1' });
  if (username) params.set('username', username);
  if (limit) params.set('limit', String(limit));
  return apiGet(`/api/ai/practice?${params}`, 'Could not load practice history');
}

// ─── Teacher AI Tools ─────────────────────────────────────────────────────────
export function getTeacherBriefing({ className, subject, examId, schoolId } = {}) {
  const params = new URLSearchParams();
  if (className) params.set('class', className);
  if (subject) params.set('subject', subject);
  if (examId) params.set('examId', examId);
  if (schoolId) params.set('schoolId', schoolId);
  const suffix = params.toString() ? `?${params}` : '';
  return apiGet(`/api/ai/briefing${suffix}`, 'Could not load teacher briefing');
}

export function askTeacherCopilot({ question, className, subject, examId, schoolId, history } = {}) {
  return apiPost('/api/ai/copilot', { question, className, subject, examId, schoolId, history }, 'Copilot request failed');
}

export function requestLessonPlan({ className, subject, topic, examId, schoolId } = {}) {
  return apiPost('/api/ai/lesson-plan', { className, subject, topic, examId, schoolId }, 'Could not generate lesson plan');
}

export function requestQuizGen({ className, subject, topics, topic, count, examId, schoolId } = {}) {
  return apiPost('/api/ai/quiz-gen', { className, subject, topics, topic, count, examId, schoolId }, 'Could not generate quiz');
}

export function requestInterventions({ className, subject, examId, schoolId } = {}) {
  return apiPost('/api/ai/intervention', { className, subject, examId, schoolId }, 'Could not generate interventions');
}

export function requestParentReport({ username, studentId, className, subject, examId, schoolId, tone } = {}) {
  return apiPost('/api/ai/parent-report', { username, studentId, className, subject, examId, schoolId, tone }, 'Could not generate parent report');
}

export function getEarlyWarnings({ className, subject, examId, schoolId, status = 'open' } = {}) {
  const params = new URLSearchParams();
  if (className) params.set('class', className);
  if (subject) params.set('subject', subject);
  if (examId) params.set('examId', examId);
  if (schoolId) params.set('schoolId', schoolId);
  if (status) params.set('status', status);
  const suffix = params.toString() ? `?${params}` : '';
  return apiGet(`/api/ai/warnings${suffix}`, 'Could not load early warnings');
}

export function getCurriculumCoverage({ className, subject, examId, schoolId, board, grade } = {}) {
  const params = new URLSearchParams();
  if (className) params.set('class', className);
  if (subject) params.set('subject', subject);
  if (examId) params.set('examId', examId);
  if (schoolId) params.set('schoolId', schoolId);
  if (board) params.set('board', board);
  if (grade) params.set('grade', grade);
  const suffix = params.toString() ? `?${params}` : '';
  return apiGet(`/api/ai/coverage${suffix}`, 'Could not load curriculum coverage');
}

// ─── AI Artifacts ─────────────────────────────────────────────────────────────
export function listAiArtifacts({ type, limit } = {}) {
  const params = new URLSearchParams();
  if (type) params.set('type', type);
  if (limit) params.set('limit', String(limit));
  const suffix = params.toString() ? `?${params}` : '';
  return apiGet(`/api/ai/artifacts${suffix}`, 'Could not load AI artifacts');
}
