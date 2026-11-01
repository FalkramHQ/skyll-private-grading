import { describe, expect, it } from 'vitest';
import { lifecycleJobForAssessment, projectOperationsAssessment, projectProcessingTelemetry } from '../../server/admin/assessmentLifecycleProjection.js';

const readyTest = {
  id: 'test_1',
  status: 'uploading',
  updated_at: '2026-07-25T08:00:00.000Z',
  question_papers: 1,
  answer_keys: 1,
  answer_sheets: 2,
  pending_uploads: 0,
};

describe('operations assessment lifecycle projection', () => {
  it('prefers active work over newer historical records', () => {
    const running = { id: 'job_running', status: 'running', type: 'build_reports', requested_at: '2026-07-25T08:00:00.000Z' };
    const succeeded = { id: 'job_done', status: 'succeeded', type: 'mistral_ocr', requested_at: '2026-07-25T09:00:00.000Z' };
    expect(lifecycleJobForAssessment([succeeded, running])).toBe(running);
  });

  it('projects complete uploaded material into ready_to_process', () => {
    const result = projectOperationsAssessment(readyTest);
    expect(result).toMatchObject({
      state: 'ready_to_process',
      action: { id: 'start_ocr', label: 'Start processing' },
      publication: { complete: false, submissionCount: 0, publishedReportCount: 0 },
    });
  });

  it('keeps automatically retried work queued despite an older failed test status', () => {
    const result = projectOperationsAssessment({ ...readyTest, status: 'ocr_failed' }, [{
      status: 'queued',
      type: 'mistral_ocr',
      next_attempt_at: '2026-07-25T08:05:00.000Z',
      requested_at: '2026-07-25T08:01:00.000Z',
    }]);
    expect(result).toMatchObject({
      state: 'queued',
      retryScheduledAt: '2026-07-25T08:05:00.000Z',
    });
  });

  it('uses safe retry metadata for a failed supported stage', () => {
    const result = projectOperationsAssessment({ ...readyTest, status: 'ocr_failed' }, [{
      status: 'failed_retryable',
      type: 'mistral_ocr',
      last_error_code: 'worker_lease_expired',
      error: 'do not expose this server detail',
    }]);
    expect(result).toMatchObject({
      state: 'needs_attention',
      action: { id: 'retry_ocr', label: 'Retry OCR' },
      attention: { code: 'worker_lease_expired' },
    });
    expect(JSON.stringify(result)).not.toContain('server detail');
  });

  it('offers retry_failed_jobs for failed stages without a dedicated retry', () => {
    const result = projectOperationsAssessment({ ...readyTest, status: 'grading_failed' }, [
      { id: 'job_grade', status: 'failed_retryable', type: 'grade_submission', last_error_code: 'model_timeout', requested_at: '2026-07-25T09:00:00.000Z' },
      { id: 'job_evidence', status: 'succeeded', type: 'materialize_evidence', requested_at: '2026-07-25T08:30:00.000Z' },
    ]);
    expect(result).toMatchObject({
      state: 'needs_attention',
      action: { id: 'retry_failed_jobs', label: 'Retry failed jobs' },
      attention: { code: 'model_timeout', retrySupported: true, action: { id: 'retry_failed_jobs' } },
    });
  });

  it('keeps the dedicated OCR retry for a failed OCR stage', () => {
    const result = projectOperationsAssessment({ ...readyTest, status: 'ocr_failed' }, [{ id: 'job_ocr', status: 'failed_retryable', type: 'mistral_ocr' }]);
    expect(result.action).toEqual({ id: 'retry_ocr', label: 'Retry OCR' });
  });

  it('offers reconcile_status when the test says in progress but no job is active', () => {
    const result = projectOperationsAssessment({ ...readyTest, status: 'evidence_processing' }, [
      { id: 'job_evidence', status: 'succeeded', type: 'materialize_evidence', requested_at: '2026-07-25T08:30:00.000Z' },
    ]);
    expect(result).toMatchObject({
      state: 'needs_attention',
      action: { id: 'reconcile_status', label: 'Reconcile status' },
      attention: { code: 'no_active_job' },
    });
  });

  it('does not offer reconcile_status without visible jobs or while work is active', () => {
    expect(projectOperationsAssessment({ ...readyTest, status: 'evidence_processing' }, []).action?.id).not.toBe('reconcile_status');
    const running = projectOperationsAssessment({ ...readyTest, status: 'evidence_processing' }, [{ id: 'job_evidence', status: 'running', type: 'materialize_evidence' }]);
    expect(running.state).toBe('processing');
  });

  it('uses complete published-report evidence as the authoritative published state', () => {
    const result = projectOperationsAssessment(
      { ...readyTest, status: 'ready_for_review' },
      [],
      { submission_count: 2, published_report_count: 2, published_at: '2026-07-25T08:30:00.000Z' },
    );
    expect(result).toMatchObject({
      state: 'published',
      updatedAt: '2026-07-25T08:30:00.000Z',
      publication: { complete: true, submissionCount: 2, publishedReportCount: 2 },
    });
  });

  it('keeps incomplete publication at ready_for_review', () => {
    const result = projectOperationsAssessment(
      { ...readyTest, status: 'ready_for_review' },
      [],
      { submission_count: 2, published_report_count: 1 },
    );
    expect(result.state).toBe('ready_for_review');
    expect(result.publication.complete).toBe(false);
  });

  it('projects safe, stage-level progress from live worker jobs', () => {
    const telemetry = projectProcessingTelemetry([
      { id: 'job_ocr', type: 'mistral_ocr', status: 'succeeded' },
      { id: 'job_evidence', type: 'materialize_evidence', status: 'running', attempt_count: 2, progress_json: JSON.stringify({ updatedAt: '2026-07-25T08:30:00.000Z' }) },
      { id: 'job_grade_1', type: 'grade_submission', status: 'queued' },
      { id: 'job_grade_2', type: 'grade_submission', status: 'queued' },
    ], new Map([['job_evidence', { detail: 'Question evidence materialized for 12/24 student(s)' }]]));
    expect(telemetry).toMatchObject({
      current: { stage: 'materialize_evidence', label: 'Answer evidence', status: 'running', attemptCount: 2, detail: 'Question evidence materialized for 12/24 student(s)' },
      stages: { ocr: { succeeded: 1 }, evidence: { running: 1 }, grading: { queued: 2 } },
    });
  });
});
