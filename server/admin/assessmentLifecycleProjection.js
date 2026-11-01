import { projectAssessmentLifecycle } from '../../shared/workflowLifecycle.js';

function number(value) {
  return Number(value || 0);
}

function latestActivity(values) {
  return values.filter(Boolean).sort().at(-1) || null;
}

function isFailed(status) {
  return String(status || '').startsWith('failed');
}

const stageNames = {
  mistral_ocr: 'OCR',
  build_rubric: 'Marking rubric',
  materialize_evidence: 'Answer evidence',
  visual_rescue: 'Visual review',
  grade_submission: 'Question grading',
  build_reports: 'Reports',
};

function parseJson(value, fallback = {}) {
  try { return JSON.parse(value || ''); } catch { return fallback; }
}

function stageStatus(jobs, type) {
  const stageJobs = jobs.filter((job) => job.type === type);
  if (!stageJobs.length) return null;
  const current = lifecycleJobForAssessment(stageJobs);
  return {
    status: current?.status || 'queued',
    queued: stageJobs.filter((job) => job.status === 'queued').length,
    running: stageJobs.filter((job) => job.status === 'running').length,
    succeeded: stageJobs.filter((job) => job.status === 'succeeded').length,
    failed: stageJobs.filter((job) => isFailed(job.status)).length,
  };
}

export function projectProcessingTelemetry(jobs = [], stepsByJobId = new Map()) {
  const current = lifecycleJobForAssessment(jobs);
  const step = current ? stepsByJobId.get(current.id) : null;
  const progress = parseJson(current?.progress_json, {});
  return {
    current: current ? {
      stage: current.type,
      label: stageNames[current.type] || 'Processing',
      status: current.status,
      detail: step?.detail || null,
      attemptCount: number(current.attempt_count),
      retryAt: current.next_attempt_at || null,
      updatedAt: progress.updatedAt || current.heartbeat_at || current.started_at || current.requested_at || null,
    } : null,
    stages: {
      ocr: stageStatus(jobs, 'mistral_ocr'),
      rubric: stageStatus(jobs, 'build_rubric'),
      evidence: stageStatus(jobs, 'materialize_evidence'),
      visual: stageStatus(jobs, 'visual_rescue'),
      grading: stageStatus(jobs, 'grade_submission'),
      reports: stageStatus(jobs, 'build_reports'),
    },
  };
}

/**
 * Prefer live work over a newer historical completion/failure record. Jobs
 * arrive from the operations query in newest-requested-first order.
 */
export function lifecycleJobForAssessment(jobs = []) {
  return jobs.find((job) => job.status === 'running')
    || jobs.find((job) => job.status === 'queued')
    || jobs.find((job) => isFailed(job.status))
    || jobs[0]
    || null;
}

/**
 * Convert operations-query rows into the shared, browser-safe lifecycle
 * contract. This module has no database, request, or worker dependency.
 */
export function projectOperationsAssessment(test, jobs = [], publication = {}, stepsByJobId = new Map()) {
  const job = lifecycleJobForAssessment(jobs);
  const submissionCount = number(publication.submission_count);
  const publishedReportCount = number(publication.published_report_count);
  const complete = submissionCount > 0 && submissionCount === publishedReportCount;
  const updatedAt = latestActivity([
    test.updated_at,
    job?.requested_at,
    job?.started_at,
    job?.completed_at,
    publication.published_at,
  ]);
  const lifecycle = projectAssessmentLifecycle({
    testStatus: test.status,
    updatedAt,
    assets: {
      questionPaper: number(test.question_papers) > 0,
      answerKey: number(test.answer_keys) > 0,
      answerSheets: number(test.answer_sheets),
      pendingUploads: number(test.pending_uploads),
    },
    job: job && {
      status: job.status,
      type: job.type,
      nextAttemptAt: job.next_attempt_at,
      lastErrorCode: job.last_error_code,
    },
    reviewReady: test.status === 'ready_for_review',
    publication: {
      complete,
      publishedAt: publication.published_at || null,
    },
  });

  return {
    ...withRecoveryActions(lifecycle, test, jobs, job),
    processing: projectProcessingTelemetry(jobs, stepsByJobId),
    publication: {
      submissionCount,
      publishedReportCount,
      complete,
    },
  };
}

const RETRYABLE_STAGES = new Set(['materialize_evidence', 'visual_rescue', 'grade_submission', 'build_reports']);
const RETRYABLE_FAILED_TEST_STATUSES = new Set(['evidence_failed', 'visual_rescue_failed', 'grading_failed', 'report_failed']);
const RETRY_FAILED_JOBS_ACTION = Object.freeze({ id: 'retry_failed_jobs', label: 'Retry failed jobs' });
const RECONCILE_STATUS_ACTION = Object.freeze({ id: 'reconcile_status', label: 'Reconcile status' });

function isActive(status) {
  return status === 'queued' || status === 'running';
}

function looksInFlight(testStatus) {
  const status = String(testStatus || '').trim().toLowerCase();
  return status === 'queued' || status === 'processing' || status === 'processing_queued' || /_(queued|processing)$/.test(status);
}

/**
 * Offer the operations recovery actions where the shared lifecycle has none:
 *
 *  - a failed evidence / visual / grading / reports stage (OCR and rubric keep
 *    their dedicated retry actions) → retry_failed_jobs;
 *  - a test whose status says work is queued or processing while none of its
 *    known jobs is active → reconcile_status. Only tests with at least one job
 *    in the (newest-first, capped) list qualify: a test with no visible jobs
 *    may simply have had them cut off, and nothing can be said safely.
 */
export function withRecoveryActions(lifecycle, test = {}, jobs = [], job = null) {
  // The shared lifecycle falls back to an "escalate" action when a stage has
  // no dedicated retry; that is the gap the operations route fills.
  if (lifecycle.state === 'needs_attention' && !lifecycle.attention?.retrySupported) {
    const failedStage = job && isFailed(job.status) ? job.type : null;
    const status = String(test.status || '').trim().toLowerCase();
    if ((failedStage && RETRYABLE_STAGES.has(failedStage)) || (!failedStage && RETRYABLE_FAILED_TEST_STATUSES.has(status))) {
      const action = { ...RETRY_FAILED_JOBS_ACTION };
      return { ...lifecycle, action, attention: { ...(lifecycle.attention || {}), retrySupported: true, action: { ...action } } };
    }
    return lifecycle;
  }
  if (jobs.length && !jobs.some((item) => isActive(item.status)) && looksInFlight(test.status)
    && !['needs_attention', 'published', 'cancelled'].includes(lifecycle.state)) {
    const action = { ...RECONCILE_STATUS_ACTION };
    return {
      ...lifecycle,
      state: 'needs_attention',
      label: 'Needs attention',
      tone: 'warning',
      explanation: 'The assessment is recorded as in progress, but no processing job is queued or running for it.',
      action,
      attention: {
        summary: 'The pipeline stopped without recording its outcome. Reconcile the status from the job history to continue.',
        code: 'no_active_job',
        source: 'assessment',
        retrySupported: true,
        action: { ...action },
      },
    };
  }
  return lifecycle;
}
