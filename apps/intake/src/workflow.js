import { SUBJECTS, resolveCanonicalSubject } from '@skyll/shared/subjects.js';

export const DRAFT_KEY_PREFIX = 'skyll:intake:draft:v1';
export const WORKSPACE_KEY_PREFIX = 'skyll:intake:workspace:v1';
export { SUBJECTS };

// Mirrors server/intake/tests.js MAX_TITLE_LENGTH so client validation matches
// what the API enforces (creation and rename are capped identically).
export const MAX_TEST_TITLE_LENGTH = 120;

export function mobileRoleCapabilities(role) {
  return {
    canUseMobileApp: ['student', 'admin', 'scanner'].includes(role),
    canScanExistingTests: ['admin', 'scanner'].includes(role),
    canCreateTests: role === 'admin',
    canRenameTests: ['admin', 'skyll_admin'].includes(role),
    canManageReferenceFiles: role === 'admin',
    canDeleteTests: role === 'admin',
    canQueueProcessing: role === 'admin',
    canViewClassInsights: role === 'admin',
    canViewDeviceStatus: role === 'admin',
  };
}

export function draftKey(user) {
  return `${DRAFT_KEY_PREFIX}:${user?.username || user?.id || 'admin'}`;
}

export function workspaceKey(user) {
  return `${WORKSPACE_KEY_PREFIX}:${user?.username || user?.id || 'admin'}`;
}

export function normalizeWorkspace(value) {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = {};
    }
  }
  const screen = parsed?.screen === 'editor' ? 'editor' : 'home';
  const testId = typeof parsed?.testId === 'string' ? parsed.testId.trim() : '';
  return { screen, testId };
}

export function parseStoredWorkspace(raw) {
  if (raw == null || raw === '') return null;
  return normalizeWorkspace(raw);
}

export function singleActiveQueueTestId(items = []) {
  const ids = [...new Set((Array.isArray(items) ? items : [])
    .filter((item) => ['queued', 'uploading', 'failed'].includes(item?.status) && item?.testId)
    .map((item) => String(item.testId)))];
  return ids.length === 1 ? ids[0] : '';
}

export function resumeEditorTestId({ draft, workspace, queueTestId } = {}) {
  const workspaceTestId = typeof workspace?.testId === 'string' ? workspace.testId.trim() : '';
  const draftTestId = draft?.test?.id ? String(draft.test.id).trim() : '';
  const activeQueueTestId = typeof queueTestId === 'string' ? queueTestId.trim() : '';
  if (workspace?.screen === 'editor' && workspaceTestId) return workspaceTestId;
  if (draft?.pendingScan && draftTestId) return draftTestId;
  if (workspace == null && activeQueueTestId) return activeQueueTestId;
  return '';
}

export function pendingScanForOpenedTest(pendingScan, openedStudentIds = []) {
  const studentId = pendingScan?.student?.testStudentId;
  if (!studentId) return null;
  const ids = Array.isArray(openedStudentIds) ? openedStudentIds : [];
  if (ids.length && !ids.includes(studentId)) return null;
  return pendingScan;
}

export const EXAM_TYPES = ['mcq', 'subjective', 'mixed'];

/* Local (device-timezone) YYYY-MM-DD — UTC slicing can be a day off for schools. */
export function localDateString(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function buildCalendarWeeks({ year, month } = {}) {
  if (!Number.isFinite(Number(year)) || !Number.isFinite(Number(month))) {
    const now = new Date();
    year = now.getFullYear();
    month = now.getMonth();
  }
  const firstDay = new Date(year, month, 1);
  const startWeekday = firstDay.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < startWeekday; i += 1) cells.push(null);
  for (let d = 1; d <= daysInMonth; d += 1) cells.push(new Date(year, month, d));
  const remainder = cells.length % 7;
  if (remainder !== 0) {
    for (let i = 0; i < 7 - remainder; i += 1) cells.push(null);
  }
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) {
    weeks.push(cells.slice(i, i + 7));
  }
  return weeks;
}

export function normalizeExamDate(value) {
  const text = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}

export function normalizeExamType(value) {
  return EXAM_TYPES.includes(value) ? value : 'subjective';
}

export function normalizeSubjectChoice(value) {
  return resolveCanonicalSubject(value) || 'Chemistry';
}

export function normalizeUploadAssets(assets = []) {
  return (Array.isArray(assets) ? assets : [])
    .filter((asset) => asset && typeof asset === 'object')
    .map((asset) => (
      ['registered', 'uploading'].includes(asset.status)
        ? { ...asset, status: 'failed', error: asset.error || 'Upload interrupted. Tap retry or discard to continue.' }
        : asset
    ));
}

export function normalizeDraft(draft = {}) {
  return {
    title: draft.title || '',
    subject: normalizeSubjectChoice(draft.subject),
    examDate: normalizeExamDate(draft.examDate),
    examType: normalizeExamType(draft.examType),
    selectedBatchIds: Array.isArray(draft.selectedBatchIds) ? draft.selectedBatchIds : [],
    test: draft.test || null,
    assets: normalizeUploadAssets(draft.assets),
    job: draft.job || null,
    pendingScan: draft.pendingScan || null,
  };
}

export function isResumableDraft(draft) {
  return Boolean(draft?.test || draft?.pendingScan);
}

function uploadedSheetCountByStudent(assets = []) {
  const counts = {};
  for (const asset of assets) {
    if (asset?.status !== 'uploaded' || asset.kind !== 'answer_sheet') continue;
    const studentId = typeof asset.testStudentId === 'string' ? asset.testStudentId.trim() : '';
    if (!studentId) continue;
    counts[studentId] = (counts[studentId] || 0) + 1;
  }
  return counts;
}

function queueItemBlocksProcessing(item, uploadedByStudent) {
  if (!item) return false;
  if (item.status === 'queued' || item.status === 'uploading') return true;
  if (item.status !== 'failed') return false;
  const expected = Number(item.expectedPageCount) || 0;
  const uploaded = uploadedByStudent[item.testStudentId] || 0;
  if (expected > 0 && uploaded >= expected) return false;
  return true;
}

export function processingBlockReason(assets = [], queueItems = []) {
  const safeAssets = Array.isArray(assets) ? assets.filter((asset) => asset && typeof asset === 'object') : [];
  const uploadedByStudent = uploadedSheetCountByStudent(safeAssets);
  const blockingQueue = (Array.isArray(queueItems) ? queueItems : []).filter((item) => queueItemBlocksProcessing(item, uploadedByStudent));
  if (blockingQueue.some((item) => item.status === 'queued' || item.status === 'uploading')) {
    return 'Wait for in-progress uploads to finish.';
  }
  if (blockingQueue.some((item) => item.status === 'failed')) {
    return 'Retry or discard failed uploads, then queue processing.';
  }
  const uploadedKinds = new Set(
    safeAssets.filter((asset) => asset.status === 'uploaded').map((asset) => asset.kind),
  );
  const hasStudentAnswerSheet = Object.keys(uploadedByStudent).length > 0;
  if (uploadedKinds.has('question_paper') && uploadedKinds.has('answer_key') && hasStudentAnswerSheet) return '';
  return 'Attach the question paper, answer key, and at least one answer sheet.';
}

export function canQueueProcessing(assets = [], queueItems = []) {
  return !processingBlockReason(assets, queueItems);
}

export function removeUploadedAnswerSheets(assets = [], testStudentId) {
  return (Array.isArray(assets) ? assets : []).filter((asset) => !(
    asset?.kind === 'answer_sheet' && asset.testStudentId === testStudentId
  ));
}

export function filterStudentsByName(students = [], query = '') {
  const safeStudents = Array.isArray(students) ? students : [];
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return safeStudents;
  return safeStudents.filter((student) => (
    String(student?.name || '').toLowerCase().includes(needle)
  ));
}

export function scanQualityWarnings({ width = 0, height = 0, byteSize = 0, readableCharacters = 0, ocrConfidence = 0 } = {}) {
  width = Number.isFinite(Number(width)) ? Number(width) : 0;
  height = Number.isFinite(Number(height)) ? Number(height) : 0;
  byteSize = Number.isFinite(Number(byteSize)) ? Number(byteSize) : 0;
  readableCharacters = Number.isFinite(Number(readableCharacters)) ? Number(readableCharacters) : 0;
  ocrConfidence = Number.isFinite(Number(ocrConfidence)) ? Number(ocrConfidence) : 0;
  const warnings = [];
  const shortestSide = Math.min(width, height);
  if (!width || !height) warnings.push('Could not verify image dimensions. Inspect this page before upload.');
  if (shortestSide && shortestSide < 900) warnings.push('Low resolution. Retake this page if handwriting is not crisp.');
  if (byteSize && byteSize < 100000) warnings.push('Very little image detail was captured. Check for blur, glare, or an incomplete page.');
  if (shortestSide && shortestSide < 900 && readableCharacters < 12 && ocrConfidence < 0.35) warnings.push('The on-device legibility check found very little readable content. This may be a diagram-only page, but check for blur or glare.');
  return warnings;
}

export function mobileAnswerSheetPath({ subject, student } = {}) {
  const params = new URLSearchParams({ subject: String(subject || '') });
  if (student) params.set('student', String(student));
  return `/api/student-answer-sheet?${params.toString()}`;
}

// Mirrors recheckCollectionService.normalizeReason so the client's live counter
// and the API agree on length: trim, then collapse internal whitespace runs to
// a single space. A note that only reaches the minimum by padding with extra
// spaces is rejected here exactly as the server rejects it.
export const RECHECK_REASON_MIN = 12;
export const RECHECK_REASON_MAX = 800;

export function normalizeRecheckReason(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

export function canSubmitRecheck({ submissionId, subject, questionNumber, reason } = {}) {
  const length = normalizeRecheckReason(reason).length;
  return Boolean(submissionId && subject && questionNumber && length >= RECHECK_REASON_MIN && length <= RECHECK_REASON_MAX);
}

export function studentPageCounterKey(testId, testStudentId) {
  return `@page_counter_${testId}_${testStudentId}`;
}

export function extractPageNumberFromFilename(filename = '') {
  const match = String(filename || '').match(/-(\d+)\.jpg$/i);
  if (!match) return 0;
  const num = parseInt(match[1], 10);
  return Number.isFinite(num) ? num : 0;
}

export function calculateNextPageNumber({ storedCounter, assets = [], existingPages = [], testStudentId, reset = false } = {}) {
  if (reset && (!existingPages || existingPages.length === 0)) {
    return 1;
  }
  const counter = Number.isFinite(Number(storedCounter)) ? Number(storedCounter) : 0;

  const maxAssetPage = (Array.isArray(assets) ? assets : []).reduce((max, asset) => {
    if (asset?.kind === 'answer_sheet' && asset.testStudentId === testStudentId && asset.status !== 'superseded') {
      return Math.max(max, extractPageNumberFromFilename(asset.label || asset.file?.name));
    }
    return max;
  }, 0);

  const maxExistingPage = (Array.isArray(existingPages) ? existingPages : []).reduce((max, page) => {
    return Math.max(max, extractPageNumberFromFilename(page?.uri));
  }, 0);

  return Math.max(counter, maxAssetPage, maxExistingPage) + 1;
}
