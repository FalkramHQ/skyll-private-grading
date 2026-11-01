import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { ArrowRight, Check, CheckCircle, ChevronDown, PanelLeftClose, AlertCircle, AlertTriangle, ChevronLeft, ChevronRight, RefreshCw, UserCheck, ThumbsUp, ArrowLeft, Edit3, Save, X, Lock, CheckCircle2, XCircle, MinusCircle, CircleDashed, Flag, Keyboard, Search, RotateCcw } from 'lucide-react';
import MathText from '../components/MathText';
import { initialReviewTarget, parseReviewLocation, reviewItemMatchesFilter, reviewLocation, COHORT_DATE_FILTERS, COHORT_STATUS_FILTERS, cohortFilterLocation, cohortMatchesFilters, cohortStatusLabels, cohortOverrideHasUnresolved, compareCohortsByExamDate, parseCohortFilters } from '../../shared/reviewWorkQueue';
import RubricReviewPanel from './RubricReviewPanel';
import { AnswerLocationChip, AnswerSheetPanel, findAnswerLocation, useAnswerLocations } from '../components/AnswerSheetPanel';
import { recheckReviewPresentation } from '../lib/recheckReviewPresentation';
import { restoreSession, signOut } from '../lib/session';
import WorklistSummaryBar from '../components/WorklistSummaryBar';
import { RosterSearch, StudentRosterCard, filterAndSortStudents } from '../components/StudentRoster';
import { SaveStateBanner, ContextualApproveButton, RevisionSummaryBadge } from '../components/ReviewPanelComponents';
import { MobileRosterDrawer, MobileActionBar } from '../components/ReviewMobileLayout';
import AiConfidenceBadge from '../components/AiConfidenceBadge';
import { Button } from '../components/ui/Button';
import { StatusBadge } from '../components/ui/StatusBadge';
import { keyCheckFinding, reviewFlagsFor } from '../../shared/reviewFlags.js';
import { cn } from '../lib/utils';

// AI grade outcome per question. The icon carries the meaning; colour confirms it.
const STATUS_COLORS = {
  correct: { label: 'text-success', badge: 'positive', icon: CheckCircle2, tile: 'bg-[#9ED9B4] text-ink border-ink' },
  incorrect: { label: 'text-destructive', badge: 'critical', icon: XCircle, tile: 'bg-[#F4A8B3] text-ink border-ink' },
  partial: { label: 'text-warning', badge: 'caution', icon: MinusCircle, tile: 'bg-[#F5D98A] text-ink border-ink' },
  not_attempted: { label: 'text-muted-foreground', badge: 'neutral', icon: CircleDashed, tile: 'bg-sunken text-muted-foreground border-hairline-strong border-dashed' },
};

const CONFIDENCE_BADGE = { high: 'positive', low: 'critical' };

// Shared quiet-surface class strings for the review workspace.
const CARD = 'rounded-2xl border border-border bg-card';
const SECTION_LABEL = 'mb-1 text-[13px] font-bold text-foreground-secondary';
const PILL = 'inline-flex h-8 shrink-0 items-center whitespace-nowrap gap-1.5 rounded-full border px-3 text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const PILL_ON = 'border-ink bg-ink text-lime';
const PILL_OFF = 'border-hairline bg-card text-foreground-secondary hover:border-hairline-strong hover:bg-paper-soft';
const SELECT = 'h-8 rounded-[10px] border border-input bg-card px-2.5 text-[13px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const FIELD = 'w-full rounded-[10px] border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const KBD = 'rounded-[5px] border-[1.5px] border-ink bg-card px-1.5 py-px font-sans text-xs font-bold text-foreground';
const CHIP = 'inline-flex items-center rounded-full bg-sunken px-2.5 py-1 text-xs font-semibold leading-none text-foreground-secondary tabular-nums';
// Lime highlighter behind the evidence the AI credited: functional, not decoration.
const EVIDENCE_HIGHLIGHT = 'rounded-[3px] bg-lime/60 px-0.5 text-foreground [box-decoration-break:clone]';

function getStatusStyle(grade) {
  if (!grade) return null;
  return STATUS_COLORS[grade.status] || STATUS_COLORS.incorrect;
}

function getQueueStats(items = []) {
  const pending = items.filter(i => i.reviewStatus === 'pending').length;
  const approved = items.filter(i => i.reviewStatus === 'approved').length;
  const flagged = items.filter(i => i.isFlagged || i.reviewPriority === 'flagged' || i.reviewTags?.includes('flagged')).length;
  const students = new Set(items.map(i => i.studentId)).size;
  const totalQuestions = items.length;
  const reviewPercent = totalQuestions > 0 ? Math.round((approved / totalQuestions) * 100) : 0;
  return { pending, approved, flagged, totalStudents: students, totalQuestions, reviewPercent };
}

export function formatRecheckRequestedAt(value) {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return 'Request time unavailable';
  return timestamp.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

export function RecheckRequestCard({ request, onTakeUp, onKeepOriginalGrade }) {
  const recheck = recheckReviewPresentation(request);
  return <div className="rounded-xl border border-warning/30 bg-warning-soft/40 px-3.5 py-3">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div>
        <p className="text-xs font-bold text-warning-soft-foreground">{recheck.requesterLabel}</p>
        <p className="mt-0.5 text-[13px] font-semibold text-foreground">{recheck.requesterName} <span className="font-normal text-foreground-secondary">{' \u00b7 '}{formatRecheckRequestedAt(request.requestedAt)}</span></p>
      </div>
      <StatusBadge status={request.status === 'awaiting_regrade' ? 'info' : 'caution'} icon={request.status === 'awaiting_regrade' ? RefreshCw : RotateCcw}>{recheck.statusLabel}</StatusBadge>
    </div>
    <div className="mt-2.5 border-t border-warning/20 pt-2.5">
      <p className="text-xs font-bold text-foreground-secondary">Reason</p>
      <p className="mt-1 text-[13px] leading-relaxed text-foreground">{request.reason}</p>
    </div>
    <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
      <div>
        <p className="text-[13px] font-semibold text-foreground">Next: {recheck.actionLabel}</p>
        <p className="mt-0.5 text-xs text-foreground-secondary">{recheck.actionDetail}</p>
      </div>
      {request.status === 'open' ? (
        <Button type="button" size="sm" variant="secondary" onClick={() => onTakeUp(request.id)}>Take up</Button>
      ) : request.status === 'in_review' ? (
        <Button type="button" size="sm" variant="secondary" onClick={() => onKeepOriginalGrade(request.id)}>Keep original grade</Button>
      ) : null}
    </div>
  </div>;
}

// Humanize a raw student ID into a readable label when no display_name exists.
// e.g. "partnerb_11th_name_kabir_mehta_chemistry" → "Kabir Mehta"
//      "sub_0c6b95c9db2597dabd35" → "Sub 0c6b95..."
function humanizeStudentId(id) {
  if (!id) return 'Unknown';
  // PartnerB legacy IDs embed the name: partnerb_<grade>_<name_parts>_<subject>
  const partnerbMatch = id.match(/^partnerb_\d+th_(.+?)_(chemistry|physics|maths?|biology|science)$/i);
  if (partnerbMatch) {
    const nameParts = partnerbMatch[1].replace(/^(name_|class_[ivx]+_)/, '').split('_');
    return nameParts.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }
  // Generic fallback: truncate hash IDs
  if (id.length > 12) return id.slice(0, 10) + '…';
  return id.replace(/_/g, ' ');
}

function reviewGrade(item) {
  return item.gradeLevel || String(item.studentId || '').match(/(?:^|_)(\d+th)(?:_|$)/i)?.[1] || '';
}

import { compareQuestionNumbers as compareQuestionNumberKeys } from '../../shared/questionNumberSort.js';
import Loader from '../components/Loader';

function compareQuestionNumbers(a, b) {
  return compareQuestionNumberKeys(a?.questionNumber, b?.questionNumber);
}

const COHORT_STATUS_LABELS = { all: 'All Cohorts', 'needs-review': 'Needs Review', 'regrade-pending': 'Pending Updates', completed: 'Review Complete' };
const COHORT_DATE_LABELS = { all: 'Any exam date', '7d': 'Last 7 days', '30d': 'Last 30 days', '90d': 'Last 90 days' };

// Modern assessments have one canonical test ID. Historic backfills pre-date
// that model and generated a synthetic ID per student, so their cohort identity
// must deliberately ignore that implementation detail.
export function reviewCohortKey(item) {
  const grade = reviewGrade(item);
  if (item.isCanonicalTest) return `test:${item.testId}`;
  return `legacy:${item.school}|${item.subject}|${grade}`;
}

// The summary endpoint intentionally returns one historical row per synthetic
// test ID. Legacy rows share a visible review cohort, so reduce them before
// rendering. Otherwise React receives duplicate keys and navigation state can
// be reused for the wrong card.
export function mergeReviewCohorts(cohorts = []) {
  const byKey = new Map();
  for (const cohort of cohorts) {
    const existing = byKey.get(cohort.id);
    if (!existing) {
      byKey.set(cohort.id, cohort);
      continue;
    }
    byKey.set(cohort.id, {
      ...existing,
      totalQuestions: existing.totalQuestions + cohort.totalQuestions,
      totalStudents: existing.totalStudents + cohort.totalStudents,
      pending: existing.pending + cohort.pending,
      approved: existing.approved + cohort.approved,
      flagged: existing.flagged + cohort.flagged,
      changedQuestions: existing.changedQuestions + cohort.changedQuestions,
      changedStudents: (existing.changedStudents || 0) + (cohort.changedStudents || 0),
      recheckCount: existing.recheckCount + cohort.recheckCount,
    });
  }
  return [...byKey.values()].map((cohort) => ({
    ...cohort,
    reviewPercent: cohort.totalQuestions > 0 ? Math.round((cohort.approved / cohort.totalQuestions) * 100) : 0,
  }));
}

// Visual rescue evidence can be a concise string or structured provenance from
// the grader. Keep the structured value in the queue, but always render a safe,
// readable summary in the reviewer UI.
export function formatEvidenceLocation(value) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(formatEvidenceLocation).filter(Boolean).join('; ');
  if (typeof value === 'object') {
    return Object.entries(value)
      .map(([key, item]) => `${key.replace(/_/g, ' ')}: ${formatEvidenceLocation(item)}`)
      .filter((entry) => !entry.endsWith(': '))
      .join('; ');
  }
  return String(value);
}

function StudentQuestionGrid({ student, questions, current, filter, onFilterChange, onSelect, onApproveAll, approvingAll = false }) {
  if (!student || !questions.length) return null;
  const visibleQuestions = filter === 'flagged'
    ? questions.filter((question) => question.isFlagged || question.reviewPriority === 'flagged' || question.reviewTags?.includes('flagged'))
    : questions;
  const approvedCount = questions.filter((question) => question.reviewStatus === 'approved').length;
  const pendingCount = questions.filter((question) => (question.reviewStatus || 'pending') === 'pending').length;

  return (
    <div className="border-b border-border p-3">
      <div className="mb-2.5 flex items-center gap-2">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-muted-foreground">Selected student</p>
          <p className="truncate text-sm font-bold text-foreground">{student.name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}</p>
        </div>
        <span className="ml-auto text-xs font-semibold text-foreground-secondary tabular-nums" title="Approved / total questions">{approvedCount}/{questions.length}</span>
      </div>

      {onApproveAll && (pendingCount > 0 ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onApproveAll}
          disabled={approvingAll}
          className="mb-2.5 w-full"
        >
          {approvingAll ? <Loader size="inline" /> : <ThumbsUp className="h-3.5 w-3.5" aria-hidden="true" />}
          {approvingAll ? 'Approving…' : `Approve all (${pendingCount} pending)`}
        </Button>
      ) : (
        <StatusBadge status="positive" className="mb-2.5 w-full justify-center py-1.5">
          All questions reviewed
        </StatusBadge>
      ))}

      {student.flaggedCount > 0 && (
        <div role="group" aria-label="Question filter" className="mb-2.5 grid grid-cols-2 gap-1.5">
          {['all', 'flagged'].map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              onClick={() => onFilterChange(value)}
              className={cn('h-8 rounded-[10px] border px-2 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', filter === value ? 'border-ink bg-ink text-white' : 'border-hairline bg-card text-foreground-secondary hover:bg-paper-soft')}
            >
              {value === 'all' ? 'All questions' : `Flagged (${student.flaggedCount})`}
            </button>
          ))}
        </div>
      )}

      {/* Compact tiles filled with the AI grade colour, as reviewers know them. */}
      <div className="grid grid-cols-8 gap-1">
        {visibleQuestions.map((question) => {
          const attempted = Boolean(question.studentAnswer?.attempted);
          const style = attempted ? getStatusStyle(question.grade) : STATUS_COLORS.not_attempted;
          const isCurrent = current?.id === question.id;
          const isReviewed = question.reviewStatus === 'approved';
          const isFlagged = question.isFlagged || question.reviewPriority === 'flagged' || question.reviewTags?.includes('flagged');
          const number = question.questionNumber?.replace(/^Q/i, '') || '?';
          const gradeLabel = attempted ? (question.grade?.status || 'unknown').replace(/_/g, ' ') : 'not attempted';
          return (
            <button
              key={question.id}
              type="button"
              onClick={() => onSelect(question.questionNumber)}
              aria-current={isCurrent ? 'true' : undefined}
              aria-label={`${question.questionNumber}, ${gradeLabel}, ${isReviewed ? 'approved' : 'to review'}${isFlagged ? ', flagged' : ''}`}
              className={cn(
                'relative flex h-[30px] items-center justify-center rounded-md border-[1.5px] text-[11px] font-bold leading-none tabular-nums transition-transform hover:-translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
                style?.tile || STATUS_COLORS.incorrect.tile,
                isCurrent && 'border-2 border-solid border-ink shadow-hard-sm',
              )}
              title={`${question.questionNumber} - ${question.grade?.status || 'unknown'} - ${question.grade?.marks ?? 0}/${question.grade?.allocated ?? question.marksAllocated}${isReviewed ? ' - approved' : ''}${isFlagged ? ' - flagged' : ''}`}
            >
              {number}
              {isReviewed && (
                <span className="absolute -right-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full border border-card bg-ink" aria-hidden="true">
                  <Check className="h-2.5 w-2.5 text-lime" strokeWidth={3.5} />
                </span>
              )}
              {isFlagged && (
                <span className="absolute -bottom-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full border border-ink bg-coral" aria-hidden="true">
                  <Flag className="h-2 w-2 text-ink" strokeWidth={3} />
                </span>
              )}
            </button>
          );
        })}
      </div>
      <p className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] leading-none text-muted-foreground">
        <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm border border-ink bg-[#9ED9B4]" aria-hidden="true" />Full</span>
        <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm border border-ink bg-[#F5D98A]" aria-hidden="true" />Partial</span>
        <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm border border-ink bg-[#F4A8B3]" aria-hidden="true" />Wrong</span>
        <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm border border-dashed border-hairline-strong bg-sunken" aria-hidden="true" />Blank</span>
        <span className="inline-flex items-center gap-1"><span className="flex h-3 w-3 items-center justify-center rounded-full bg-ink" aria-hidden="true"><Check className="h-2 w-2 text-lime" strokeWidth={3.5} /></span>Approved</span>
        <span className="inline-flex items-center gap-1"><span className="flex h-3 w-3 items-center justify-center rounded-full border border-ink bg-coral" aria-hidden="true"><Flag className="h-1.5 w-1.5 text-ink" strokeWidth={3} /></span>Flagged</span>
      </p>
    </div>
  );
}

// "Regrade changes" republishes reports and spends model calls. Show exactly
// what will be queued - from a live preview, not the possibly-stale card -
// before anything is inserted.
// Marks a reviewer may enter: blank (keep the AI mark) or a whole or half mark
// within the question's range. Returns the problem to show, or null.
export function reviewMarksError(value, item) {
  if (value === '' || !item) return null;
  const marks = Number(value);
  const maxMarks = Number(item.grade?.allocated ?? item.marksAllocated ?? 0);
  const minMarks = Number(item.marksMin ?? 0);
  return !Number.isFinite(marks) ? 'Enter a number'
    : marks > maxMarks ? `Can't be more than ${maxMarks}`
    : marks < minMarks ? `Can't be less than ${minMarks}`
    : Math.abs(marks * 2 - Math.round(marks * 2)) > 1e-9 ? 'Use whole or half marks'
    : null;
}

export function regradeCohortKey(cohort) {
  return cohort ? `${cohort.school}|${cohort.testId}|${cohort.subject}|${cohort.grade}` : '';
}

const REGRADE_DONE = ['published', 'partial', 'failed'];
// Poll quickly at first, then ease off; stop watching after 15 minutes.
export const REGRADE_POLL = { firstMs: 1200, maxMs: 5000, giveUpMs: 15 * 60 * 1000 };

/**
 * Follows a durable cohort regrade run until it finishes. The browser only
 * observes: OCI owns the job, so stopping here never cancels it.
 * Resolves { run, outcome: 'done' | 'stopped' | 'watch_expired' }.
 */
export async function watchCohortRegrade(run, { readRun, onProgress, isActive, sleep, now = Date.now, poll = REGRADE_POLL }) {
  const started = now();
  let delay = poll.firstMs;
  while (!REGRADE_DONE.includes(run.status)) {
    if (now() - started >= poll.giveUpMs) return { run, outcome: 'watch_expired' };
    await sleep(delay);
    if (!isActive()) return { run, outcome: 'stopped' };
    const next = await readRun(run.id);
    if (!isActive()) return { run, outcome: 'stopped' };
    run = next;
    onProgress(run);
    delay = Math.min(poll.maxMs, Math.round(delay * 1.5));
  }
  return { run, outcome: 'done' };
}

export function RegradeConfirmDialog({ cohort, preview, loading, error, onConfirm, onCancel, onRefresh }) {
  const empty = !loading && !error && preview && preview.totalQuestions === 0;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="regrade-confirm-title" className="w-full max-w-md rounded-[20px] border-2 border-ink bg-card p-5 shadow-hard-lg sm:p-6">
        <h3 id="regrade-confirm-title" className="font-headline text-xl font-bold tracking-tight text-foreground">Regrade changes</h3>
        <p className="mt-0.5 text-[13px] text-muted-foreground">{cohort.examName || `${cohort.grade} ${cohort.subject}`} · {cohort.school}</p>

        {loading && (
          <div className="flex items-center gap-2 py-6 text-sm text-foreground-secondary">
            <Loader size="inline" /> Loading changes…
          </div>
        )}
        {error && <p role="alert" className="py-4 text-sm font-semibold text-destructive">{error}</p>}
        {empty && (
          <p className="py-4 text-sm text-foreground-secondary">
            Nothing is waiting to be regraded - this card is out of date. Refresh the list to see current counts.
          </p>
        )}
        {!loading && !error && preview && preview.totalQuestions > 0 && (
          <>
            <p className="mt-3 text-sm font-semibold text-foreground tabular-nums">
              {preview.totalQuestions} questions across {preview.students.length} students will be regraded.
            </p>
            <ul className="mt-2 max-h-48 divide-y divide-border overflow-y-auto rounded-xl border border-border">
              {preview.students.map((student) => (
                <li key={student.studentId} className="flex items-center justify-between px-3 py-2 text-sm">
                  <span className="text-foreground">{student.studentName}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">{student.questionCount} question{student.questionCount === 1 ? '' : 's'}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[13px] text-muted-foreground">Affected student reports are republished automatically after the regrade completes.</p>
          </>
        )}

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
          {empty && (
            <Button type="button" variant="ink" onClick={onRefresh}>Refresh list</Button>
          )}
          {!loading && !error && preview && preview.totalQuestions > 0 && (
            <Button type="button" onClick={onConfirm}>Confirm regrade</Button>
          )}
        </div>
      </div>
    </div>
  );
}

// Marking a cohort done hides remaining work, so the confirmation must state
// exactly how much is being overridden. It is reversible, but a silent override
// is never acceptable.
export function MarkCohortCompleteDialog({ cohort, submitting, error, onConfirm, onCancel }) {
  const pending = cohort.pending || 0;
  const changed = cohort.changedQuestions || 0;
  const parts = [];
  if (pending > 0) parts.push(`${pending} question${pending === 1 ? '' : 's'} still awaiting review`);
  if (changed > 0) parts.push(`${changed} change${changed === 1 ? '' : 's'} awaiting regrade`);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="mark-complete-title" className="w-full max-w-md rounded-[20px] border-2 border-ink bg-card p-5 shadow-hard-lg sm:p-6">
        <h3 id="mark-complete-title" className="font-headline text-xl font-bold tracking-tight text-foreground">Mark cohort as done</h3>
        <p className="mt-0.5 text-[13px] text-muted-foreground">{cohort.examName || `${cohort.grade} ${cohort.subject}`} · {cohort.school}</p>

        <p className="mt-3 text-sm text-foreground">
          This moves the cohort to <span className="font-semibold">Review Complete</span>
          {parts.length ? <> while <span className="font-semibold">{parts.join(' and ')}</span>.</> : '.'}
        </p>
        {parts.length > 0 && (
          <p className="mt-3 rounded-xl border border-warning/30 bg-warning-soft px-3 py-2 text-[13px] text-warning-soft-foreground">
            Those items stay open but no longer count against this cohort. Reports are unaffected — publishing still requires every regrade item to complete.
          </p>
        )}
        {error && <p role="alert" className="mt-3 text-sm font-semibold text-destructive">{error}</p>}

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onCancel} disabled={submitting}>Cancel</Button>
          <Button type="button" variant="ink" onClick={onConfirm} disabled={submitting}>
            {submitting ? <Loader size="inline" /> : null} Mark as done
          </Button>
        </div>
      </div>
    </div>
  );
}

// Per-reviewer layout preferences survive reloads; storage can be unavailable.
function readPref(key, fallback) {
  try { return window.localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function writePref(key, value) {
  try { window.localStorage.setItem(key, value); } catch { /* preference only */ }
}

function useMediaQuery(query) {
  const get = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false);
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const list = window.matchMedia(query);
    const onChange = () => setMatches(list.matches);
    onChange();
    list.addEventListener?.('change', onChange);
    return () => list.removeEventListener?.('change', onChange);
  }, [query]);
  return matches;
}

const TILE_TONE = {
  correct: 'bg-[#9ED9B4] text-ink border-ink',
  partial: 'bg-[#F5D98A] text-ink border-ink',
  incorrect: 'bg-[#F4A8B3] text-ink border-ink',
  not_attempted: 'bg-sunken text-muted-foreground border-hairline-strong border-dashed',
};
function tileTone(item) {
  if (!item?.studentAnswer?.attempted) return TILE_TONE.not_attempted;
  return TILE_TONE[item?.grade?.status] || TILE_TONE.incorrect;
}
function displayName(name) {
  return String(name || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
function initials(name) {
  return displayName(name).split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('') || '?';
}

// A searchable dropdown for jumping to a student or a question.
function PickerMenu({ label, sublabel, options, onSelect, searchLabel }) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const rootRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => { if (!rootRef.current?.contains(event.target)) setOpen(false); };
    const onKey = (event) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', onKey); };
  }, [open]);
  const needle = term.trim().toLowerCase();
  const shown = needle ? options.filter((option) => `${option.label} ${option.search || ''}`.toLowerCase().includes(needle)) : options;
  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => { setOpen((value) => !value); setTerm(''); }}
        className="flex h-9 min-w-[9rem] max-w-[17rem] items-center gap-2 rounded-[10px] border-[1.5px] border-ink bg-card px-3 text-left text-[13px] font-semibold text-foreground transition-colors hover:bg-paper-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="truncate">{label}</span>
        {sublabel && <span className="shrink-0 font-semibold text-muted-foreground tabular-nums">{sublabel}</span>}
        <ChevronDown className="h-4 w-4 shrink-0 text-foreground-secondary" aria-hidden="true" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-40 mt-1.5 w-80 rounded-2xl border-2 border-ink bg-card p-2 shadow-hard-md">
          <div className="mb-1.5 flex items-center gap-2 rounded-[10px] border border-input px-2.5 focus-within:ring-2 focus-within:ring-ring">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <input autoFocus value={term} onChange={(event) => setTerm(event.target.value)} aria-label={searchLabel} placeholder={searchLabel} className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
          </div>
          <ul role="listbox" aria-label={searchLabel} className="max-h-80 overflow-y-auto">
            {shown.length === 0 && <li className="px-3 py-2 text-[13px] text-muted-foreground">No matches</li>}
            {shown.map((option) => (
              <li key={option.key} role="option" aria-selected={Boolean(option.selected)}>
                <button
                  type="button"
                  onClick={() => { onSelect(option.key); setOpen(false); }}
                  className={cn('flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] transition-colors hover:bg-paper-soft', option.selected && 'bg-sunken')}
                >
                  <span className="min-w-0 flex-1 truncate font-semibold text-foreground">{option.label}</span>
                  {option.meta && <span className="shrink-0 text-xs font-semibold text-muted-foreground tabular-nums">{option.meta}</span>}
                  {option.done && <CheckCircle2 className="h-4 w-4 shrink-0 text-success" aria-label="All reviewed" />}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// By-question mode: every question in the paper with its review progress.
function QuestionProgressGrid({ questions, selected, onSelect }) {
  return (
    <div className="grid grid-cols-6 gap-1.5">
      {questions.map((question) => {
        const done = question.pending === 0;
        const isSelected = question.number === selected;
        return (
          <button
            key={question.number}
            type="button"
            onClick={() => onSelect(question.number)}
            aria-current={isSelected ? 'true' : undefined}
            aria-label={`${question.number}, ${question.approved} of ${question.total} approved${question.flagged ? `, ${question.flagged} flagged` : ''}`}
            title={`${question.number} · ${question.approved}/${question.total} approved`}
            className={cn(
              'relative flex h-10 flex-col items-center justify-center rounded-md border-[1.5px] text-[11px] font-bold leading-none tabular-nums transition-transform hover:-translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              done ? 'border-ink bg-[#9ED9B4] text-ink' : 'border-hairline bg-card text-foreground',
              isSelected && 'border-2 border-ink shadow-hard-sm',
            )}
          >
            <span>{String(question.number).replace(/^Q/i, '')}</span>
            <span className={cn('mt-0.5 text-[10px] font-semibold', done ? 'text-ink' : 'text-muted-foreground')}>{question.approved}/{question.total}</span>
            {question.flagged > 0 && (
              <span className="absolute -bottom-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full border border-ink bg-coral" aria-hidden="true">
                <Flag className="h-2 w-2 text-ink" strokeWidth={3} />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// By-question mode: each student's answer to the selected question.
function QuestionAnswerList({ items, currentId, onSelect }) {
  return (
    <ul className="space-y-1">
      {items.map((item) => {
        const isCurrent = item.id === currentId;
        const approved = item.reviewStatus === 'approved';
        return (
          <li key={item.id}>
            <button
              type="button"
              onClick={() => onSelect(item.id)}
              aria-current={isCurrent ? 'true' : undefined}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                isCurrent ? 'border-2 border-ink bg-card' : 'border-hairline bg-card hover:border-hairline-strong hover:bg-paper-soft',
              )}
            >
              <span className={cn('flex h-7 w-10 shrink-0 items-center justify-center rounded-md border-[1.5px] text-[11px] font-bold tabular-nums', tileTone(item))}>
                {item.overrideMarks ?? item.grade?.marks ?? 0}/{item.grade?.allocated ?? item.marksAllocated ?? 0}
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">{displayName(item.studentName)}</span>
              {approved
                ? <CheckCircle2 className="h-4 w-4 shrink-0 text-success" aria-label="Approved" />
                : <CircleDashed className="h-4 w-4 shrink-0 text-muted-foreground" aria-label="To review" />}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export default function VlReviewDashboard() {
  const initialReviewParams = useMemo(() => parseReviewLocation(window.location.search), []);
  const reviewMode = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('mode') === 'rubric' ? 'rubric' : 'questions';
  }, []);
  const rubricTestId = useMemo(() => new URLSearchParams(window.location.search).get('testId') || '', []);
  const [cohorts, setCohorts] = useState(null);
  const [selectedCohort, setSelectedCohort] = useState(null);
  const [queue, setQueue] = useState(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [queueRefreshing, setQueueRefreshing] = useState(false);
  const [overrideMarks, setOverrideMarks] = useState('');
  const [reviewer, setReviewer] = useState(() => localStorage.getItem('username') || 'admin');
  const [reviewerRole, setReviewerRole] = useState(null);
  const [approvingAll, setApprovingAll] = useState(false);
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState(() => initialReviewParams.filter);
  const [search, setSearch] = useState(() => initialReviewParams.search);
  const [questionNavFilter, setQuestionNavFilter] = useState('all');
  const [selectedStudent, setSelectedStudent] = useState(null);
  const [editingAnswer, setEditingAnswer] = useState(false);
  const [answerDraft, setAnswerDraft] = useState({ attempted: true, studentWrote: '', optionLetter: '', confidence: 'high' });
  const [savingAnswer, setSavingAnswer] = useState(false);
  const [recheckRequests, setRecheckRequests] = useState([]);
  const [cohortRegrading, setCohortRegrading] = useState(null);
  const [regradeConfirm, setRegradeConfirm] = useState(null); // { cohort, preview, loading, error }
  const [markCompleteConfirm, setMarkCompleteConfirm] = useState(null); // { cohort, submitting, error }
  const [releaseConfirm, setReleaseConfirm] = useState(null); // { cohortId, submitting, error }
  const [activeRegradeRun, setActiveRegradeRun] = useState(null);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [features, setFeatures] = useState({ review_scale_v2: false, review_focus_layout: false });
  // Reviewer focus layout (flagged per school): laptops and up; tablets and phones keep the classic flow.
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const isWide = useMediaQuery('(min-width: 1180px)');
  const focusActive = Boolean(features.review_focus_layout && isDesktop);
  const [reviewBy, setReviewBy] = useState(() => (initialReviewParams.student ? 'student' : readPref('skyll.review.by', 'student')));
  const [selectedQuestion, setSelectedQuestion] = useState(null);
  // null = follow the screen size (open when wide); true/false = the reviewer's own choice.
  const [rosterPref, setRosterPref] = useState(() => { const v = readPref('skyll.review.rosterCollapsed', ''); return v === '' ? null : v === '1'; });
  const [rosterOverlayOpen, setRosterOverlayOpen] = useState(false);
  const [rosterTipSeen, setRosterTipSeen] = useState(() => readPref('skyll.review.rosterTipSeen', '') === '1');
  const [focusMode, setFocusMode] = useState(false);
  const pendingFocusIdRef = useRef(null);
  const [cohortFilters, setCohortFilters] = useState(() => parseCohortFilters(window.location.search));
  const [rosterSearchTerm, setRosterSearchTerm] = useState('');
  const [rosterSortMode, setRosterSortMode] = useState('risk');
  const [mobileRosterOpen, setMobileRosterOpen] = useState(false);
  const scrollRef = useRef(null);
  const appliedDeepLinkCohortRef = useRef(null);
  const fetchQueueSeqRef = useRef(0);
  const queuePresentRef = useRef(false);
  const submittingRef = useRef(false);
  const mountedRef = useRef(true);
  // A cohort regrade runs for minutes; read the cohort on screen at the end,
  // not the one captured when it started.
  const selectedCohortRef = useRef(null);
  const fetchQueueRef = useRef(null);

  const redirectToReviewLogin = useCallback(() => {
    const next = `${window.location.pathname}${window.location.search}`;
    window.location.assign(`/review-login?from=${encodeURIComponent(next)}`);
  }, []);

  const fetchCohorts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const queueRes = await fetch('/api/vl-queue?summary=true');
      if (queueRes.status === 401) { redirectToReviewLogin(); return; }
      if (!queueRes.ok) throw new Error(await queueRes.text());
      const data = await queueRes.json();
      try {
        const featureRes = await fetch('/api/auth/features');
        if (featureRes.ok) setFeatures((await featureRes.json()).features || {});
      } catch { /* review remains available when rollout metadata is unavailable */ }
      const userSchool = localStorage.getItem('userSchool') || '';
      const userRole = localStorage.getItem('userRole') || '';
      let openRechecks = [];
      // Platform admins must scope recheck reads to a school. There is no
      // useful global overlay before a cohort is selected, and requesting one
      // produced a noisy 400 on every review-page load.
      try {
        if (!userSchool && userRole === 'skyll_admin') throw new Error('Cohort scope required');
        const recheckRes = await fetch('/api/rechecks?status=active');
        if (recheckRes.ok) openRechecks = (await recheckRes.json()).requests || [];
      } catch { /* rechecks are an optional review overlay */ }
      setRecheckRequests(openRechecks);
      const statuses = data.cohortStatuses || {};
      const isSkyllAdmin = userRole === 'skyll_admin';
      const cohortList = (data.cohorts || []).filter((cohort) => (
        isSkyllAdmin || !userSchool || cohort.school === userSchool
      )).map((cohort) => {
        const grade = cohort.gradeLevel || '';
        const key = reviewCohortKey({ ...cohort, gradeLevel: grade });
        const statusKey = `${cohort.school}|${cohort.subject}|${grade}`;
        const cohortStatus = statuses[statusKey] || { status: 'in_review' };
        const recheckCount = openRechecks.filter((request) =>
          request.school === cohort.school && request.subject === cohort.subject &&
          (request.review_student_id || '').startsWith(`${grade}_`) &&
          ['open', 'in_review', 'awaiting_regrade'].includes(request.status)
        ).length;
        return {
          ...cohort,
          id: key,
          grade,
          cohortStatus,
          recheckCount,
          reviewPercent: cohort.totalQuestions > 0 ? Math.round((cohort.approved / cohort.totalQuestions) * 100) : 0,
        };
      });
      setCohorts(mergeReviewCohorts(cohortList));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [redirectToReviewLogin]);

  const fetchQueue = useCallback(async () => {
    if (!selectedCohort) return;
    const seq = ++fetchQueueSeqRef.current;
    setActionError(null);
    if (queuePresentRef.current) setQueueRefreshing(true);
    else setLoading(true);
    try {
      const params = new URLSearchParams({ school: selectedCohort.school, subject: selectedCohort.subject });
      if (selectedCohort.isCanonicalTest && selectedCohort.testId) params.set('testId', selectedCohort.testId);
      const res = await fetch(`/api/vl-queue?${params.toString()}`);
      if (res.status === 401) { redirectToReviewLogin(); return; }
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      try {
        const recheckRes = await fetch(`/api/rechecks?school=${encodeURIComponent(selectedCohort.school)}&status=active`);
        if (recheckRes.ok) setRecheckRequests((await recheckRes.json()).requests || []);
      } catch { /* review can continue if the recheck overlay is unavailable */ }
      if (seq !== fetchQueueSeqRef.current) return;
      const items = (data.items || []).filter((item) => reviewCohortKey(item) === selectedCohort.id);
      const filtered = {
        ...data,
        ...getQueueStats(items),
        items,
      };
      queuePresentRef.current = true;
      setQueue(filtered);
      setError(null);
    } catch (err) {
      if (seq !== fetchQueueSeqRef.current) return;
      if (queuePresentRef.current) setActionError(err.message);
      else setError(err.message);
    } finally {
      if (seq === fetchQueueSeqRef.current) {
        setLoading(false);
        setQueueRefreshing(false);
      }
    }
  }, [selectedCohort, redirectToReviewLogin]);

  useEffect(() => {
    selectedCohortRef.current = selectedCohort;
    fetchQueueRef.current = fetchQueue;
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    restoreSession().then((user) => {
      if (user?.username) setReviewer(user.username);
      setReviewerRole(user?.role || null);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (reviewMode === 'rubric') {
      setLoading(false);
      return;
    }
    if (selectedCohort) fetchQueue();
    else fetchCohorts();
  }, [selectedCohort, fetchQueue, fetchCohorts, reviewMode]);

  useEffect(() => {
    if (reviewMode === 'rubric' || selectedCohort || !cohorts?.length) return;
    const requested = initialReviewParams.cohort;
    if (requested) {
      const cohort = cohorts.find((item) => item.id === requested);
      if (cohort) setSelectedCohort(cohort);
    }
  }, [cohorts, selectedCohort, initialReviewParams, reviewMode]);

  const studentMap = useMemo(() => {
    const map = new Map();
    for (const item of queue?.items || []) {
      if (!map.has(item.studentId)) map.set(item.studentId, []);
      map.get(item.studentId).push(item);
    }
    return map;
  }, [queue]);

  const students = useMemo(() => {
    return Array.from(studentMap.keys()).map(sid => {
      const items = studentMap.get(sid);
      const pending = items.filter(i => i.reviewStatus === 'pending').length;
      const approved = items.filter(i => i.reviewStatus === 'approved').length;
      const flaggedCount = items.filter(i => i.isFlagged || i.reviewPriority === 'flagged' || i.reviewPriority === 'urgent' || i.reviewTags?.includes('flagged')).length;
      const urgentCount = items.filter(i => i.reviewPriority === 'urgent' && i.reviewStatus !== 'approved').length;
      // The submission projection has already applied the assessment's
      // optional-question scoring plan. Raw per-question marks can exceed the
      // declared paper total, so they are not valid for the roster summary.
      const publishedScore = items[0]?.submissionScore;
      const publishedTotal = items[0]?.submissionMaxMarks;
      const marks = publishedScore == null
        ? items.reduce((sum, item) => sum + Number(item.overrideMarks ?? item.grade?.marks ?? 0), 0)
        : publishedScore;
      const total = publishedTotal == null
        ? items.reduce((sum, item) => sum + Number(item.grade?.allocated ?? item.marksAllocated ?? 0), 0)
        : publishedTotal;
      return { studentId: sid, name: items[0]?.studentName || humanizeStudentId(sid), studentUsername: items[0]?.studentUsername || '', items, pending, approved, flaggedCount, urgentCount, marks, total };
    });
  }, [studentMap]);

  const byQuestion = focusActive && reviewBy === 'question';
  // By question, Prev/Next follows the same student order as the visible list.
  const rosterRank = useMemo(() => new Map(filterAndSortStudents(students, '', rosterSortMode).map((student, index) => [student.studentId, index])), [students, rosterSortMode]);

  const filteredItems = useMemo(() => {
    let items = queue?.items || [];
    if (byQuestion) {
      if (selectedQuestion) items = items.filter((i) => i.questionNumber === selectedQuestion);
    } else if (selectedStudent) items = items.filter(i => i.studentId === selectedStudent);
    items = items.filter((item) => reviewItemMatchesFilter(item, filter, recheckRequests));
    if (search.trim()) {
      const needle = search.trim().toLowerCase();
      items = items.filter((item) => [item.studentName, item.studentId, item.studentUsername, item.questionNumber, item.questionText, item.topic].some((value) => String(value || '').toLowerCase().includes(needle)));
    }
    // Sort questions in natural numeric order within each student while
    // preserving the roster's student grouping (Prev/Next matches the grid).
    const studentOrder = new Map();
    for (const item of items) if (!studentOrder.has(item.studentId)) studentOrder.set(item.studentId, studentOrder.size);
    // By question, Prev/Next walks the students for one question instead.
    return items.sort((a, b) => {
      const sa = studentOrder.get(a.studentId);
      const sb = studentOrder.get(b.studentId);
      if (byQuestion) return compareQuestionNumbers(a, b) || (rosterRank.get(a.studentId) ?? sa) - (rosterRank.get(b.studentId) ?? sb);
      if (sa !== sb) return sa - sb;
      return compareQuestionNumbers(a, b);
    });
  }, [queue, filter, selectedStudent, selectedQuestion, byQuestion, rosterRank, recheckRequests, search]);

  // Land on a specific item once the list it belongs to has been rebuilt
  // (switching review mode, picking an answer that the filter had hidden).
  useEffect(() => {
    const id = pendingFocusIdRef.current;
    if (!id) return;
    const index = filteredItems.findIndex((item) => item.id === id);
    if (index >= 0) { pendingFocusIdRef.current = null; setCurrentIndex(index); }
  }, [filteredItems]);

  const current = filteredItems[currentIndex];
  const answerLocations = useAnswerLocations(current?.testId, current?.testStudentId || current?.studentId);
  const currentLocation = findAnswerLocation(answerLocations, current);

  // Filters and cohort switches can remove the item currently shown. Keep the
  // index in range so Prev/Next never becomes a no-op against stale state.
  useEffect(() => {
    setCurrentIndex((index) => Math.max(0, Math.min(index, Math.max(0, filteredItems.length - 1))));
  }, [filteredItems.length, selectedCohort?.id, selectedStudent, selectedQuestion, filter, search]);

  // A review link is a durable work location: cohort, student, question and
  // work-queue filter survive a refresh or a hand-off to another reviewer.
  useEffect(() => {
    const query = selectedCohort
      ? reviewLocation({ cohort: selectedCohort?.id, student: selectedStudent, question: current?.questionNumber, filter, search })
      : cohortFilterLocation(cohortFilters);
    const next = `${window.location.pathname}${query ? `?${query}` : ''}`;
    window.history.replaceState(null, '', next);
  }, [selectedCohort, selectedStudent, current?.questionNumber, filter, search, cohortFilters]);

  useEffect(() => {
    if (!queue?.items?.length || !selectedCohort?.id) return;
    if (appliedDeepLinkCohortRef.current === selectedCohort.id) return;

    const target = initialReviewTarget(queue.items, initialReviewParams, filter, recheckRequests, search);
    if (target.studentId) setSelectedStudent(target.studentId);
    setCurrentIndex(target.index);
    appliedDeepLinkCohortRef.current = selectedCohort.id;
  }, [queue, selectedCohort?.id, initialReviewParams, filter, recheckRequests, search]);
  const hasVisualReading = Boolean(String(current?.visualReview?.visualAnswer || '').trim());
  const hasManualAnswerEdit = Boolean(current?.editedAt);
  const usableVisualAnswer = Boolean(current?.visualReview?.usable && hasVisualReading);
  const visibleStudentAnswer = hasManualAnswerEdit
    ? current?.studentAnswer?.studentWrote || ''
    : hasVisualReading ? current.visualReview.visualAnswer : current?.studentAnswer?.studentWrote || '';
  const visualAnswerReplacesPlaceholder = !hasManualAnswerEdit && hasVisualReading && /(?:\[?image placeholders?\]?|\[img-[^\]]+\])/i.test(
    `${current?.studentAnswer?.studentWrote || ''}`
  );
  const rawAnswerIsPlaceholder = /(?:\[?image placeholders?\]?|\[img-[^\]]+\])/i.test(
    `${current?.studentAnswer?.studentWrote || ''}`
  );

  const currentRechecks = useMemo(() => {
    if (!current) return [];
    const question = String(current.questionNumber || '').replace(/^Q/i, '');
    return recheckRequests.filter((request) =>
      ['open', 'in_review', 'awaiting_regrade'].includes(request.status) &&
      request.school === current.school &&
      request.subject === current.subject &&
      request.review_student_id === current.studentId &&
      String(request.question_number || '').replace(/^Q/i, '') === question
    );
  }, [current, recheckRequests]);
  const currentFlags = useMemo(() => (current ? reviewFlagsFor(current) : []), [current]);
  const currentKeyCheck = useMemo(() => keyCheckFinding(current?.keyCheck), [current]);

  // Questions for the currently selected student (for question nav panel)
  const studentQuestions = useMemo(() => {
    if (!selectedStudent) return [];
    const items = studentMap.get(selectedStudent) || [];
    return [...items].sort(compareQuestionNumbers);
  }, [selectedStudent, studentMap]);

  // Reset when the reviewer moves to another answer, not when a refetch hands
  // back a new object for the same one (that would wipe a typed mark).
  const currentId = current?.id;
  const currentSavedMarks = current?.overrideMarks;
  useEffect(() => {
    if (!currentId) return;
    setOverrideMarks(currentSavedMarks !== null && currentSavedMarks !== undefined ? String(currentSavedMarks) : '');
    setEditingAnswer(false);
  }, [currentId]); // eslint-disable-line react-hooks/exhaustive-deps

  // A corrected mark that has not been saved yet. Moving away must not drop it silently.
  const overrideDirty = Boolean(current && overrideMarks !== '' && Number(overrideMarks) !== Number(current.overrideMarks ?? Number.NaN));
  const leaveCurrent = useCallback((go) => {
    if (overrideDirty && !window.confirm('Discard the corrected marks you entered for this question?')) return;
    go();
  }, [overrideDirty]);

  // By question: every question in the paper with its review progress.
  const questionSummaries = useMemo(() => {
    const byNumber = new Map();
    for (const item of queue?.items || []) {
      const key = item.questionNumber;
      if (!byNumber.has(key)) byNumber.set(key, { number: key, sample: item, total: 0, approved: 0, pending: 0, flagged: 0 });
      const row = byNumber.get(key);
      row.total += 1;
      if (item.reviewStatus === 'approved') row.approved += 1;
      if ((item.reviewStatus || 'pending') === 'pending') row.pending += 1;
      if (item.isFlagged || item.reviewPriority === 'flagged' || item.reviewTags?.includes('flagged')) row.flagged += 1;
    }
    return [...byNumber.values()].sort((a, b) => compareQuestionNumbers(a.sample, b.sample));
  }, [queue]);

  useEffect(() => {
    if (!byQuestion || selectedQuestion || !questionSummaries.length) return;
    const first = questionSummaries.find((question) => question.pending > 0) || questionSummaries[0];
    setSelectedQuestion(first.number);
    setCurrentIndex(0);
  }, [byQuestion, selectedQuestion, questionSummaries]);

  // The roster is open by default on wide screens and stays however the reviewer last left it.
  const rosterCollapsed = rosterPref ?? !isWide;

  // Scroll to top when changing question
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTo({ top: 0, behavior: 'smooth' });
  }, [currentIndex]);

  const updateItemInState = useCallback((itemId, updates) => {
    setQueue(prev => {
      if (!prev) return prev;
      const items = prev.items.map(i => i.id === itemId ? { ...i, ...updates } : i);
      const pending = items.filter(i => i.reviewStatus === 'pending').length;
      const approved = items.filter(i => i.reviewStatus === 'approved').length;
      return { ...prev, items, pending, approved };
    });
  }, []);

  const goPrev = useCallback(() => setCurrentIndex(i => Math.max(0, i - 1)), []);
  const goNext = useCallback(
    () => setCurrentIndex(i => Math.min(filteredItems.length - 1, i + 1)),
    [filteredItems.length]
  );

  // Only an explicit "approve and next" moves on, and only after the save lands.
  const handleSubmit = useCallback(async (status, { advance = false } = {}) => {
    // Held keys and double clicks land before `saving` re-renders; one save at a time.
    if (!current || submittingRef.current) return;
    submittingRef.current = true;
    setSaving(true);
    try {
      const body = { reviewer: reviewer || 'admin', status: status || 'reviewed' };
      if (overrideMarks !== '') body.overrideMarks = Number(overrideMarks);
      const res = await fetch(`/api/vl-review/${encodeURIComponent(current.id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await res.text());
      updateItemInState(current.id, {
        reviewStatus: status || 'reviewed',
        reviewedBy: reviewer || 'admin',
        reviewedAt: new Date().toISOString(),
        overrideMarks: overrideMarks !== '' ? Number(overrideMarks) : null,
      });
      if (advance) {
        // On the pending filter the approved item drops out of the list, so the
        // same index already shows the next one; elsewhere step forward once.
        if (filter === 'pending') setCurrentIndex(i => Math.max(0, Math.min(i, filteredItems.length - 2)));
        else goNext();
      }
    } catch (err) {
      setActionError(err.message);
    } finally {
      submittingRef.current = false;
      setSaving(false);
    }
  }, [current, filter, filteredItems.length, goNext, overrideMarks, reviewer, updateItemInState]);

  const openRegradeConfirm = async (cohort) => {
    setRegradeConfirm({ cohort, preview: null, loading: true, error: null });
    try {
      const res = await fetch('/api/vl-queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'preview-cohort-regrade', school: cohort.school, testId: cohort.testId, subject: cohort.subject, grade: cohort.grade }),
      });
      const preview = await res.json();
      if (!res.ok) throw new Error(preview.error || 'Could not preview the regrade');
      setRegradeConfirm({ cohort, preview, loading: false, error: null });
    } catch (err) {
      setRegradeConfirm({ cohort, preview: null, loading: false, error: err.message });
    }
  };

  const runCohortRegrade = async (cohort) => {
    const cohortKey = regradeCohortKey(cohort);
    setCohortRegrading(cohortKey);
    setActionError(null);
    try {
      const created = await fetch('/api/vl-queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'start-cohort-regrade',
          school: cohort.school,
          testId: cohort.testId,
          subject: cohort.subject,
          grade: cohort.grade,
          language: /hindi/i.test(cohort.subject || '') ? 'hindi' : undefined,
        }),
      });
      const start = await created.json();
      if (!created.ok && !(created.status === 409 && start.runId)) throw new Error(start.error || 'Could not start cohort regrade');
      // A duplicate click attaches to the durable run already owned by OCI.
      // It never queues duplicate model work for the same reviewed revision.
      const queued = {
        id: start.runId,
        status: start.status || 'queued',
        questionCount: start.questionCount || 0,
        studentCount: start.studentCount || 0,
        progress: { queued: start.questionCount || 0 },
      };
      if (!mountedRef.current) return;
      setActiveRegradeRun(queued);
      const { run, outcome } = await watchCohortRegrade(queued, {
        readRun: async (runId) => {
          const step = await fetch('/api/vl-queue', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'get-cohort-regrade', runId }),
          });
          const result = await step.json();
          if (!step.ok) throw new Error(result.error || 'Could not read cohort regrade progress');
          // The API returns the run directly. Keeping that contract explicit
          // prevents the UI from losing a valid OCI job after its first poll.
          return result;
        },
        onProgress: setActiveRegradeRun,
        isActive: () => mountedRef.current,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      });
      if (outcome === 'stopped') return;
      if (outcome === 'watch_expired') { setActiveRegradeRun({ ...run, watchExpired: true }); return; }
      if (run.status === 'failed') throw new Error('Cohort regrade failed');
      await fetchCohorts();
      // The reviewer may have opened another cohort while this ran. Only reload
      // the queue on screen, and only if it is the one that was regraded.
      if (mountedRef.current && regradeCohortKey(selectedCohortRef.current) === cohortKey) await fetchQueueRef.current?.();
    } catch (err) {
      if (mountedRef.current) setActionError(err.message);
    } finally {
      if (mountedRef.current) setCohortRegrading(null);
    }
  };

  // "Approve all" (FLKRM-96): one request approves every pending question for
  // the selected student in this assessment. Admins only; needs a canonical
  // test id so the server can scope it to this assessment.
  const canApproveAll = ['admin', 'skyll_admin'].includes(reviewerRole) && Boolean(selectedCohort?.isCanonicalTest && selectedCohort?.testId);
  const approveAllForStudent = async () => {
    if (!selectedStudent || !selectedCohort?.testId || approvingAll) return;
    setApprovingAll(true);
    setActionError(null);
    try {
      const res = await fetch('/api/vl-queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve-cohort', studentId: selectedStudent, testId: selectedCohort.testId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Could not approve this student\'s questions');
      await fetchQueue();
    } catch (err) {
      setActionError(err.message);
    } finally {
      setApprovingAll(false);
    }
  };

  const markCohortComplete = async (cohort) => {
    setMarkCompleteConfirm({ cohort, submitting: true, error: null });
    try {
      const res = await fetch('/api/vl-queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'mark-cohort-complete',
          school: cohort.school,
          testId: cohort.testId,
          subject: cohort.subject,
          grade: cohort.grade,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Could not mark the cohort as done');
      setMarkCompleteConfirm(null);
      await fetchCohorts();
    } catch (err) {
      setMarkCompleteConfirm({ cohort, submitting: false, error: err.message });
    }
  };

  // Students and parents see a test only after it is released (no undo).
  const releaseToStudents = async (cohort) => {
    setReleaseConfirm({ cohortId: cohort.id, submitting: true, error: null });
    try {
      const res = await fetch('/api/vl-queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'release-to-students', school: cohort.school, testId: cohort.testId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Could not release the test to students');
      setReleaseConfirm(null);
      await fetchCohorts();
    } catch (err) {
      setReleaseConfirm({ cohortId: cohort.id, submitting: false, error: err.message });
    }
  };

  const unmarkCohortComplete = async (cohort) => {
    setActionError(null);
    try {
      const res = await fetch('/api/vl-queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'unmark-cohort-complete', school: cohort.school, testId: cohort.testId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Could not undo the completion');
      }
      await fetchCohorts();
    } catch (err) {
      setActionError(err.message);
    }
  };

  const retryFailedRegrade = async () => {
    if (!activeRegradeRun?.id) return;
    setCohortRegrading(regradeCohortKey(selectedCohort));
    setActionError(null);
    try {
      const response = await fetch('/api/vl-queue', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'retry-cohort-regrade', runId: activeRegradeRun.id }),
      });
      const run = await response.json();
      if (!response.ok) throw new Error(run.error || 'Could not retry failed questions');
      setActiveRegradeRun(run);
      // Attach to the same durable OCI run; the browser only observes progress.
      await runCohortRegrade(selectedCohort);
    } catch (err) {
      setActionError(err.message);
    } finally {
      setCohortRegrading(null);
    }
  };

  const handleSaveAnswer = async () => {
    if (!current) return;
    setSavingAnswer(true);
    try {
      const res = await fetch('/api/vl-queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'edit-answer',
          itemId: current.id,
          studentAnswer: {
            attempted: answerDraft.attempted,
            studentWrote: answerDraft.studentWrote,
            optionLetter: answerDraft.optionLetter || null,
            finalAnswer: null,
            confidence: answerDraft.confidence,
          },
          reviewer: reviewer || 'admin',
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      updateItemInState(current.id, {
        studentAnswer: data.studentAnswer,
        editedBy: data.editedBy,
        editedAt: data.editedAt,
        needsRegrade: true,
        reviewRevision: data.reviewRevision ?? (current.reviewRevision || 0) + 1,
      });
      setEditingAnswer(false);
    } catch (err) {
      setActionError(err.message);
    } finally {
      setSavingAnswer(false);
    }
  };

  const updateRecheckStatus = async (requestId, status, resolutionNote = '') => {
    try {
      const res = await fetch(`/api/rechecks/${encodeURIComponent(requestId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, reviewer: reviewer || 'admin', resolutionNote }),
      });
      if (!res.ok) throw new Error(await res.text());
      const body = await res.json();
      setRecheckRequests((requests) => requests.map((request) =>
        request.id === requestId ? { ...request, ...(body.request || {}), status } : request
      ));
    } catch (err) {
      setActionError(err.message);
    }
  };

  const startEditAnswer = () => {
    const sa = current?.studentAnswer || {};
    setAnswerDraft({
      attempted: sa.attempted ?? true,
      studentWrote: sa.studentWrote || '',
      optionLetter: sa.optionLetter || '',
      confidence: sa.confidence || 'high',
    });
    setEditingAnswer(true);
  };

  const toggleRoster = useCallback(() => {
    if (isWide) {
      const next = !rosterCollapsed;
      setRosterPref(next);
      writePref('skyll.review.rosterCollapsed', next ? '1' : '0');
    } else {
      setRosterOverlayOpen((open) => !open);
    }
  }, [isWide, rosterCollapsed]);

  // Keyboard shortcuts are disabled while the reviewer is editing an answer.
  useEffect(() => {
    const handler = (e) => {
      if (editingAnswer || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); leaveCurrent(goPrev); }
      if (e.key === 'ArrowRight') { e.preventDefault(); leaveCurrent(goNext); }
      if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        if (!reviewMarksError(overrideMarks, current)) handleSubmit('approved', { advance: true });
      }
      if (!focusActive || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '[') { e.preventDefault(); toggleRoster(); }
      if (e.key === 'f' || e.key === 'F') { e.preventDefault(); setFocusMode((on) => !on); }
      if (e.key === 'Escape') { setFocusMode(false); setRosterOverlayOpen(false); }
      if (e.key === '?') { e.preventDefault(); setShowShortcuts((shown) => !shown); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [current, editingAnswer, goNext, goPrev, handleSubmit, leaveCurrent, focusActive, overrideMarks, toggleRoster]);

  const jumpToQuestion = (questionNumber) => {
    if (!selectedStudent) return;
    const items = filteredItems;
    const idx = items.findIndex(i => i.questionNumber === questionNumber);
    if (idx >= 0) {
      setCurrentIndex(idx);
      return;
    }
    // A question can be approved while the reviewer is filtering to pending.
    // Switch to the full student sequence instead of making the tile a dead end.
    const allStudentItems = (queue?.items || []).filter((item) => item.studentId === selectedStudent);
    const allIndex = allStudentItems.findIndex((item) => item.questionNumber === questionNumber);
    if (allIndex >= 0) {
      setFilter('all');
      setCurrentIndex(allIndex);
    }
  };

  if (reviewMode === 'rubric') {
    return (
      <div className="min-h-screen bg-background">
        <div className="sticky top-0 z-20 border-b border-border bg-card px-4 py-3 sm:px-6">
          <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="font-headline text-xl font-bold tracking-tight text-foreground">Review Dashboard</h1>
              <nav aria-label="Review mode" className="flex gap-1">
                <a href="/review" className={cn(PILL, PILL_OFF)}>Question review</a>
                <span aria-current="page" className={cn(PILL, PILL_ON)}>Rubric review</span>
              </nav>
            </div>
            <div className="flex items-center gap-2 text-[13px] text-foreground-secondary">
              {['admin', 'skyll_admin'].includes(localStorage.getItem('userRole')) && (
                <Button asChild variant="secondary" size="sm">
                  <a href="/admin-dashboard">Pipeline Status</a>
                </Button>
              )}
              <span className={CHIP}>{reviewer}</span>
              <Button type="button" variant="ghost" size="sm" onClick={async () => { await signOut(); window.location.href = '/review-login'; }}>Logout</Button>
            </div>
          </div>
        </div>
        <RubricReviewPanel initialTestId={rubricTestId} onUnauthorized={redirectToReviewLogin} />
      </div>
    );
  }

  if (loading && !queue) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <Loader size="inline" className="text-action" />
          <p className="text-foreground-secondary">Loading...</p>
        </div>
      </div>
    );
  }

  if (error && !queue) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div role="alert" className={cn(CARD, 'max-w-md p-6 text-center')}>
          <AlertCircle className="mx-auto mb-4 h-10 w-10 text-destructive" aria-hidden="true" />
          <p className="mb-2 font-semibold text-destructive">{error}</p>
          <Button type="button" onClick={() => { setError(null); selectedCohort ? fetchQueue() : fetchCohorts(); }} className="mt-4">Retry</Button>
        </div>
      </div>
    );
  }

  // Cohort selection
  if (!selectedCohort && cohorts) {
    const facetOptions = (key) => [...new Set(cohorts.map((c) => c[key]).filter(Boolean))].sort();
    const facets = [
      ['school', facetOptions('school'), 'All schools'],
      ['grade', facetOptions('grade'), 'All grades'],
      ['subject', facetOptions('subject'), 'All subjects'],
    ].filter(([, options]) => options.length > 1);
    const baseCohorts = cohorts.filter((c) => cohortMatchesFilters(c, { ...cohortFilters, status: 'all' }));
    const statusCounts = COHORT_STATUS_FILTERS.reduce((acc, s) => {
      acc[s] = s === 'all' ? baseCohorts.length : baseCohorts.filter((c) => cohortStatusLabels(c).includes(s)).length;
      return acc;
    }, {});
    // Cohorts arrive newest-first from the API; re-sort here so the ordering
    // also holds after client-side merging of cohort status overlays.
    const filteredCohorts = cohorts.filter((c) => cohortMatchesFilters(c, cohortFilters)).sort(compareCohortsByExamDate);
    // Completed cohorts are archive material: keep them out of the working
    // grid unless the reviewer explicitly asks for them.
    const completedHidden = cohortFilters.status !== 'completed' && !cohortFilters.showCompleted;
    const visibleCohorts = completedHidden
      ? filteredCohorts.filter((c) => !cohortStatusLabels(c).includes('completed'))
      : filteredCohorts;
    const hiddenCompletedCount = filteredCohorts.length - visibleCohorts.length;
    // Only claim the date window emptied the grid when it is actually the cause.
    const dateFilterActive = cohortFilters.date !== 'all';
    const dateFilterEmptied = dateFilterActive && visibleCohorts.length === 0
      && cohorts.some((c) => cohortMatchesFilters(c, { ...cohortFilters, date: 'all' }));
    return (
      <div className="min-h-screen bg-background">
        <div className="sticky top-0 z-10 border-b border-border bg-card px-4 py-3 sm:px-6">
          <div className="mx-auto flex max-w-6xl flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="font-headline text-2xl font-bold tracking-tight text-foreground">Review Dashboard</h1>
              <p className="text-[13px] text-foreground-secondary">Select a cohort to review</p>
              <nav aria-label="Review mode" className="mt-2.5 flex gap-1">
                <span aria-current="page" className={cn(PILL, PILL_ON)}>Question review</span>
                <a href="/review?mode=rubric" className={cn(PILL, PILL_OFF)}>Rubric review</a>
              </nav>
            </div>
            <div className="flex items-center gap-2 text-[13px] text-foreground-secondary">
              {['admin', 'skyll_admin'].includes(localStorage.getItem('userRole')) && (
                <Button asChild variant="secondary" size="sm">
                  <a href="/admin-dashboard">Pipeline Status</a>
                </Button>
              )}
              <span className={CHIP}>{reviewer}</span>
              <Button type="button" variant="ghost" size="sm" onClick={async () => { await signOut(); window.location.href = '/review-login'; }}>Logout</Button>
            </div>
          </div>
        </div>
        <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
          <WorklistSummaryBar
            cohorts={baseCohorts}
            currentStatus={cohortFilters.status}
            onFilterSelect={(status) => setCohortFilters((f) => ({ ...f, status }))}
          />
          <div className="mb-6 flex flex-wrap items-center gap-2">
            {facets.map(([key, options, label]) => (
              <select
                key={key}
                value={cohortFilters[key]}
                onChange={(e) => setCohortFilters((f) => ({ ...f, [key]: e.target.value }))}
                aria-label={label}
                className={SELECT}
              >
                <option value="">{label}</option>
                {options.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            ))}
            <select
              value={cohortFilters.date}
              onChange={(e) => setCohortFilters((f) => ({ ...f, date: e.target.value }))}
              aria-label="Filter by exam date"
              className={SELECT}
            >
              {COHORT_DATE_FILTERS.map((value) => (
                <option key={value} value={value}>{COHORT_DATE_LABELS[value]}</option>
              ))}
            </select>
            <div role="group" aria-label="Cohort status" className="flex flex-wrap gap-1.5">
              {COHORT_STATUS_FILTERS.map((status) => (
                <button
                  key={status}
                  type="button"
                  aria-pressed={cohortFilters.status === status}
                  onClick={() => setCohortFilters((f) => ({ ...f, status }))}
                  className={cn(PILL, 'tabular-nums', cohortFilters.status === status ? PILL_ON : PILL_OFF)}
                >
                  {COHORT_STATUS_LABELS[status]} ({statusCounts[status] || 0})
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {visibleCohorts.map(c => {
              const isRegradeReady = ['regrade_ready', 'regrade_queued', 'published'].includes(c.cohortStatus?.status);
              const isQueued = c.cohortStatus?.status === 'regrade_queued';
              const progress = c.reviewPercent;
              const allReviewed = c.pending === 0;
              const cohortKey = c.id;
              return (
                <div
                  key={cohortKey}
                  className={cn(CARD, 'flex flex-col p-5 text-left transition-colors hover:border-hairline-strong')}
                >
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="font-headline text-lg font-bold leading-tight tracking-tight text-foreground">{c.examName || `${c.grade} ${c.subject}`}</h2>
                      <p className="mt-1 text-[13px] text-muted-foreground">{c.school} · {c.grade} · {c.subject}</p>
                    </div>
                    {isRegradeReady && (
                      <StatusBadge status={isQueued ? 'info' : 'positive'} icon={isQueued ? RefreshCw : Lock} className="shrink-0">
                        {isQueued ? 'Regrade in progress' : 'Review complete'}
                      </StatusBadge>
                    )}
                  </div>

                  <div className="mb-3 flex flex-wrap items-center gap-1.5">
                    <span className={CHIP}>{c.totalStudents} students</span>
                    <span className={CHIP}>{c.totalQuestions} questions</span>
                    {c.flagged > 0 && <StatusBadge status="caution" className="tabular-nums">{c.flagged} flagged</StatusBadge>}
                    {c.recheckCount > 0 && <StatusBadge status="caution" icon={RotateCcw} className="tabular-nums">{c.recheckCount} recheck request{c.recheckCount === 1 ? '' : 's'}</StatusBadge>}
                    {c.changedQuestions > 0 && <StatusBadge status="info" icon={RefreshCw} className="tabular-nums">{c.changedQuestions} changes · {c.changedStudents} students</StatusBadge>}
                  </div>

                  {/* Progress bar */}
                  <div className="mb-3">
                    <div className="mb-1.5 flex items-center justify-between text-[13px] tabular-nums">
                      <span className="font-semibold text-foreground">Review: {c.approved}/{c.totalQuestions}</span>
                      <span className="text-muted-foreground">{progress}% reviewed</span>
                    </div>
                    <div
                      role="progressbar"
                      aria-label="Questions reviewed"
                      aria-valuenow={progress}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      className="h-2.5 overflow-hidden rounded-full border border-ink bg-sunken"
                    >
                      <div
                        className={cn('h-full', isRegradeReady ? 'bg-ink' : 'bg-lime')}
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                  </div>

                  <div className="mb-3 flex flex-wrap items-center gap-1.5 text-xs">
                    {c.pending > 0 && <StatusBadge status="caution" icon={CircleDashed} className="tabular-nums">{c.pending} pending</StatusBadge>}
                    {c.approved > 0 && <StatusBadge status="positive" className="tabular-nums">{c.approved} approved</StatusBadge>}
                    {allReviewed && !isRegradeReady && <StatusBadge status="positive">Ready to publish</StatusBadge>}
                    {isRegradeReady && c.cohortStatus?.finalizedAt && (
                      <span className="text-muted-foreground">by {c.cohortStatus.finalizedBy} on {new Date(c.cohortStatus.finalizedAt).toLocaleDateString()}</span>
                    )}
                  </div>

                  {c.completionOverride && (
                    <div className="mb-3 rounded-xl border border-warning/30 bg-warning-soft px-3 py-2 text-[13px] text-warning-soft-foreground">
                      <span className="flex items-center gap-1.5 font-semibold">
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        Marked done by {c.completionOverride.markedBy} on {new Date(c.completionOverride.markedAt).toLocaleDateString()}
                      </span>
                      {cohortOverrideHasUnresolved(c) && (
                        <span className="mt-0.5 block">
                          {c.pending > 0 && `${c.pending} question${c.pending === 1 ? '' : 's'} left unreviewed`}
                          {c.pending > 0 && c.changedQuestions > 0 && ' · '}
                          {c.changedQuestions > 0 && `${c.changedQuestions} change${c.changedQuestions === 1 ? '' : 's'} awaiting regrade`}
                        </span>
                      )}
                    </div>
                  )}

                  {c.isCanonicalTest && (
                    c.release ? (
                      <p className="mb-3 flex items-center gap-1.5 text-[13px] text-muted-foreground">
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" aria-hidden="true" />
                        Released to students{c.release.releasedBy && c.release.releasedBy !== '089_exam_release' ? ` by ${c.release.releasedBy}` : ''} on {new Date(c.release.releasedAt).toLocaleDateString()}
                      </p>
                    ) : (
                      <div className="mb-3 rounded-xl border border-border bg-muted/40 px-3 py-2 text-[13px]">
                        <span className="flex items-center gap-1.5 font-semibold text-foreground">
                          <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          Hidden from students until released
                        </span>
                        {releaseConfirm?.cohortId === c.id ? (
                          <div className="mt-2">
                            <p className="text-muted-foreground">Students and parents will see this test's reports and be notified. This can't be undone.</p>
                            {releaseConfirm.error && <p className="mt-1 text-destructive" role="alert">{releaseConfirm.error}</p>}
                            <div className="mt-2 flex gap-2">
                              <Button type="button" size="sm" variant="ink" disabled={releaseConfirm.submitting} onClick={() => releaseToStudents(c)}>
                                {releaseConfirm.submitting ? <Loader size="inline" /> : null} Release
                              </Button>
                              <Button type="button" size="sm" variant="secondary" disabled={releaseConfirm.submitting} onClick={() => setReleaseConfirm(null)}>
                                Cancel
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <Button type="button" size="sm" variant="outline" className="mt-2" onClick={() => setReleaseConfirm({ cohortId: c.id, submitting: false, error: null })}>
                            Release to students
                          </Button>
                        )}
                      </div>
                    )
                  )}

                  <div className="mt-auto flex flex-wrap gap-2 pt-1">
                    {!isRegradeReady && (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setSelectedCohort(c)}
                        className="flex-1"
                      >
                        {c.changedQuestions > 0 ? 'Regrade changes' : allReviewed ? 'Review / Regrade' : 'Review'}
                      </Button>
                    )}
                    {isRegradeReady && (
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => setSelectedCohort(c)}
                        className="flex-1"
                      >
                        View
                      </Button>
                    )}
                    {c.isCanonicalTest && !c.completionOverride && (
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => setMarkCompleteConfirm({ cohort: c, submitting: false, error: null })}
                      >
                        Mark as done
                      </Button>
                    )}
                    {c.isCanonicalTest && c.completionOverride && (
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => unmarkCohortComplete(c)}
                      >
                        Undo completion
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {visibleCohorts.length === 0 && (
            <p className="py-12 text-center text-sm text-foreground-secondary">
              {dateFilterEmptied
                ? 'No exams match the selected date range.'
                : 'No cohorts match the current filters.'}
              {dateFilterEmptied && (
                <button
                  onClick={() => setCohortFilters((f) => ({ ...f, date: 'all' }))}
                  type="button"
                  className="ml-2 rounded font-semibold text-action hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Clear date filter
                </button>
              )}
            </p>
          )}
          {completedHidden && hiddenCompletedCount > 0 && (
            <div className="mt-6 text-center">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setCohortFilters((f) => ({ ...f, showCompleted: true }))}
              >
                Show completed ({hiddenCompletedCount})
              </Button>
            </div>
          )}
          {!completedHidden && cohortFilters.showCompleted && (
            <div className="mt-6 text-center">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setCohortFilters((f) => ({ ...f, showCompleted: false }))}
              >
                Hide completed
              </Button>
            </div>
          )}
        </div>
        {regradeConfirm && (
          <RegradeConfirmDialog
            cohort={regradeConfirm.cohort}
            preview={regradeConfirm.preview}
            loading={regradeConfirm.loading}
            error={regradeConfirm.error}
            onConfirm={() => { const target = regradeConfirm.cohort; setRegradeConfirm(null); runCohortRegrade(target); }}
            onCancel={() => setRegradeConfirm(null)}
            onRefresh={() => { setRegradeConfirm(null); fetchCohorts(); }}
          />
        )}
        {markCompleteConfirm && (
          <MarkCohortCompleteDialog
            cohort={markCompleteConfirm.cohort}
            submitting={markCompleteConfirm.submitting}
            error={markCompleteConfirm.error}
            onConfirm={() => markCohortComplete(markCompleteConfirm.cohort)}
            onCancel={() => setMarkCompleteConfirm(null)}
          />
        )}
      </div>
    );
  }

  if (!queue) return null;

  // Shared between the classic layout and the reviewer focus layout.
  const gradingCards = current ? (
    <>
      {/* Student + Question header card */}
      <div className={cn(CARD, 'space-y-4 p-4 sm:p-5')}>
        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-3">
            <span className="font-headline text-[26px] font-extrabold leading-none tracking-tight text-foreground">{current.questionNumber}</span>
            <div className="min-w-0 pt-0.5">
              <h2 className="text-sm font-bold text-foreground">
                {current.studentName?.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">
                  ({current.studentUsername || current.studentId})
                </span>
              </h2>
              <p className="mt-0.5 text-[13px] text-foreground-secondary tabular-nums">{current.questionNumber} · {current.overrideMarks ?? current.grade?.marks ?? 0}/{current.grade?.allocated ?? current.marksAllocated ?? 0}<AnswerLocationChip location={currentLocation} /></p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {current.section && <span className={CHIP}>{current.section}</span>}
            {current.isFlagged && (
              <StatusBadge status="caution">Flagged</StatusBadge>
            )}
            {(current.isHarshZero || current.reviewTags?.includes('harsh_zero')) && (
              <StatusBadge status="critical" title="Grader admitted correct content but awarded 0">Harsh zero</StatusBadge>
            )}
            {currentFlags.map((flag) => (
              <StatusBadge key={flag.key} status={flag.tone} title={flag.hint || undefined}>{flag.label}</StatusBadge>
            ))}
            {currentRechecks.length > 0 && (
              <StatusBadge status="caution" icon={RotateCcw}>Recheck request</StatusBadge>
            )}
            <RevisionSummaryBadge
              reviewRevision={current.reviewRevision}
              regradedRevision={current.regradedRevision}
              needsRegrade={current.needsRegrade}
              isEdited={Boolean(current.editedAt)}
            />
            {current.grade?.confidence != null && (
              <AiConfidenceBadge confidence={current.grade.confidence} showOnlyWhenRisk />
            )}
            <span className={CHIP}>{current.marksAllocated} mark(s)</span>
          </div>
        </div>

        {current.topic && (
          <span className="inline-flex rounded-full border border-hairline px-2.5 py-0.5 text-xs font-semibold text-foreground-secondary">{current.topic}</span>
        )}

        {(current.questionReference || current.answerKeyReference) && (
          <details className="rounded-xl border border-border bg-paper-soft px-3 py-2">
            <summary className="cursor-pointer text-[13px] font-semibold text-foreground">Question paper and solution reference</summary>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {current.questionReference && <ReferencePage title="Question paper" reference={current.questionReference} />}
              {current.answerKeyReference && <ReferencePage title="Ideal solution" reference={current.answerKeyReference} />}
            </div>
          </details>
        )}

        {(current.hasQuestionPaper || current.hasAnswerKey) && (
          <div className="flex flex-wrap gap-2 border-t border-border pt-3">
            {current.hasQuestionPaper && <IntakeReferenceLink testId={current.testId} kind="question_paper" label="Open question paper" />}
            {current.hasAnswerKey && <IntakeReferenceLink testId={current.testId} kind="answer_key" label="Open ideal solution" />}
          </div>
        )}

        {currentRechecks.map((request) => <RecheckRequestCard
          key={request.id}
          request={request}
          onTakeUp={(requestId) => updateRecheckStatus(requestId, 'in_review')}
          onKeepOriginalGrade={(requestId) => updateRecheckStatus(requestId, 'declined', 'Reviewed; the original grade remains unchanged.')}
        />)}

        <div>
          <p className={SECTION_LABEL}>Question</p>
          <div className="text-[15px] font-medium leading-relaxed text-foreground"><MathText text={current.questionText} stripJargon={false} block /></div>
        </div>

        <div className="border-t border-border pt-3">
          <p className={cn(SECTION_LABEL, 'flex items-center gap-1.5')}><CheckCircle2 className="h-3.5 w-3.5 text-success" aria-hidden="true" />Correct Answer</p>
          <div className="text-sm font-medium text-foreground"><MathText text={current.correctAnswer} stripJargon={false} block /></div>
          {current.acceptedVariations?.length > 0 && (
            <p className="mt-0.5 text-[13px] text-muted-foreground">Accepted: {current.acceptedVariations.join(', ')}</p>
          )}
          {currentKeyCheck && (
            <div className={cn('mt-2 rounded-lg px-3 py-2 text-[13px] leading-relaxed', currentKeyCheck.status === 'open' ? 'bg-destructive-soft text-destructive-soft-foreground' : 'bg-info-soft text-foreground')}>
              <p><span className="font-semibold">{currentKeyCheck.summary}.</span> {currentKeyCheck.resolution}</p>
              {currentKeyCheck.note && <p className="mt-0.5 text-foreground-secondary">{currentKeyCheck.note}</p>}
            </div>
          )}
        </div>

        <div>
          <p className={SECTION_LABEL}>Marking Rubric</p>
          <div className="text-sm leading-relaxed text-foreground-secondary"><MathText text={current.markingRubric} stripJargon={false} block /></div>
        </div>

        {(current.gradeRationale?.whatWentCorrect || current.gradeRationale?.missingOrWrong || currentFlags.some((flag) => flag.key !== 'key_check')) && (
          <div className="rounded-xl bg-paper px-3.5 py-3">
            <p className="text-[13px] font-bold text-foreground">Grading Reasoning</p>
            {current.gradeRationale?.whatWentCorrect && (
              <p className="mt-1.5 text-sm leading-relaxed text-foreground"><span className="font-semibold">Why these marks:</span> <span className={EVIDENCE_HIGHLIGHT}><MathText text={current.gradeRationale.whatWentCorrect} stripJargon={false} /></span></p>
            )}
            {current.gradeRationale?.missingOrWrong && (
              <p className="mt-1.5 text-sm leading-relaxed text-foreground-secondary"><span className="font-semibold text-foreground">What limited the score:</span> <MathText text={current.gradeRationale.missingOrWrong} stripJargon={false} /></p>
            )}
            {currentFlags.filter((flag) => flag.hint && flag.key !== 'key_check').map((flag) => (
              <p key={flag.key} className="mt-1.5 text-sm leading-relaxed text-foreground-secondary"><span className="font-semibold text-foreground">{flag.label}:</span> {flag.hint}</p>
            ))}
          </div>
        )}

        {current.regrade?.runId && (
          <p className="text-xs text-muted-foreground">
            Current explanation published from cohort regrade {String(current.regrade.runId).slice(-6)} · question revision {current.regrade.revision}
          </p>
        )}

        {current.revisionHistory?.length > 0 && (
          <details className="rounded-xl border border-border bg-paper-soft px-3 py-2 text-[13px]">
            <summary className="cursor-pointer font-semibold text-foreground-secondary">
              Revision history · current + {Math.max(0, current.revisionHistory.length - 1)} previous
            </summary>
            <div className="mt-2 space-y-2">
              {current.revisionHistory.map((revision, index) => (
                <div key={`${revision.runId || revision.source}-${revision.revision}-${index}`} className="border-l-2 border-hairline-strong pl-2.5">
                  <p className="font-semibold text-foreground">
                    Revision {revision.revision} {index === 0 ? '· current published input' : '· previous'}
                    <span className="ml-1 font-normal text-muted-foreground">{revision.state === 'completed' ? 'regenerated' : revision.state}</span>
                  </p>
                  <p className="mt-0.5 text-foreground-secondary">Reviewed marks: {revision.approvedMarks ?? '-'}/{revision.marksTotal ?? '-'}</p>
                  {revision.studentAnswer && <p className="mt-0.5 text-foreground-secondary"><span className="font-medium">Answer at this revision:</span> <MathText text={revision.studentAnswer} stripJargon={false} /></p>}
                  {revision.feedback?.gradingReasoning && <p className="mt-0.5 text-foreground-secondary"><span className="font-medium">Reasoning:</span> <MathText text={revision.feedback.gradingReasoning} stripJargon={false} /></p>}
                </div>
              ))}
            </div>
          </details>
        )}

        {current.answerKeyEvidence && (
          <details className="text-[13px]">
            <summary className="cursor-pointer font-semibold text-foreground-secondary">Answer Key Evidence</summary>
            <div className="mt-1 text-foreground-secondary"><MathText text={current.answerKeyEvidence} stripJargon={false} block /></div>
          </details>
        )}

        {current.visualReview && (
          <div className={cn('rounded-xl border px-3.5 py-3', current.visualReview.usable ? 'border-border bg-paper-soft' : 'border-warning/30 bg-warning-soft/40')}>
            <StatusBadge status={current.visualReview.usable ? 'info' : 'caution'} icon={current.visualReview.usable ? CheckCircle2 : AlertTriangle}>
              {current.visualReview.usable ? 'Visual reading used for grading' : 'No usable visual reading'}
            </StatusBadge>
            {current.visualReview.usable ? (
              <div className="mt-2 text-sm text-foreground"><MathText text={current.visualReview.visualAnswer} stripJargon={false} block /></div>
            ) : (
              <p className="mt-2 text-[13px] text-warning-soft-foreground">The vision model could not reliably match this page evidence to this question. Keep this item flagged; do not use the failed read as grading evidence.</p>
            )}
            {current.visualReview.evidenceLocation && <p className="mt-2 text-xs text-foreground-secondary"><span className="font-semibold">Evidence:</span> <span className={EVIDENCE_HIGHLIGHT}>{formatEvidenceLocation(current.visualReview.evidenceLocation)}</span></p>}
            {current.visualReview.note && <details className="mt-1.5 text-xs"><summary className="cursor-pointer font-semibold text-foreground-secondary">Model note</summary><p className="mt-1 text-foreground-secondary">{current.visualReview.note}</p></details>}
          </div>
        )}
      </div>

      {/* Student Answer - editable */}
      <div className={cn(CARD, 'space-y-2.5 p-4 sm:p-5')}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-bold text-foreground">Student Answer</h3>
            {hasManualAnswerEdit && (
              <StatusBadge status={current.needsRegrade ? 'info' : 'positive'} icon={current.needsRegrade ? RefreshCw : CheckCircle2}>
                {current.needsRegrade ? 'Saved · awaiting regrade' : 'Published revision'}
              </StatusBadge>
            )}
          </div>
          <div className="flex items-center gap-2">
            {editingAnswer ? (
              <>
                <Button type="button" variant="ghost" size="icon" onClick={() => setEditingAnswer(false)} aria-label="Cancel answer edit" className="h-8 w-8"><X className="h-4 w-4" aria-hidden="true" /></Button>
                <Button type="button" size="sm" onClick={handleSaveAnswer} disabled={savingAnswer}>
                  <Save className="h-3.5 w-3.5" aria-hidden="true" /> {savingAnswer ? 'Saving...' : 'Save'}
                </Button>
              </>
            ) : (
              <Button type="button" variant="ghost" size="sm" onClick={startEditAnswer} className="text-action">
                <Edit3 className="h-3.5 w-3.5" aria-hidden="true" /> Edit
              </Button>
            )}
            {!editingAnswer && current.studentAnswer && (
              <StatusBadge status={CONFIDENCE_BADGE[current.studentAnswer.confidence] || 'caution'} className="capitalize">{current.studentAnswer.confidence}</StatusBadge>
            )}
          </div>
        </div>

        {editingAnswer ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-1.5 text-[13px] text-foreground-secondary">
                <input type="checkbox" checked={answerDraft.attempted} onChange={e => setAnswerDraft(d => ({ ...d, attempted: e.target.checked }))} className="h-4 w-4 rounded accent-action" />
                Attempted
              </label>
              <select aria-label="Reading confidence" value={answerDraft.confidence} onChange={e => setAnswerDraft(d => ({ ...d, confidence: e.target.value }))} className={SELECT}>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
              <input type="text" aria-label="Option letter" placeholder="Option (a/b/c/d)" value={answerDraft.optionLetter} onChange={e => setAnswerDraft(d => ({ ...d, optionLetter: e.target.value }))} className={cn(SELECT, 'w-32')} />
            </div>
            <textarea
              value={answerDraft.studentWrote}
              onChange={e => setAnswerDraft(d => ({ ...d, studentWrote: e.target.value }))}
              rows={4}
              aria-label="What the student wrote"
              placeholder="What the student wrote..."
              className={cn(FIELD, 'resize-none')}
            />
          </div>
        ) : current.studentAnswer ? (
          <>
            {current.studentAnswer.attempted ? (
              <>
                {hasVisualReading && (
                  <p className={cn('text-xs font-semibold', usableVisualAnswer ? 'text-info' : 'text-warning')}>
                    {hasManualAnswerEdit ? 'Reviewer correction overrides visual transcription' : usableVisualAnswer ? 'Visual answer reading used for grading' : 'Visual review result - still flagged'}
                  </p>
                )}
                {rawAnswerIsPlaceholder && !hasVisualReading ? (
                  <p className="rounded-xl border border-warning/30 bg-warning-soft px-3 py-2 text-[13px] text-warning-soft-foreground">No verified visual transcription is available yet. This question remains flagged for visual review; do not treat the OCR placeholder as the student's answer.</p>
                ) : (
                  <div className="rounded-xl bg-paper-soft px-3.5 py-3 text-[15px] leading-relaxed text-foreground"><MathText text={visibleStudentAnswer || '(attempted but no text captured)'} stripJargon={false} block /></div>
                )}
                {visualAnswerReplacesPlaceholder && (
                  <p className="text-xs text-muted-foreground">The raw OCR contained image placeholders; the visual reading above is the grading evidence.</p>
                )}
              </>
            ) : (
              <p className="text-sm text-muted-foreground italic">Not attempted</p>
            )}
            {current.studentAnswer.optionLetter && (
              <p className="text-[13px] text-foreground-secondary">Option: <span className="font-semibold text-foreground">{current.studentAnswer.optionLetter}</span></p>
            )}
          </>
        ) : (
          <p className="text-sm text-muted-foreground italic">No answer data</p>
        )}
      </div>

      {/* Grade */}
      {current.grade && (
        <div className={cn(CARD, 'p-4 sm:p-5')}>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-bold text-foreground">Grade</h3>
            <div className="flex flex-wrap items-center gap-1.5">
              {current.grade.confidence && (
                <StatusBadge status={CONFIDENCE_BADGE[current.grade.confidence] || 'caution'} className="capitalize">{current.grade.confidence}</StatusBadge>
              )}
              {current.reviewStatus === 'approved' && (
                <StatusBadge status="positive">Approved</StatusBadge>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <p className="text-[32px] font-bold leading-none tracking-tight text-foreground tabular-nums">
              {current.overrideMarks !== null ? current.overrideMarks : current.grade.marks}<span className="text-xl font-semibold text-muted-foreground">/{current.grade.allocated}</span>
            </p>
            <StatusBadge
              status={(STATUS_COLORS[current.grade.status] || STATUS_COLORS.partial).badge}
              icon={(STATUS_COLORS[current.grade.status] || STATUS_COLORS.partial).icon}
              className="capitalize"
            >
              {current.grade.status?.replace(/_/g, ' ')}
            </StatusBadge>
            {current.overrideMarks !== null && (
              <span className="text-[13px] font-semibold text-warning tabular-nums">(was {current.grade.marks})</span>
            )}
          </div>
        </div>
      )}

    </>
  ) : null;

  const headerBanners = (
    <>
      {actionError && (
        <div role="alert" className="mx-auto mt-2.5 flex max-w-[1600px] items-start justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive-soft px-3 py-2 text-sm text-destructive-soft-foreground">
          <p className="flex items-start gap-2"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />{actionError}</p>
          <button type="button" onClick={() => setActionError(null)} className="shrink-0 text-[13px] font-semibold underline-offset-2 hover:underline">Dismiss</button>
        </div>
      )}
      {showShortcuts && (
        <div className="mx-auto mt-2.5 flex max-w-[1600px] flex-wrap gap-x-5 gap-y-2 rounded-xl border border-border bg-paper-soft p-3 text-[13px] text-foreground-secondary">
          <span><kbd className={KBD}>←</kbd> / <kbd className={KBD}>→</kbd> Previous / next</span>
          <span><kbd className={KBD}>Shift+Enter</kbd> Approve and next</span>
          {focusActive ? (
            <>
              <span><kbd className={KBD}>Enter</kbd> in Marks approves</span>
              <span><kbd className={KBD}>[</kbd> Show or hide the list</span>
              <span><kbd className={KBD}>F</kbd> Focus on the sheet</span>
              <span><kbd className={KBD}>+</kbd> / <kbd className={KBD}>-</kbd> / <kbd className={KBD}>0</kbd> Zoom the sheet</span>
            </>
          ) : (
            <span>Click question numbers in sidebar to jump</span>
          )}
        </div>
      )}
      {activeRegradeRun && (
        <div role="status" className="mx-auto mt-2.5 flex max-w-[1600px] flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-border bg-paper-soft px-3 py-2 text-[13px] text-foreground">
          <span className="font-bold">Regrade job</span>
          <StatusBadge status={
            activeRegradeRun.status === 'queued' ? 'neutral' :
            activeRegradeRun.status === 'running' ? 'info' :
            activeRegradeRun.status === 'published' ? 'positive' : 'critical'
          }>
            {activeRegradeRun.status === 'queued' ? 'Queued for OCI' :
              activeRegradeRun.status === 'running' ? 'OCI processing' :
              activeRegradeRun.status === 'published' ? 'Published' : activeRegradeRun.status}
          </StatusBadge>
          <span className="font-mono text-xs text-muted-foreground" title={activeRegradeRun.id}>Job {activeRegradeRun.id}</span>
          <span className="tabular-nums">{activeRegradeRun.progress?.completed || 0}/{activeRegradeRun.questionCount || 0} changed questions regenerated</span>
          {activeRegradeRun.status === 'queued' && !activeRegradeRun.watchExpired && <span className="text-foreground-secondary">Safe to leave this page; OCI will continue the job.</span>}
          {activeRegradeRun.watchExpired && <span className="font-semibold text-warning">Still running on OCI. Check back in a few minutes and reopen this cohort to see the results.</span>}
          {activeRegradeRun.status === 'published' && <span className="font-semibold text-success">Student reports, Learner DNA, and score summaries are current</span>}
          {activeRegradeRun.status === 'published' && activeRegradeRun.outputManifest?.teacherModules?.refreshed !== false && <span className="font-semibold text-success">Admin dashboard projections are current</span>}
          {activeRegradeRun.status === 'published' && activeRegradeRun.outputManifest?.teacherModules?.refreshed === false && <span className="font-semibold text-warning">Student reports are live; the admin aggregate refresh needs retry</span>}
          {activeRegradeRun.moduleWarnings > 0 && <span className="font-semibold text-warning">{activeRegradeRun.moduleWarnings} student module{activeRegradeRun.moduleWarnings === 1 ? '' : 's'} retained for retry</span>}
          {activeRegradeRun.status === 'partial' && <span className="font-semibold text-destructive">Needs retry for {activeRegradeRun.progress?.failed || 0} question(s)</span>}
          {activeRegradeRun.status === 'partial' && features.review_scale_v2 && (
            <Button type="button" variant="destructive" size="sm" onClick={retryFailedRegrade} disabled={cohortRegrading !== null}>Retry failed questions</Button>
          )}
          {activeRegradeRun.failedItems?.length > 0 && (
            <details className="basis-full text-destructive-soft-foreground"><summary className="cursor-pointer font-semibold">See retry list ({activeRegradeRun.failedItems.length})</summary><ul className="mt-1 list-disc pl-4">{activeRegradeRun.failedItems.map((item) => <li key={item.questionId}>{item.studentName} · {item.questionNumber || 'Question'}: {item.error}</li>)}</ul></details>
          )}
        </div>
      )}
    </>
  );

  const cohortProgress = queue.reviewPercent || 0;
  const selectedStudentData = students.find(s => s.studentId === selectedStudent);

  // ── Reviewer focus layout (school flag review_focus_layout, lg+) ─────────
  // The answer sheet takes the full height; marks and approval sit in a rail
  // beside it; the roster can be tucked into a labelled strip; reviewers can
  // work one student at a time or one question across every student.
  if (focusActive) {
    const rosterOrder = filterAndSortStudents(students, '', rosterSortMode);
    const maxMarks = current ? Number(current.grade?.allocated ?? current.marksAllocated ?? 0) : 0;
    const minMarks = current ? Number(current.marksMin ?? 0) : 0;
    const marksError = reviewMarksError(overrideMarks, current);
    const hasOverride = Boolean(overrideMarks !== '' && Number(overrideMarks) !== Number(current?.grade?.marks ?? 0));
    const selectedQuestionSummary = questionSummaries.find((question) => question.number === selectedQuestion);
    const questionAnswers = byQuestion && selectedQuestion
      ? rosterOrder.flatMap((student) => (studentMap.get(student.studentId) || []).filter((item) => item.questionNumber === selectedQuestion))
      : [];

    // What "done" means depends on how the reviewer is working.
    const scopeDone = byQuestion ? Boolean(selectedQuestionSummary && selectedQuestionSummary.pending === 0)
      : Boolean(selectedStudentData && selectedStudentData.pending === 0);
    const nextScope = (() => {
      if (byQuestion) {
        const index = questionSummaries.findIndex((question) => question.number === selectedQuestion);
        const ordered = [...questionSummaries.slice(index + 1), ...questionSummaries.slice(0, Math.max(0, index))];
        const next = ordered.find((question) => question.pending > 0);
        return next ? { key: next.number, label: `Question ${String(next.number).replace(/^Q/i, '')}` } : null;
      }
      const index = rosterOrder.findIndex((student) => student.studentId === selectedStudent);
      const ordered = [...rosterOrder.slice(index + 1), ...rosterOrder.slice(0, Math.max(0, index))];
      const next = ordered.find((student) => student.pending > 0);
      return next ? { key: next.studentId, label: displayName(next.name) } : null;
    })();
    const scopeName = byQuestion ? `Question ${String(selectedQuestion || '').replace(/^Q/i, '')}` : displayName(selectedStudentData?.name);

    const selectStudent = (studentId) => leaveCurrent(() => {
      setSelectedStudent(studentId); setQuestionNavFilter('all'); setCurrentIndex(0); setRosterOverlayOpen(false);
    });
    const selectQuestion = (number) => leaveCurrent(() => {
      setSelectedQuestion(number); setCurrentIndex(0); setRosterOverlayOpen(false);
    });
    const goToScope = (key) => (byQuestion ? selectQuestion(key) : selectStudent(key));
    const selectAnswer = (itemId) => leaveCurrent(() => {
      const index = filteredItems.findIndex((item) => item.id === itemId);
      if (index >= 0) { setCurrentIndex(index); return; }
      pendingFocusIdRef.current = itemId;
      setFilter('all');
    });
    const switchReviewBy = (mode) => {
      if (mode === reviewBy) return;
      leaveCurrent(() => {
        writePref('skyll.review.by', mode);
        if (current) pendingFocusIdRef.current = current.id;
        if (mode === 'question') {
          setSelectedQuestion(current?.questionNumber || null);
          setSelectedStudent(null);
        } else {
          setSelectedStudent(current?.studentId || rosterOrder[0]?.studentId || null);
          setSelectedQuestion(null);
          setQuestionNavFilter('all');
        }
        setReviewBy(mode);
      });
    };
    const dismissRosterTip = () => { setRosterTipSeen(true); writePref('skyll.review.rosterTipSeen', '1'); };
    const closeQueue = () => leaveCurrent(() => {
      queuePresentRef.current = false; setSelectedCohort(null); setQueue(null); setSelectedStudent(null); setSelectedQuestion(null); setFocusMode(false);
    });

    const openRechecks = recheckRequests.filter((r) => ['open', 'in_review', 'awaiting_regrade'].includes(r.status)).length;
    const harshZeros = (queue?.items || []).filter((item) => item.isHarshZero || item.reviewTags?.includes('harsh_zero')).length;
    const needsRegradeCount = queue.items.filter((item) => item.needsRegrade).length;
    const showCohortRegrade = (selectedCohort.changedQuestions > 0 || (queue?.items || []).some(i => i.needsRegrade || (i.editedAt && (i.reviewRevision || 0) > (i.regradedRevision || 0)))) && selectedCohort.testId;

    const pickerProps = byQuestion
      ? {
        label: selectedQuestion ? `Question ${String(selectedQuestion).replace(/^Q/i, '')}` : 'Pick a question',
        sublabel: selectedQuestionSummary ? `${selectedQuestionSummary.approved}/${selectedQuestionSummary.total}` : '',
        searchLabel: 'Find a question',
        options: questionSummaries.map((q) => ({ key: q.number, label: `Question ${String(q.number).replace(/^Q/i, '')}`, meta: `${q.approved}/${q.total}`, done: q.pending === 0, selected: q.number === selectedQuestion })),
        onSelect: selectQuestion,
      }
      : {
        label: selectedStudentData ? displayName(selectedStudentData.name) : 'All students',
        sublabel: selectedStudentData ? `${rosterOrder.findIndex((st) => st.studentId === selectedStudent) + 1} of ${students.length}` : `${students.length}`,
        searchLabel: 'Find a student',
        options: rosterOrder.map((st) => ({ key: st.studentId, label: displayName(st.name), search: st.studentUsername, meta: `${st.approved}/${st.items.length}`, done: st.pending === 0, selected: st.studentId === selectedStudent })),
        onSelect: selectStudent,
      };

    const rosterPanel = (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 px-3 pt-3">
          <span className="text-[13px] font-bold text-foreground">{byQuestion ? 'Questions' : 'Students'}</span>
          <span className="text-xs font-semibold text-muted-foreground tabular-nums">{byQuestion ? questionSummaries.length : students.length}</span>
          <button type="button" onClick={toggleRoster} className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-semibold text-foreground-secondary transition-colors hover:bg-sunken hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" title="Hide the list ([)">
            <PanelLeftClose className="h-4 w-4" aria-hidden="true" /> Hide list
          </button>
        </div>
        {byQuestion ? (
          <>
            <div className="max-h-[45%] shrink-0 overflow-y-auto border-b border-border p-3">
              <QuestionProgressGrid questions={questionSummaries} selected={selectedQuestion} onSelect={selectQuestion} />
            </div>
            <div className="flex min-h-0 flex-1 flex-col p-3">
              <p className="mb-2 text-xs font-semibold text-muted-foreground">
                {selectedQuestion ? `Answers to question ${String(selectedQuestion).replace(/^Q/i, '')}` : 'Pick a question above'}
              </p>
              <div className="-mr-1 min-h-0 flex-1 overflow-y-auto pr-1">
                <QuestionAnswerList items={questionAnswers} currentId={current?.id} onSelect={selectAnswer} />
              </div>
            </div>
          </>
        ) : (
          <>
            {selectedStudentData && (
              <div className="max-h-[45%] shrink-0 overflow-y-auto">
                <StudentQuestionGrid
                  student={selectedStudentData}
                  questions={studentQuestions}
                  current={current}
                  filter={questionNavFilter}
                  onFilterChange={setQuestionNavFilter}
                  onSelect={(questionNumber) => leaveCurrent(() => jumpToQuestion(questionNumber))}
                  onApproveAll={canApproveAll ? approveAllForStudent : null}
                  approvingAll={approvingAll}
                />
              </div>
            )}
            <div className="flex min-h-[14rem] flex-1 flex-col p-3">
              <RosterSearch
                searchTerm={rosterSearchTerm}
                onSearchChange={setRosterSearchTerm}
                sortMode={rosterSortMode}
                onSortChange={setRosterSortMode}
                studentCount={filterAndSortStudents(students, rosterSearchTerm, rosterSortMode).length}
              />
              <div className="-mr-1 min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
                {filterAndSortStudents(students, rosterSearchTerm, rosterSortMode).map((st) => (
                  <StudentRosterCard key={st.studentId} student={st} isSelected={selectedStudent === st.studentId} onSelect={() => selectStudent(st.studentId)} />
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    );

    const collapsedDone = byQuestion ? questionSummaries.filter((q) => q.pending === 0).length : students.filter((st) => st.pending === 0).length;
    const collapsedTotal = byQuestion ? questionSummaries.length : students.length;
    const rosterStrip = (
      <div className="relative shrink-0">
        <button
          type="button"
          onClick={() => { toggleRoster(); dismissRosterTip(); }}
          aria-label={`Show the ${byQuestion ? 'question' : 'student'} list ([)`}
          title={`Show the ${byQuestion ? 'question' : 'student'} list ([)`}
          className="flex h-full w-16 flex-col items-center gap-3 border-r border-border bg-card py-3 transition-colors hover:bg-paper-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-full border-[1.5px] border-ink bg-lime text-xs font-bold text-ink">
            {byQuestion ? String(selectedQuestion || '?').replace(/^Q/i, '') : initials(selectedStudentData?.name)}
          </span>
          <span className="text-xs font-bold text-foreground tabular-nums">{collapsedDone}/{collapsedTotal}</span>
          <span className="h-24 w-1.5 overflow-hidden rounded-full bg-sunken" aria-hidden="true">
            <span className="block w-full rounded-full bg-ink" style={{ height: `${collapsedTotal ? Math.round((collapsedDone / collapsedTotal) * 100) : 0}%` }} />
          </span>
          <span className="mt-1 text-[13px] font-bold text-foreground [writing-mode:vertical-rl] rotate-180">
            {byQuestion ? `Questions · ${collapsedTotal}` : `Students · ${collapsedTotal}`}
          </span>
        </button>
        {!rosterTipSeen && !rosterOverlayOpen && (
          <div role="note" className="absolute left-[4.5rem] top-3 z-30 w-60 rounded-2xl border-2 border-ink bg-card p-3 shadow-hard-md">
            <p className="text-[13px] font-semibold text-foreground">Your {byQuestion ? 'question' : 'student'} list is here.</p>
            <p className="mt-1 text-xs text-foreground-secondary">Click this strip or press <kbd className={KBD}>[</kbd> to show or hide it.</p>
            <Button type="button" size="sm" variant="outline" className="mt-2.5" onClick={dismissRosterTip}>Got it</Button>
          </div>
        )}
      </div>
    );

    const doneCard = scopeDone && nextScope ? (
      <div className="flex items-center gap-3 rounded-xl border-[1.5px] border-ink bg-lime/60 px-3 py-2.5">
        <CheckCircle2 className="h-5 w-5 shrink-0 text-ink" aria-hidden="true" />
        <p className="min-w-0 flex-1 text-[13px] text-ink"><span className="font-bold">{scopeName} is done.</span> Next: {nextScope.label}</p>
        <Button type="button" size="sm" variant="ink" onClick={() => goToScope(nextScope.key)}>Next <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" /></Button>
      </div>
    ) : null;

    return (
      <div className="flex h-dvh flex-col overflow-hidden bg-background">
        {!focusMode && (
          <header className="z-20 shrink-0 border-b border-border bg-card">
            <div className="mx-auto flex h-14 max-w-[1800px] items-center gap-2.5 px-3 lg:px-4">
              <button type="button" aria-label="Back to cohorts" onClick={closeQueue} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border-[1.5px] border-ink bg-card transition-colors hover:bg-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <ArrowLeft className="h-4 w-4 text-foreground" aria-hidden="true" />
              </button>
              <div className="min-w-0 max-w-[10rem] xl:max-w-[22rem]">
                <h1 className="truncate font-headline text-base font-bold leading-tight tracking-tight text-foreground">{selectedCohort.examName || `${selectedCohort.grade} ${selectedCohort.subject}`}</h1>
                <p className="truncate text-xs text-foreground-secondary tabular-nums">{selectedCohort.school} · {queue.approved}/{queue.totalQuestions} reviewed</p>
              </div>
              <div role="group" aria-label="Review by" className="flex shrink-0 items-center rounded-full border border-hairline bg-paper p-0.5">
                {[['student', 'Student'], ['question', 'Question']].map(([mode, noun]) => (
                  <button key={mode} type="button" aria-pressed={reviewBy === mode} aria-label={`By ${mode}`} onClick={() => switchReviewBy(mode)} className={cn('h-8 whitespace-nowrap rounded-full px-3 text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', reviewBy === mode ? 'bg-ink text-lime' : 'text-foreground-secondary hover:text-foreground')}>
                    <span className="xl:hidden">{noun}</span><span className="hidden xl:inline">By {mode}</span>
                  </button>
                ))}
              </div>
              <PickerMenu {...pickerProps} />
              <div className="ml-auto flex min-w-0 items-center gap-2">
                {openRechecks > 0 && (
                  <button type="button" onClick={() => { setFilter('rechecks'); setCurrentIndex(0); }} className={cn(PILL, filter === 'rechecks' ? PILL_ON : 'border-warning/40 bg-warning-soft text-warning-soft-foreground')}>
                    Rechecks <span className="font-bold tabular-nums">{openRechecks}</span>
                  </button>
                )}
                {harshZeros > 0 && (
                  <button type="button" onClick={() => { setFilter('harsh-zeros'); setCurrentIndex(0); }} className={cn(PILL, 'hidden xl:inline-flex', filter === 'harsh-zeros' ? PILL_ON : 'border-destructive/30 bg-destructive-soft text-destructive-soft-foreground')}>
                    Harsh zeros <span className="font-bold tabular-nums">{harshZeros}</span>
                  </button>
                )}
                <select value={filter} onChange={(event) => { setFilter(event.target.value); setCurrentIndex(0); }} className={cn(SELECT, 'h-9 w-36 shrink-0 xl:w-auto')} aria-label="Review queue filter">
                  <option value="pending">Pending</option>
                  <option value="approved">Approved</option>
                  <option value="all">All questions</option>
                  <option value="flagged">Flagged</option>
                  <option value="harsh-zeros">Harsh zeros</option>
                  <option value="low-confidence">Low confidence</option>
                  <option value="rechecks">All rechecks</option>
                  <option value="student-rechecks">Student requests</option>
                  <option value="teacher-rechecks">Teacher requests</option>
                  <option value="awaiting-regrade">Awaiting regrade</option>
                  <option value="edited-awaiting-regrade">Edited, awaiting regrade</option>
                  <option value="complete">Complete</option>
                </select>
                <div className="hidden h-9 w-48 items-center gap-2 rounded-[10px] border border-input bg-card px-2.5 focus-within:ring-2 focus-within:ring-ring xl:flex 2xl:w-56">
                  <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <input value={search} onChange={(event) => { setSearch(event.target.value); setCurrentIndex(0); }} aria-label="Search the review queue" placeholder="Search" className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground" />
                </div>
                {(showCohortRegrade || needsRegradeCount > 0) && (
                  <Button type="button" variant="ink" size="sm" onClick={() => openRegradeConfirm(selectedCohort)} disabled={cohortRegrading !== null}>
                    {cohortRegrading ? <Loader size="inline" /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
                    <span className="hidden xl:inline">{cohortRegrading ? 'Regrading...' : 'Regrade changes'}</span>
                  </Button>
                )}
                {['admin', 'skyll_admin'].includes(localStorage.getItem('userRole')) && (
                  <Button asChild variant="ghost" size="sm" className="hidden 2xl:inline-flex"><a href="/admin-dashboard">Pipeline status</a></Button>
                )}
                <Button type="button" variant="secondary" size="icon" className="h-9 w-9" onClick={() => setShowShortcuts((shown) => !shown)} aria-label="Keyboard shortcuts" aria-expanded={showShortcuts} title="Keyboard shortcuts (?)">
                  <Keyboard className="h-4 w-4" aria-hidden="true" />
                </Button>
                <Button type="button" variant="secondary" size="icon" className="h-9 w-9" onClick={fetchQueue} aria-label="Refresh" title="Refresh">
                  <RefreshCw className={cn('h-4 w-4', queueRefreshing && 'animate-spin')} aria-hidden="true" />
                </Button>
              </div>
            </div>
            {(actionError || showShortcuts || activeRegradeRun) && <div className="px-3 pb-2.5 lg:px-4">{headerBanners}</div>}
          </header>
        )}

        <div className="relative flex min-h-0 flex-1">
          {!focusMode && (rosterCollapsed ? rosterStrip : (
            <aside aria-label={byQuestion ? 'Questions' : 'Students'} className="flex w-72 shrink-0 flex-col border-r border-border bg-card">
              {rosterPanel}
            </aside>
          ))}
          {!focusMode && rosterCollapsed && rosterOverlayOpen && (
            <button type="button" aria-label="Close the list" tabIndex={-1} onClick={() => setRosterOverlayOpen(false)} className="absolute inset-y-0 left-16 right-0 z-20 cursor-default bg-ink/10" />
          )}
          {!focusMode && rosterCollapsed && rosterOverlayOpen && (
            <aside aria-label={byQuestion ? 'Questions' : 'Students'} className="absolute inset-y-0 left-16 z-30 flex w-80 flex-col rounded-r-2xl border-2 border-l-0 border-ink bg-card shadow-hard-md">
              {rosterPanel}
            </aside>
          )}

          {current ? (
            <>
              <main className="flex min-w-0 flex-1 flex-col p-3 lg:p-4">
                <AnswerSheetPanel
                  fill
                  testId={current.testId}
                  testStudentId={current.testStudentId || current.studentId}
                  subject={current.subject}
                  pageCount={current.pageCount || 0}
                  location={currentLocation}
                  focusKey={current.id}
                  focused={focusMode}
                  onToggleFocus={() => setFocusMode((on) => !on)}
                />
              </main>
              <aside aria-label="Grading" className="flex w-[340px] shrink-0 flex-col border-l border-border bg-card lg:w-[380px] 2xl:w-[440px]">
                <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
                  {byQuestion && (
                    <p className="text-xs font-semibold text-muted-foreground">
                      {displayName(current.studentName)} · answer {currentIndex + 1} of {filteredItems.length}
                    </p>
                  )}
                  {gradingCards}
                </div>
                <div className="shrink-0 space-y-2.5 border-t border-border bg-card p-3">
                  {doneCard}
                  <div className="flex items-start gap-2.5">
                    <div className="w-28 shrink-0">
                      <label htmlFor="review-override-marks" className="mb-1 block text-xs font-semibold text-foreground-secondary">Marks</label>
                      <div className={cn('flex h-10 items-center rounded-[10px] border bg-card pr-2.5 focus-within:ring-2 focus-within:ring-ring', marksError ? 'border-destructive' : 'border-input')}>
                        <input
                          id="review-override-marks"
                          type="number" step="0.5" min={minMarks} max={maxMarks}
                          inputMode="decimal"
                          value={overrideMarks}
                          onChange={(event) => setOverrideMarks(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key !== 'Enter' || marksError || saving) return;
                            event.preventDefault();
                            handleSubmit('approved', { advance: event.shiftKey });
                          }}
                          placeholder={String(current.grade?.marks ?? 0)}
                          aria-invalid={Boolean(marksError)}
                          aria-describedby="review-marks-help"
                          className="h-full min-w-0 flex-1 rounded-[10px] bg-transparent px-2.5 text-base font-bold text-foreground outline-none tabular-nums placeholder:font-semibold placeholder:text-muted-foreground"
                        />
                        <span className="text-sm font-semibold text-muted-foreground tabular-nums">/ {maxMarks}</span>
                      </div>
                    </div>
                    <p id="review-marks-help" className={cn('mt-6 min-w-0 flex-1 text-xs leading-snug', marksError ? 'font-semibold text-destructive' : 'text-muted-foreground')}>
                      {marksError || (hasOverride ? `Changing from ${current.grade?.marks ?? 0}. Enter saves.` : current.reviewStatus === 'approved' ? `Approved by ${current.reviewedBy}` : 'Leave blank to keep the AI mark. Enter approves.')}
                    </p>
                  </div>
                  {/* Approve and move on is the action reviewers repeat, so it leads. */}
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="lg"
                      onClick={() => handleSubmit('approved', { advance: true })}
                      disabled={saving || Boolean(marksError)}
                      className={cn('min-w-0 flex-1 rounded-xl text-[15px] font-bold', hasOverride && 'bg-warning-soft text-warning-soft-foreground hover:bg-warning-soft/80')}
                    >
                      {saving ? <><Loader size="inline" /> Saving...</> : <>
                        <span className="truncate">{hasOverride ? 'Save' : current.reviewStatus === 'approved' ? 'Re-approve' : 'Approve'} & next</span>
                        <span className="shrink-0 font-semibold tabular-nums opacity-80">{overrideMarks !== '' ? overrideMarks : (current.grade?.marks ?? 0)}/{maxMarks}</span>
                      </>}
                    </Button>
                    <Button type="button" size="lg" variant="outline" onClick={() => handleSubmit('approved')} disabled={saving || Boolean(marksError)} className="shrink-0 rounded-xl px-4 text-[13px]" title={hasOverride ? 'Save the new mark and stay on this answer' : 'Approve and stay on this answer'}>
                      {hasOverride ? 'Save only' : 'Approve only'}
                    </Button>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Button type="button" variant="secondary" size="icon" className="h-9 w-9" onClick={() => leaveCurrent(goPrev)} disabled={saving || currentIndex === 0} aria-label="Previous">
                      <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                    </Button>
                    <span className="min-w-[4.5rem] text-center text-[13px] font-semibold text-foreground-secondary tabular-nums">{currentIndex + 1} of {filteredItems.length}</span>
                    <Button type="button" variant="secondary" size="icon" className="h-9 w-9" onClick={() => leaveCurrent(goNext)} disabled={currentIndex >= filteredItems.length - 1} aria-label="Next">
                      <ChevronRight className="h-4 w-4" aria-hidden="true" />
                    </Button>
                    <span className="ml-auto text-right text-[11px] leading-tight text-muted-foreground"><kbd className={KBD}>Shift+Enter</kbd> approve and next</span>
                  </div>
                </div>
              </aside>
            </>
          ) : (
            <div className="flex min-w-0 flex-1 items-center justify-center p-6">
              <div className="max-w-sm text-center">
                <span className="mx-auto flex h-12 w-12 -rotate-3 items-center justify-center rounded-full border-2 border-ink bg-lime"><Check className="h-6 w-6 text-ink" strokeWidth={2.6} aria-hidden="true" /></span>
                <p className="mt-3 font-headline text-xl font-bold text-foreground">
                  {scopeDone ? `${scopeName} is done` : filter === 'pending' ? 'Nothing left to review here' : 'No answers match this filter'}
                </p>
                <p className="mt-1 text-sm text-foreground-secondary">
                  {nextScope ? `Next up: ${nextScope.label}.` : 'Every answer in this exam has been reviewed.'}
                </p>
                <div className="mt-4 flex justify-center gap-2">
                  {nextScope && <Button type="button" onClick={() => goToScope(nextScope.key)}>Go to {nextScope.label} <ArrowRight className="h-4 w-4" aria-hidden="true" /></Button>}
                  {filter !== 'all' && <Button type="button" variant="secondary" onClick={() => { setFilter('all'); setCurrentIndex(0); }}>Show all answers</Button>}
                </div>
              </div>
            </div>
          )}
        </div>

        {regradeConfirm && (
          <RegradeConfirmDialog
            cohort={regradeConfirm.cohort}
            preview={regradeConfirm.preview}
            loading={regradeConfirm.loading}
            error={regradeConfirm.error}
            onConfirm={() => { const target = regradeConfirm.cohort; setRegradeConfirm(null); runCohortRegrade(target); }}
            onCancel={() => setRegradeConfirm(null)}
            onRefresh={() => openRegradeConfirm(regradeConfirm.cohort)}
          />
        )}
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-background md:h-dvh md:min-h-0 md:overflow-hidden">
      {/* Header: part of the fixed-height column on md+, so it never covers the panels */}
      <div className="z-20 shrink-0 border-b border-border bg-card px-4 py-2.5 sm:px-6">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-x-5 gap-y-3">
          <div className="flex min-w-0 items-center gap-3">
            <button type="button" aria-label="Back to cohorts" onClick={() => { queuePresentRef.current = false; setSelectedCohort(null); setQueue(null); setSelectedStudent(null); }} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] border-[1.5px] border-ink bg-card transition-colors hover:bg-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <ArrowLeft className="h-[18px] w-[18px] text-foreground" aria-hidden="true" />
            </button>
            <div className="min-w-0">
              <h1 className="truncate font-headline text-xl font-bold tracking-tight text-foreground">{selectedCohort.examName || `${selectedCohort.grade} ${selectedCohort.subject}`}</h1>
              <p className="truncate text-[13px] text-foreground-secondary tabular-nums" title={`${selectedCohort.school} · ${selectedCohort.grade} · ${selectedCohort.subject}`}>
                {selectedCohort.school} · {selectedCohort.grade} · {selectedCohort.subject} · {students.length} students · Review {queue.approved}/{queue.totalQuestions} · {queue.pending} pending · {queue.flagged || 0} flagged
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
              {['admin', 'skyll_admin'].includes(localStorage.getItem('userRole')) && (
                <Button asChild variant="secondary" size="sm">
                  <a href="/admin-dashboard">Pipeline Status</a>
                </Button>
              )}
              {(selectedCohort.changedQuestions > 0 || (queue?.items || []).some(i => i.needsRegrade || (i.editedAt && (i.reviewRevision || 0) > (i.regradedRevision || 0)))) && selectedCohort.testId && (
                <Button
                  type="button"
                  variant="ink"
                  size="sm"
                  onClick={() => openRegradeConfirm(selectedCohort)}
                  disabled={cohortRegrading === selectedCohort.id}
                >
                  {cohortRegrading === selectedCohort.id  ? <Loader size="inline" /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
                  {cohortRegrading === selectedCohort.id ? 'Regrading...' : 'Regrade changes'}
                </Button>
              )}
            <div className="hidden items-center gap-2 sm:flex">
              <div
                role="progressbar"
                aria-label="Reviewed"
                aria-valuenow={cohortProgress}
                aria-valuemin={0}
                aria-valuemax={100}
                className="h-3 w-28 overflow-hidden rounded-full border-[1.5px] border-ink bg-sunken"
              >
                <div className="h-full bg-lime" style={{ width: `${cohortProgress}%` }} />
              </div>
              <span className="whitespace-nowrap text-[13px] font-semibold text-foreground tabular-nums">{cohortProgress}% reviewed</span>
            </div>
            <Button type="button" variant="secondary" size="sm" onClick={() => setShowShortcuts(s => !s)} title="Keyboard shortcuts" aria-label="Keyboard shortcuts" aria-expanded={showShortcuts}>
              <Keyboard className="h-4 w-4" aria-hidden="true" />
              <span className="hidden lg:inline">Shortcuts</span>
            </Button>
            <Button type="button" variant="secondary" size="icon" onClick={fetchQueue} title="Refresh" aria-label="Refresh" className="h-8 w-8">
              <RefreshCw className={cn('h-4 w-4', queueRefreshing && 'animate-spin')} aria-hidden="true" />
            </Button>
            {selectedCohort.testId && queue.items.filter((item) => item.needsRegrade).length > 0 && (
              <Button
                type="button"
                variant="ink"
                size="sm"
                onClick={() => runCohortRegrade(selectedCohort)}
                disabled={cohortRegrading !== null}
              >
                {cohortRegrading  ? <Loader size="inline" /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
                {cohortRegrading ? 'Regrading...' : `Regrade ${queue.items.filter((item) => item.needsRegrade).length} changes`}
              </Button>
            )}
          </div>
        </div>
        {/* Filters: one row that scrolls sideways instead of wrapping */}
        <div className="mx-auto mt-2.5 flex max-w-[1600px] flex-wrap items-center gap-2 lg:flex-nowrap">
          <div className="no-scrollbar -mx-1 flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto px-1 py-0.5 pr-6 [mask-image:linear-gradient(to_right,black_calc(100%-28px),transparent)]">
            <div role="group" aria-label="Show" className="flex shrink-0 items-center gap-1.5">
              {['pending', 'approved', 'rechecks', 'harsh-zeros', 'all'].map(f => {
                const isRechecks = f === 'rechecks';
                const isHarsh = f === 'harsh-zeros';
                const recheckBadge = isRechecks ? recheckRequests.filter(r => ['open', 'in_review', 'awaiting_regrade'].includes(r.status)).length : 0;
                const harshBadge = isHarsh ? (queue?.items || []).filter((item) => item.isHarshZero || item.reviewTags?.includes('harsh_zero')).length : 0;
                return (
                  <button
                    key={f}
                    type="button"
                    aria-pressed={filter === f}
                    onClick={() => { setFilter(f); setCurrentIndex(0); }}
                    className={cn(PILL, 'capitalize', filter === f ? PILL_ON : PILL_OFF)}
                  >
                    {f === 'harsh-zeros' ? 'Harsh zeros' : f}
                    {isRechecks && recheckBadge > 0 && (
                      <span className={cn('rounded-full px-1.5 text-xs font-bold leading-5 tabular-nums', filter === f ? 'bg-lime text-ink' : 'bg-warning-soft text-warning-soft-foreground')}>{recheckBadge}</span>
                    )}
                    {isHarsh && harshBadge > 0 && (
                      <span className={cn('rounded-full px-1.5 text-xs font-bold leading-5 tabular-nums', filter === f ? 'bg-lime text-ink' : 'bg-destructive-soft text-destructive-soft-foreground')}>{harshBadge}</span>
                    )}
                  </button>
                );
              })}
            </div>
            <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-hairline" />
            <div role="group" aria-label="Recheck requests" className="flex shrink-0 items-center gap-1.5">
              <span className="mr-0.5 whitespace-nowrap text-[13px] font-semibold text-foreground-secondary">Rechecks</span>
              {[
                { value: 'student-rechecks', label: 'Student' },
                { value: 'teacher-rechecks', label: 'Teacher' },
                { value: 'awaiting-regrade', label: 'Awaiting regrade' },
              ].map((recheckFilter) => (
                <button
                  key={recheckFilter.value}
                  type="button"
                  aria-pressed={filter === recheckFilter.value}
                  onClick={() => { setFilter(recheckFilter.value); setCurrentIndex(0); }}
                  className={cn(PILL, 'h-7', filter === recheckFilter.value ? PILL_ON : PILL_OFF)}
                >
                  {recheckFilter.label}
                </button>
              ))}
            </div>
          </div>
          {features.review_scale_v2 && (
            <select value={filter} onChange={(event) => { setFilter(event.target.value); setCurrentIndex(0); }} className={cn(SELECT, 'hidden shrink-0 md:block')} aria-label="Review queue filter">
              <option value="pending">Pending</option>
              <option value="complete">Complete</option>
              <option value="flagged">Flagged</option>
              <option value="harsh-zeros">Harsh zeros</option>
              <option value="rechecks">Rechecks</option>
              <option value="student-rechecks">Student requests</option>
              <option value="teacher-rechecks">Teacher requests</option>
              <option value="awaiting-regrade">Awaiting regrade</option>
              <option value="edited-awaiting-regrade">Edited awaiting regrade</option>
              <option value="low-confidence">Low confidence</option>
              <option value="all">All questions</option>
            </select>
          )}
          {features.review_scale_v2 && (
            <div className="flex h-9 w-full items-center gap-2 rounded-[10px] border border-input bg-card px-3 focus-within:ring-2 focus-within:ring-ring lg:w-72 lg:shrink-0">
              <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <input value={search} onChange={(event) => { setSearch(event.target.value); setCurrentIndex(0); }} aria-label="Search the review queue" placeholder="Search student, question number, topic, or question text" className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground" />
              {search && <button type="button" onClick={() => setSearch('')} className="text-[13px] font-semibold text-action hover:underline">Clear</button>}
            </div>
          )}
        </div>
        {headerBanners}
      </div>

      {/* Panels: each scrolls on its own on md+ */}
      <div className="mx-auto flex w-full max-w-[1600px] md:min-h-0 md:flex-1">
        {/* Left sidebar: Students + Question nav */}
        <aside aria-label="Students" className="hidden w-64 shrink-0 flex-col overflow-y-auto border-r border-border bg-card md:flex xl:w-72">
          {/* The question grid gets at most about half the height so the roster stays reachable */}
          <div className="max-h-[48%] shrink-0 overflow-y-auto">
          <StudentQuestionGrid
            student={selectedStudentData}
            questions={studentQuestions}
            current={current}
            filter={questionNavFilter}
            onFilterChange={setQuestionNavFilter}
            onSelect={jumpToQuestion}
            onApproveAll={canApproveAll ? approveAllForStudent : null}
            approvingAll={approvingAll}
          />
          </div>

          {/* Student list */}
          <div className="flex min-h-[18rem] flex-1 flex-col p-3">
            <div className="mb-2 flex items-center gap-2">
              <UserCheck className="h-4 w-4 text-foreground-secondary" aria-hidden="true" />
              <span className="text-[13px] font-bold text-foreground">Students</span>
              <span className="ml-auto text-xs font-semibold text-muted-foreground tabular-nums">{students.length}</span>
            </div>
            <RosterSearch
              searchTerm={rosterSearchTerm}
              onSearchChange={setRosterSearchTerm}
              sortMode={rosterSortMode}
              onSortChange={setRosterSortMode}
              studentCount={filterAndSortStudents(students, rosterSearchTerm, rosterSortMode).length}
            />
            <div className="-mr-1 min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
              {filterAndSortStudents(students, rosterSearchTerm, rosterSortMode).map(s => (
                <StudentRosterCard
                  key={s.studentId}
                  student={s}
                  isSelected={selectedStudent === s.studentId}
                  onSelect={() => { setSelectedStudent(s.studentId); setQuestionNavFilter('all'); setCurrentIndex(0); }}
                />
              ))}
            </div>
          </div>

        </aside>

        {/* Main content area */}
        <div className="min-w-0 flex-1 px-4 pt-4 pb-24 sm:px-6 md:overflow-y-auto md:pb-0" ref={scrollRef}>
          {filteredItems.length === 0 ? (
            <div className="py-16 text-center">
              <CheckCircle className="mx-auto mb-4 h-12 w-12 text-success" aria-hidden="true" />
              <p className="font-headline text-xl font-bold text-foreground">{filter === 'pending' ? 'All reviews complete!' : filter === 'rechecks' ? 'No recheck requests' : filter === 'harsh-zeros' ? 'No harsh zeros' : 'No items'}</p>
              {selectedStudent && (
                <Button type="button" variant="secondary" onClick={() => { setSelectedStudent(null); setCurrentIndex(0); }} className="mt-4">Show all students</Button>
              )}
            </div>
          ) : current ? (
            <>
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(300px,380px)] xl:grid-cols-[minmax(0,1fr)_420px]">
                {/* Left: Answer sheet images, scrolled to the selected answer (#342) */}
                <div className="min-w-0 lg:sticky lg:top-0 lg:self-start">
                  <AnswerSheetPanel
                    testId={current.testId}
                    testStudentId={current.testStudentId || current.studentId}
                    subject={current.subject}
                    pageCount={current.pageCount || 0}
                    location={currentLocation}
                    focusKey={current.id}
                  />
                </div>

                {/* Right: Question context + review */}
                <div className="space-y-3">
                  {gradingCards}

                  {/* Review actions */}
                  <div className={cn(CARD, 'space-y-3 p-4 sm:p-5')}>
                    <h3 className="text-sm font-bold text-foreground">Review Actions</h3>

                    <div className="flex flex-col gap-2 sm:flex-row">
                      <div className="flex-1">
                        <label htmlFor="review-override-marks" className="mb-1 block text-[13px] text-foreground-secondary">Corrected marks (if grade is wrong, enter the right score)</label>
                        <input
                          id="review-override-marks"
                          type="number" step="0.5" min={current.marksMin ?? 0} max={current.marksAllocated}
                          value={overrideMarks}
                          onChange={e => setOverrideMarks(e.target.value)}
                          placeholder={`Leave blank to keep ${current.grade?.marks ?? 0}/${current.grade?.allocated ?? current.marksAllocated}`}
                          className={cn(FIELD, 'tabular-nums')}
                        />
                      </div>
                      <div className="sm:w-44">
                        <p className="mb-1 block text-[13px] text-foreground-secondary">Reviewer Identity</p>
                        <div className="w-full truncate rounded-[10px] border border-border bg-sunken px-3 py-2 text-sm font-semibold text-foreground">
                          {reviewer}
                        </div>
                      </div>
                    </div>

                    <SaveStateBanner
                      status={saving ? 'saving' : current.reviewStatus === 'approved' && !overrideMarks ? 'saved' : overrideMarks ? 'unsaved' : 'idle'}
                      hasOverrides={Boolean(overrideMarks && Number(overrideMarks) !== Number(current.grade?.marks ?? 0))}
                    />


                    {current.reviewStatus === 'approved' && (
                      <div className="flex items-center gap-1.5 text-[13px] font-semibold text-success">
                        <CheckCircle className="h-3.5 w-3.5" aria-hidden="true" /> Approved by {current.reviewedBy}
                      </div>
                    )}
                  </div>
                </div>
              </div>
              {/* Action bar: always visible at the bottom of the panel (md+; phones use MobileActionBar) */}
              <div className="sticky bottom-0 z-10 -mx-4 mt-4 hidden border-t border-border bg-card px-4 py-3 sm:-mx-6 sm:px-6 md:block">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
                  <div className="flex items-center gap-1.5">
                    <Button type="button" variant="secondary" size="icon" onClick={goPrev} disabled={saving || currentIndex === 0} aria-label="Previous question">
                      <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                    </Button>
                    <span className="min-w-[4.5rem] text-center text-sm font-semibold text-foreground-secondary tabular-nums">{currentIndex + 1} / {filteredItems.length}</span>
                    <Button type="button" variant="secondary" size="icon" onClick={goNext} disabled={currentIndex >= filteredItems.length - 1} aria-label="Next question">
                      <ChevronRight className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </div>
                  <p className="hidden text-xs text-muted-foreground xl:block">
                    <kbd className={KBD}>Shift+Enter</kbd> approves and moves on · <kbd className={KBD}>←</kbd> <kbd className={KBD}>→</kbd> move
                  </p>
                  <div className="ml-auto w-full min-w-0 lg:w-auto lg:min-w-[26rem]">
                    <ContextualApproveButton
                      isApproved={current.reviewStatus === 'approved'}
                      hasOverride={Boolean(overrideMarks && Number(overrideMarks) !== Number(current.grade?.marks ?? 0))}
                      isSaving={saving}
                      marks={overrideMarks !== '' ? overrideMarks : (current.grade?.marks ?? 0)}
                      maxMarks={current.grade?.allocated ?? current.marksAllocated ?? 0}
                      onApprove={() => handleSubmit('approved')}
                      onApproveAndNext={() => handleSubmit('approved', { advance: true })}
                      disabled={saving}
                      showHint={false}
                    />
                  </div>
                </div>
              </div>
            </>
          ) : null}
        </div>
      </div>

      <MobileRosterDrawer
        isOpen={mobileRosterOpen}
        onClose={() => setMobileRosterOpen(false)}
        students={students}
        selectedStudent={selectedStudent}
        onSelectStudent={(sid) => { setSelectedStudent(sid); setQuestionNavFilter('all'); setCurrentIndex(0); }}
        searchTerm={rosterSearchTerm}
        onSearchChange={setRosterSearchTerm}
        sortMode={rosterSortMode}
        onSortChange={setRosterSortMode}
        questionNavGrid={
          <StudentQuestionGrid
            student={selectedStudentData}
            questions={studentQuestions}
            current={current}
            filter={questionNavFilter}
            onFilterChange={setQuestionNavFilter}
            onSelect={jumpToQuestion}
            onApproveAll={canApproveAll ? approveAllForStudent : null}
            approvingAll={approvingAll}
          />
        }
      />

      {current && (
        <MobileActionBar
          currentIndex={currentIndex}
          totalItems={filteredItems.length}
          onPrev={goPrev}
          onNext={goNext}
          onApprove={() => handleSubmit('approved', { advance: true })}
          onToggleRoster={() => setMobileRosterOpen((open) => !open)}
          isSaving={saving}
          hasOverride={Boolean(overrideMarks && Number(overrideMarks) !== Number(current.grade?.marks ?? 0))}
          isApproved={current.reviewStatus === 'approved'}
          rosterCount={students.length}
        />
      )}

      {regradeConfirm && (
        <RegradeConfirmDialog
          cohort={regradeConfirm.cohort}
          preview={regradeConfirm.preview}
          loading={regradeConfirm.loading}
          error={regradeConfirm.error}
          onConfirm={() => { const target = regradeConfirm.cohort; setRegradeConfirm(null); runCohortRegrade(target); }}
          onCancel={() => setRegradeConfirm(null)}
          onRefresh={() => openRegradeConfirm(regradeConfirm.cohort)}
        />
      )}
    </div>
  );
}

function ReferencePage({ title, reference }) {
  const asset = `${reference.document}-${reference.page}`;
  const src = `/api/images/reference?asset=${encodeURIComponent(asset)}`;

  return (
    <div>
      <p className="mb-1 text-xs font-semibold text-foreground-secondary">
        {title} · page {reference.page}
      </p>
      <img
        src={src}
        alt={`${title} reference page ${reference.page}`}
        className="max-h-[420px] w-full rounded-lg border border-hairline bg-card object-contain"
      />
    </div>
  );
}

function IntakeReferenceLink({ testId, kind, label }) {
  const href = `/api/images/reference?testId=${encodeURIComponent(testId)}&kind=${encodeURIComponent(kind)}`;
  return <a href={href} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center rounded-lg border border-hairline bg-card px-3 text-[13px] font-semibold text-foreground transition-colors hover:border-hairline-strong hover:bg-paper-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{label}</a>;
}
