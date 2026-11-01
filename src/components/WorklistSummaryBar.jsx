import React from 'react';
import { AlertCircle, RefreshCw, CheckCircle2 } from 'lucide-react';
import Loader from '../components/Loader';

export function getWorklistSummaryStats(cohorts = []) {
  let attentionCount = 0;
  let regradeCount = 0;
  let completedCount = 0;
  let totalQuestions = 0;
  let reviewedQuestions = 0;

  for (const cohort of cohorts) {
    const isQueued = cohort.cohortStatus?.status === 'regrade_queued' || cohort.status === 'regrade_queued';
    const hasChanges = Number(cohort.changedQuestions || 0) > 0 || isQueued;
    const isPending = Number(cohort.pending || 0) > 0;
    
    totalQuestions += Number(cohort.totalQuestions || 0);
    reviewedQuestions += Number(cohort.approved ?? cohort.reviewedQuestions ?? 0);

    if (isPending) {
      attentionCount += 1;
    }
    if (hasChanges) {
      regradeCount += 1;
    }
    if (!isPending && !hasChanges) {
      completedCount += 1;
    }
  }

  const overallProgress = totalQuestions > 0 ? Math.round((reviewedQuestions / totalQuestions) * 100) : 0;

  return { attentionCount, regradeCount, completedCount, totalQuestions, reviewedQuestions, overallProgress };
}

const FILTER_BASE =
  'inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const FILTER_IDLE = 'border-hairline bg-card text-foreground-secondary hover:border-hairline-strong hover:bg-paper-soft';

export default function WorklistSummaryBar({ cohorts = [], onFilterSelect, currentStatus = 'all' }) {
  const stats = getWorklistSummaryStats(cohorts);

  return (
    <div className="mb-6 rounded-2xl border border-border bg-card p-4 sm:p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <h2 className="font-headline text-lg font-bold tracking-tight text-foreground">
            Teacher Review Worklist
          </h2>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
            <div
              role="progressbar"
              aria-label="Answers reviewed"
              aria-valuenow={stats.overallProgress}
              aria-valuemin={0}
              aria-valuemax={100}
              className="h-2.5 w-full shrink-0 overflow-hidden rounded-full border border-ink bg-sunken sm:w-48"
            >
              <div
                className="h-full bg-lime"
                style={{ width: `${stats.overallProgress}%` }}
              />
            </div>
            <p className="text-[13px] text-muted-foreground tabular-nums">
              {stats.reviewedQuestions} of {stats.totalQuestions} total student answers reviewed ({stats.overallProgress}% overall completion)
            </p>
          </div>
        </div>

        <div role="group" aria-label="Filter worklist" className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            aria-pressed={currentStatus === 'needs-review'}
            onClick={() => onFilterSelect && onFilterSelect('needs-review')}
            className={`${FILTER_BASE} ${
              currentStatus === 'needs-review'
                ? 'border-ink bg-warning-soft text-warning-soft-foreground font-bold'
                : FILTER_IDLE
            }`}
          >
            <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
            <span><strong className="tabular-nums">{stats.attentionCount}</strong> need attention</span>
          </button>

          <button
            type="button"
            aria-pressed={currentStatus === 'regrade-pending'}
            onClick={() => onFilterSelect && onFilterSelect('regrade-pending')}
            className={`${FILTER_BASE} ${
              currentStatus === 'regrade-pending'
                ? 'border-ink bg-info-soft text-info font-bold'
                : FILTER_IDLE
            }`}
          >
            {stats.regradeCount > 0 ? (
              <Loader size="inline" className="flex-shrink-0" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
            )}
            <span><strong className="tabular-nums">{stats.regradeCount}</strong> regrading</span>
          </button>

          <button
            type="button"
            aria-pressed={currentStatus === 'completed'}
            onClick={() => onFilterSelect && onFilterSelect('completed')}
            className={`${FILTER_BASE} ${
              currentStatus === 'completed'
                ? 'border-ink bg-success-soft text-success-soft-foreground font-bold'
                : FILTER_IDLE
            }`}
          >
            <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
            <span><strong className="tabular-nums">{stats.completedCount}</strong> completed</span>
          </button>
        </div>
      </div>
    </div>
  );
}
