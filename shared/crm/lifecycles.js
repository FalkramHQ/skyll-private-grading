// CRM lifecycle contracts (CRM-001). Transitions are data so the server can
// enforce them and the UI can decide which actions to offer from one source.
// Anything not listed here is an invalid transition.
// Human-readable contract: docs/CRM_CONTRACTS.md.

export class CrmTransitionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CrmTransitionError';
    this.code = code;
  }
}

function machine(states, transitions) {
  return Object.freeze({
    states: Object.freeze(states),
    transitions: Object.freeze(transitions.map((transition) => Object.freeze(transition))),
  });
}

// Pre-student journey is expressed through pipeline stage categories. Schools
// name their own stages; the system only understands the category.
export const LEAD_STAGE_CATEGORIES = Object.freeze(['open', 'applicant', 'won', 'lost']);

// Moving between two stages of the same category (e.g. "new inquiry" to
// "contacted") is always allowed. `won` is reachable only through conversion,
// never by moving a lead to a stage, so identity is never guessed.
export const LEAD_STAGE_MACHINE = machine(LEAD_STAGE_CATEGORIES, [
  { from: 'open', to: 'open' },
  { from: 'open', to: 'applicant' },
  { from: 'applicant', to: 'applicant' },
  { from: 'applicant', to: 'open' },
  { from: 'open', to: 'lost', requiresReason: true },
  { from: 'applicant', to: 'lost', requiresReason: true },
  { from: 'lost', to: 'open' },
  { from: 'open', to: 'won', via: 'convert' },
  { from: 'applicant', to: 'won', via: 'convert' },
]);

// `students.status`. "Enrolled" in the person lifecycle means `active`.
export const STUDENT_STATUSES = Object.freeze(['active', 'inactive', 'alumni', 'archived']);

export const STUDENT_STATUS_MACHINE = machine(STUDENT_STATUSES, [
  { from: 'active', to: 'inactive' },
  { from: 'inactive', to: 'active' },
  { from: 'active', to: 'alumni' },
  { from: 'inactive', to: 'alumni' },
  { from: 'alumni', to: 'active' },
  { from: 'active', to: 'archived' },
  { from: 'inactive', to: 'archived' },
  { from: 'alumni', to: 'archived' },
]);

// `student_enrollments.status`. Renewal is a new row for the next academic
// year, not a transition.
export const ENROLLMENT_MACHINE = machine(['active', 'withdrawn', 'completed'], [
  { from: 'active', to: 'withdrawn' },
  { from: 'active', to: 'completed' },
  { from: 'withdrawn', to: 'active' },
]);

// `batch_memberships.status`.
export const BATCH_MEMBERSHIP_MACHINE = machine(['active', 'inactive'], [
  { from: 'active', to: 'inactive' },
  { from: 'inactive', to: 'active' },
]);

// `held` is set by the first attendance save. Cancelling needs a reason; a
// cancel can be undone while the session is still in the future (checked by
// the handler). `rescheduled` is reserved for CRM-028 (FLKRM-327 D6).
export const CLASS_SESSION_MACHINE = machine(['scheduled', 'held', 'cancelled', 'rescheduled'], [
  { from: 'scheduled', to: 'held' },
  { from: 'scheduled', to: 'cancelled', requiresReason: true },
  { from: 'cancelled', to: 'scheduled' },
  { from: 'scheduled', to: 'rescheduled' },
]);

const ATTENDANCE_MARKS = ['present', 'absent', 'late', 'excused'];

// Changing a mark after it was first recorded is a correction and needs a
// reason (and an `attendance.corrected` audit event).
export const ATTENDANCE_MACHINE = machine(['unmarked', ...ATTENDANCE_MARKS], [
  ...ATTENDANCE_MARKS.map((to) => ({ from: 'unmarked', to })),
  ...ATTENDANCE_MARKS.flatMap((from) => ATTENDANCE_MARKS
    .filter((to) => to !== from)
    .map((to) => ({ from, to, requiresReason: true }))),
]);

// `overdue` is derived from due date and never stored.
export const INVOICE_MACHINE = machine(['draft', 'issued', 'partially_paid', 'paid', 'void'], [
  { from: 'draft', to: 'issued' },
  { from: 'issued', to: 'partially_paid' },
  { from: 'issued', to: 'paid' },
  { from: 'partially_paid', to: 'paid' },
  { from: 'draft', to: 'void', requiresReason: true },
  { from: 'issued', to: 'void', requiresReason: true },
]);

// A succeeded payment is final; reversals go through refunds.
export const PAYMENT_MACHINE = machine(['pending', 'succeeded', 'failed'], [
  { from: 'pending', to: 'succeeded' },
  { from: 'pending', to: 'failed' },
]);

export const REFUND_MACHINE = machine(['requested', 'approved', 'processed', 'rejected'], [
  { from: 'requested', to: 'approved' },
  { from: 'approved', to: 'processed' },
  { from: 'requested', to: 'rejected', requiresReason: true },
  { from: 'approved', to: 'rejected', requiresReason: true },
]);

export const MESSAGE_MACHINE = machine(['draft', 'queued', 'sent', 'delivered', 'read', 'failed'], [
  { from: 'draft', to: 'queued' },
  { from: 'queued', to: 'sent' },
  { from: 'sent', to: 'delivered' },
  { from: 'sent', to: 'read' },
  { from: 'delivered', to: 'read' },
  { from: 'queued', to: 'failed' },
  { from: 'sent', to: 'failed' },
]);

export const TASK_MACHINE = machine(['open', 'done', 'cancelled'], [
  { from: 'open', to: 'done' },
  { from: 'open', to: 'cancelled' },
  { from: 'done', to: 'open' },
  // A cancelled task can be restored (FLKRM-326 S2): cancel is one click, and
  // the append-only task events keep both the cancel and the reopen.
  { from: 'cancelled', to: 'open' },
]);

export const LIFECYCLES = Object.freeze({
  leadStage: LEAD_STAGE_MACHINE,
  studentStatus: STUDENT_STATUS_MACHINE,
  enrollment: ENROLLMENT_MACHINE,
  batchMembership: BATCH_MEMBERSHIP_MACHINE,
  classSession: CLASS_SESSION_MACHINE,
  attendance: ATTENDANCE_MACHINE,
  invoice: INVOICE_MACHINE,
  payment: PAYMENT_MACHINE,
  refund: REFUND_MACHINE,
  message: MESSAGE_MACHINE,
  task: TASK_MACHINE,
});

function resolveMachine(name) {
  const selected = LIFECYCLES[name];
  if (!selected) throw new Error(`Unknown CRM lifecycle: ${name}`);
  return selected;
}

export function findTransition(name, from, to) {
  return resolveMachine(name).transitions.find((transition) => transition.from === from && transition.to === to) || null;
}

/** Whether the move is listed, and reachable through `via` when it requires one. */
export function canTransition(name, from, to, { via } = {}) {
  const transition = findTransition(name, from, to);
  return Boolean(transition && (!transition.via || transition.via === via));
}

/**
 * Throws `CrmTransitionError` (`invalid_transition` or `reason_required`) when
 * the move is not allowed. Returns the matched transition otherwise.
 */
export function assertTransition(name, from, to, { via, reason } = {}) {
  const transition = findTransition(name, from, to);
  if (!transition || (transition.via && transition.via !== via)) {
    throw new CrmTransitionError('invalid_transition', `Cannot move ${name} from ${from} to ${to}.`);
  }
  if (transition.requiresReason && !String(reason || '').trim()) {
    throw new CrmTransitionError('reason_required', `A reason is required to move ${name} from ${from} to ${to}.`);
  }
  return transition;
}

/** Transitions offered from a state (for UI actions). */
export function nextStates(name, from, { via } = {}) {
  return resolveMachine(name).transitions
    .filter((transition) => transition.from === from && (!transition.via || transition.via === via))
    .map((transition) => transition.to);
}

/**
 * Person lifecycle is derived, never stored: a converted lead defers to the
 * canonical student record; otherwise the lead's stage category decides.
 */
export function derivePersonLifecycle({ stageCategory = null, studentStatus = null } = {}) {
  if (studentStatus) return studentStatus === 'active' ? 'enrolled' : studentStatus;
  if (stageCategory === 'lost') return 'lost';
  if (stageCategory === 'applicant') return 'applicant';
  if (stageCategory === 'open') return 'lead';
  return null;
}
