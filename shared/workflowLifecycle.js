// Canonical lifecycle vocabulary shared by APIs, workers, and UI clients.
export const TEST_STATES = Object.freeze([
  'draft',
  'uploading',
  'ready_to_process',
  'queued',
  'processing',
  'rubric_ready_for_review',
  'ready_for_review',
  'published',
  'needs_attention',
  'cancelled',
]);

// Source scans may be changed only while they are still intake inputs. The API
// must additionally reject the operation whenever a queued or running job
// exists, since worker-specific test states can be more granular than the
// canonical assessment lifecycle.
export const SCAN_REMOVAL_ALLOWED_TEST_STATES = Object.freeze([
  'draft',
  'uploading',
  'ready_to_process',
  // Existing intake routes still persist this legacy spelling. Keep it safe
  // until the stored-state migration is complete.
  'ready_for_processing',
]);

export const RUBRIC_REVIEW_TEST_STATUSES = Object.freeze([
  'rubric_ready_for_review',
  // Legacy spelling briefly used before the explicit human gate.
  'rubric_complete',
]);

export function canRemoveStudentScan({ testStatus, hasActiveProcessingJob = false } = {}) {
  return !hasActiveProcessingJob && SCAN_REMOVAL_ALLOWED_TEST_STATES.includes(String(testStatus || '').trim());
}

/**
 * New answer-sheet creates follow the same intake window as scan removal.
 * Once an assessment is past intake (queued / processing / review / published),
 * local queue recovery must not keep pushing duplicate sheets into it.
 */
export function canAcceptAnswerSheetUpload({ testStatus, hasActiveProcessingJob = false } = {}) {
  return canRemoveStudentScan({ testStatus, hasActiveProcessingJob });
}

export function answerSheetUploadBlockedMessage(testStatus = '') {
  const status = String(testStatus || '').trim() || 'delivered';
  return `This assessment is locked (${status.replaceAll('_', ' ')}). New answer sheets are blocked so finished exams are not re-uploaded from the phone queue.`;
}

export function isAwaitingRubricReview(testStatus) {
  return RUBRIC_REVIEW_TEST_STATUSES.includes(String(testStatus || '').trim().toLowerCase());
}

const ASSESSMENT_PRESENTATION = Object.freeze({
  draft: Object.freeze({
    label: 'Draft',
    explanation: 'Complete the assessment setup before uploading materials.',
    action: Object.freeze({ id: 'continue_setup', label: 'Continue setup' }),
    tone: 'neutral',
  }),
  uploading: Object.freeze({
    label: 'Uploading',
    explanation: 'Upload the question paper, answer key, and answer sheets before processing.',
    action: Object.freeze({ id: 'continue_upload', label: 'Continue uploads' }),
    tone: 'info',
  }),
  ready_to_process: Object.freeze({
    label: 'Ready to process',
    explanation: 'All required files are available. Start processing when you are ready.',
    action: Object.freeze({ id: 'start_ocr', label: 'Start processing' }),
    tone: 'ready',
  }),
  queued: Object.freeze({
    label: 'Queued',
    explanation: 'The assessment is waiting for a processing worker.',
    action: Object.freeze({ id: 'refresh', label: 'Refresh status' }),
    tone: 'info',
  }),
  processing: Object.freeze({
    label: 'Processing',
    explanation: 'Processing is in progress. You can safely leave this page and check back later.',
    action: Object.freeze({ id: 'refresh', label: 'Refresh status' }),
    tone: 'info',
  }),
  rubric_ready_for_review: Object.freeze({
    label: 'Rubric ready for review',
    explanation: 'The marking rubric is ready. Review it against the question paper and ideal answers, then mark for grading.',
    action: Object.freeze({ id: 'open_rubric_review', label: 'Review rubric' }),
    tone: 'ready',
  }),
  ready_for_review: Object.freeze({
    label: 'Ready for review',
    explanation: 'Processing is complete and the assessment is ready for reviewer approval.',
    action: Object.freeze({ id: 'open_review', label: 'Open review' }),
    tone: 'ready',
  }),
  published: Object.freeze({
    label: 'Published',
    explanation: 'Published student reports are available.',
    action: null,
    tone: 'success',
  }),
  needs_attention: Object.freeze({
    label: 'Needs attention',
    explanation: 'Processing needs an administrator decision before it can continue.',
    action: Object.freeze({ id: 'escalate', label: 'Contact operations' }),
    tone: 'warning',
  }),
  cancelled: Object.freeze({
    label: 'Cancelled',
    explanation: 'This assessment was cancelled before publication.',
    action: null,
    tone: 'neutral',
  }),
});

const JOB_STAGE_LABELS = Object.freeze({
  mistral_ocr: 'OCR',
  build_rubric: 'question-map generation',
  materialize_evidence: 'answer-evidence preparation',
  visual_rescue: 'visual verification',
  grade_submission: 'grading',
  build_reports: 'report publishing',
});

function copyPresentation(state) {
  const presentation = ASSESSMENT_PRESENTATION[state];
  return {
    state,
    label: presentation.label,
    explanation: presentation.explanation,
    action: presentation.action ? { ...presentation.action } : null,
    tone: presentation.tone,
  };
}

function jobStage(job = {}) {
  return JOB_STAGE_LABELS[job.type] || 'processing';
}

function isFailed(value) {
  const status = String(value || '');
  return status.startsWith('failed') || status.endsWith('_failed') || status === 'processing_failed';
}

function attentionFor(job = {}, testStatus) {
  const stage = jobStage(job);
  const code = String(job.lastErrorCode || '').trim().toLowerCase();
  const summary = code === 'worker_lease_expired'
    ? 'The processing worker stopped before completing this assessment.'
    : `${stage.charAt(0).toUpperCase()}${stage.slice(1)} needs attention before processing can continue.`;
  const retryAction = job.type === 'mistral_ocr'
    ? { id: 'retry_ocr', label: 'Retry OCR' }
    : job.type === 'build_rubric'
      ? { id: 'retry_rubric', label: 'Retry question map' }
      : null;
  return {
    summary,
    code: code || null,
    source: job.type || (isFailed(testStatus) ? 'assessment' : null),
    retrySupported: Boolean(retryAction),
    action: retryAction,
  };
}

/**
 * Project raw test, asset, job, review, and publication evidence into the
 * documented assessment lifecycle. The caller owns collecting trustworthy
 * evidence; this function deliberately has no database or clock dependency.
 */
export function projectAssessmentLifecycle({
  testStatus,
  updatedAt = null,
  cancelled = false,
  assets = {},
  job = null,
  reviewReady = false,
  publication = {},
} = {}) {
  const normalizedTestStatus = String(testStatus || '').trim().toLowerCase();
  const normalizedJobStatus = String(job?.status || '').trim().toLowerCase();
  const assetsReady = Boolean(assets.questionPaper && assets.answerKey && Number(assets.answerSheets || 0) > 0);
  const pendingUploads = Number(assets.pendingUploads || 0) > 0;
  let result;

  if (cancelled || normalizedTestStatus === 'cancelled') {
    result = copyPresentation('cancelled');
  } else if (publication.complete) {
    result = copyPresentation('published');
  } else if (normalizedJobStatus === 'running') {
    result = copyPresentation('processing');
  } else if (normalizedJobStatus === 'queued') {
    result = copyPresentation('queued');
    if (job?.nextAttemptAt) {
      result.explanation = 'An automatic retry is scheduled. You can safely leave this page and check back later.';
      result.retryScheduledAt = job.nextAttemptAt;
    }
  } else if (isFailed(normalizedJobStatus) || isFailed(normalizedTestStatus)) {
    result = copyPresentation('needs_attention');
    result.attention = attentionFor(job || {}, normalizedTestStatus);
    if (result.attention.action) result.action = result.attention.action;
  } else if (isAwaitingRubricReview(normalizedTestStatus)) {
    result = copyPresentation('rubric_ready_for_review');
  } else if (reviewReady || normalizedTestStatus === 'ready_for_review') {
    result = copyPresentation('ready_for_review');
  } else if (assetsReady) {
    result = copyPresentation('ready_to_process');
  } else if (pendingUploads || normalizedTestStatus === 'uploading') {
    result = copyPresentation('uploading');
  } else {
    result = copyPresentation('draft');
  }

  return {
    ...result,
    updatedAt: publication.complete ? publication.publishedAt || updatedAt : updatedAt,
  };
}

export function assessmentStateLabel(state) {
  return ASSESSMENT_PRESENTATION[state]?.label || 'Unknown';
}

export const RECHECK_STATES = Object.freeze(['open', 'in_review', 'awaiting_regrade', 'resolved', 'declined', 'cancelled']);

export const ACTIVE_RECHECK_STATES = Object.freeze(['open', 'in_review', 'awaiting_regrade']);

const RECHECK_TRANSITIONS = Object.freeze({
  open: new Set(['in_review', 'declined', 'cancelled']),
  in_review: new Set(['awaiting_regrade', 'declined', 'cancelled']),
  awaiting_regrade: new Set(['resolved', 'in_review']),
  resolved: new Set(),
  declined: new Set(),
  cancelled: new Set(),
});

export function isActiveRecheck(status) {
  return ACTIVE_RECHECK_STATES.includes(status);
}

export function canTransitionRecheck(from, to) {
  return RECHECK_STATES.includes(from) && RECHECK_STATES.includes(to) && RECHECK_TRANSITIONS[from].has(to);
}

export function recheckStatusLabel(status) {
  return ({
    open: 'Requested',
    in_review: 'In review',
    awaiting_regrade: 'Updating report',
    resolved: 'Updated',
    declined: 'Reviewed',
    cancelled: 'Cancelled',
  })[status] || 'Unknown';
}
