import { recheckStatusLabel } from '../../shared/workflowLifecycle.js';
import { recheckRequesterKind } from '../../shared/reviewWorkQueue.js';

export function recheckRequesterLabel(request = {}) {
  return recheckRequesterKind(request) === 'student' ? 'Student request' : 'Teacher request';
}

export function recheckRequesterName(request = {}) {
  return String(request.requestedBy || '').trim() || (recheckRequesterKind(request) === 'student' ? 'Student' : 'Teacher');
}

export function recheckReviewPresentation(request = {}) {
  const status = String(request.status || '').trim();
  const guidance = {
    open: {
      actionLabel: 'Take up recheck',
      actionDetail: 'Take ownership to begin reviewing the request.',
    },
    in_review: {
      actionLabel: 'Review and decide',
      actionDetail: 'Keep the original grade or edit evidence or marks to update the report.',
    },
    awaiting_regrade: {
      actionLabel: 'Awaiting updated report',
      actionDetail: 'The request resolves automatically after the updated report is published.',
    },
  }[status] || {
    actionLabel: 'No reviewer action',
    actionDetail: 'This request is no longer active.',
  };

  return {
    requesterKind: recheckRequesterKind(request),
    requesterLabel: recheckRequesterLabel(request),
    requesterName: recheckRequesterName(request),
    statusLabel: recheckStatusLabel(status),
    ...guidance,
  };
}
