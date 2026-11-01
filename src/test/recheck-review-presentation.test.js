import { describe, expect, it } from 'vitest';
import { recheckReviewPresentation } from '../lib/recheckReviewPresentation.js';

describe('review recheck presentation', () => {
  it('makes a student request identifiable with its next reviewer action', () => {
    expect(recheckReviewPresentation({ requestedBy: 'student_a', requestedByRole: 'student', status: 'open' })).toMatchObject({
      requesterKind: 'student',
      requesterLabel: 'Student request',
      requesterName: 'student_a',
      statusLabel: 'Requested',
      actionLabel: 'Take up recheck',
    });
  });

  it('treats staff requesters as teacher requests and explains awaiting regrade', () => {
    expect(recheckReviewPresentation({ requestedBy: 'admin_a', requestedByRole: 'admin', status: 'awaiting_regrade' })).toMatchObject({
      requesterKind: 'teacher',
      requesterLabel: 'Teacher request',
      requesterName: 'admin_a',
      statusLabel: 'Updating report',
      actionLabel: 'Awaiting updated report',
    });
  });
});
