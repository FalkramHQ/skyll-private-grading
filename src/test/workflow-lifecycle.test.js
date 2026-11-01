import { describe, expect, it } from 'vitest';
import {
  ACTIVE_RECHECK_STATES,
  SCAN_REMOVAL_ALLOWED_TEST_STATES,
  answerSheetUploadBlockedMessage,
  canAcceptAnswerSheetUpload,
  canRemoveStudentScan,
  canTransitionRecheck,
  isActiveRecheck,
  recheckStatusLabel,
} from '../../shared/workflowLifecycle.js';

describe('student scan removal lifecycle', () => {
  it('allows a scan reset only while the assessment is still in intake', () => {
    expect(SCAN_REMOVAL_ALLOWED_TEST_STATES).toEqual(['draft', 'uploading', 'ready_to_process', 'ready_for_processing']);
    expect(canRemoveStudentScan({ testStatus: 'uploading' })).toBe(true);
    expect(canRemoveStudentScan({ testStatus: 'ready_to_process' })).toBe(true);
    expect(canRemoveStudentScan({ testStatus: 'ready_for_processing' })).toBe(true);
    expect(canRemoveStudentScan({ testStatus: 'queued' })).toBe(false);
    expect(canRemoveStudentScan({ testStatus: 'ready_for_review' })).toBe(false);
    expect(canRemoveStudentScan({ testStatus: 'rubric_ready_for_review' })).toBe(false);
  });

  it('never allows a scan reset while processing work is queued or running', () => {
    expect(canRemoveStudentScan({ testStatus: 'uploading', hasActiveProcessingJob: true })).toBe(false);
  });

  it('blocks new answer-sheet creates once an assessment is delivered or in review', () => {
    expect(canAcceptAnswerSheetUpload({ testStatus: 'uploading' })).toBe(true);
    expect(canAcceptAnswerSheetUpload({ testStatus: 'ready_for_review' })).toBe(false);
    expect(canAcceptAnswerSheetUpload({ testStatus: 'published' })).toBe(false);
    expect(answerSheetUploadBlockedMessage('ready_for_review')).toMatch(/locked/i);
  });
});

describe('canonical recheck lifecycle', () => {
  it('keeps only unresolved requests active', () => {
    expect(ACTIVE_RECHECK_STATES).toEqual(['open', 'in_review', 'awaiting_regrade']);
    expect(isActiveRecheck('awaiting_regrade')).toBe(true);
    expect(isActiveRecheck('resolved')).toBe(false);
  });

  it('allows the review-to-publication path and rejects impossible jumps', () => {
    expect(canTransitionRecheck('open', 'in_review')).toBe(true);
    expect(canTransitionRecheck('in_review', 'awaiting_regrade')).toBe(true);
    expect(canTransitionRecheck('awaiting_regrade', 'resolved')).toBe(true);
    expect(canTransitionRecheck('open', 'resolved')).toBe(false);
    expect(recheckStatusLabel('awaiting_regrade')).toBe('Updating report');
  });
});
