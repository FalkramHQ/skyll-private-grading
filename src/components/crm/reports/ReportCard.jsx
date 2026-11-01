// ReportCard / ReportCardItem — presentation primitives for the CRM reports
// hub and the student profile ProgressCard expansion. They consume the
// server-validated report DTOs from /api/auth/crm/reports and keep no data
// logic of their own.

import { memo, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { Badge } from '../../ui/Badge';
import { Skeleton } from '../../ui/Skeleton';

function pctOf(score, max) {
  if (score === null || max === null || max === 0) return null;
  return Math.round((score / max) * 100);
}

function gradeFor(pct) {
  if (pct === null) return null;
  if (pct >= 90) return { letter: 'A', bg: 'bg-success-soft', text: 'text-success-soft-foreground' };
  if (pct >= 80) return { letter: 'B', bg: 'bg-success-soft', text: 'text-success-soft-foreground' };
  if (pct >= 70) return { letter: 'C', bg: 'bg-info', text: 'text-info' };
  if (pct >= 50) return { letter: 'D', bg: 'bg-warning-soft', text: 'text-warning-soft-foreground' };
  return { letter: 'E', bg: 'bg-warning-soft', text: 'text-warning-soft-foreground' };
}

export const ReportCard = memo(function ReportCard({
  item,
  compact = true,
  onClick,
  showHeader = true,
}) {
  const [hover, setHover] = useState(false);
  if (!item) return null;

  const p = pctOf(item.score, item.maxMarks);
  const g = gradeFor(p);
  const showGrade = compact && p !== null;
  const hasScore = item.score !== null && item.maxMarks !== null;

  return (
    <div
      className={cn(
        'group relative rounded-xl border border-border bg-card p-4 transition-all',
        onClick &&
          'cursor-pointer hover:border-action hover:bg-paper-soft hover:shadow-[0_0_0_1px_var(--action)]',
        !compact && 'p-5',
        item.className
      )}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={(e) => {
        if (onClick && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onClick();
        }
      }}
    >
      {showHeader && (
        <div className={cn('mb-3 flex items-start justify-between gap-2', compact && 'mb-2.5')}>
          <div className="min-w-0">
            <p className={cn('truncate font-headline font-bold text-ink', compact ? 'text-base' : 'text-lg')}>
              {item.examName}
            </p>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {item.subject && (
                <span className="text-xs text-muted-foreground">{item.subject}</span>
              )}
              {item.batchName && (
                <span className="text-xs text-muted-foreground">• {item.batchName}</span>
              )}
              {item.date && (
                <span className="text-xs text-muted-foreground">
                  • {new Date(item.date).toLocaleDateString()}
                </span>
              )}
            </div>
          </div>
          {hasScore && !showGrade && (
            <span className="tabular-nums text-sm font-semibold text-ink">
              {item.score}/{item.maxMarks}
            </span>
          )}
        </div>
      )}

      <div className="flex items-center gap-3">
        {showGrade && (
          <span
            className={cn(
              'flex h-9 w-9 items-center justify-center rounded-full text-sm font-bold shadow-sm',
              g.bg,
              g.text
            )}
            aria-label={`Score ${p}%`}
          >
            {g.letter}
          </span>
        )}
        {hasScore && (
          <span className="tabular-nums font-semibold text-ink">
            {item.score}/{item.maxMarks}
          </span>
        )}
        {p !== null && (
          <span className="text-xs text-muted-foreground">{p}%</span>
        )}
        {item.reviewPending && (
          <Badge variant="warning" className="shrink-0">
            Review pending
          </Badge>
        )}
        {!item.reportPublished && (
          <Badge variant="secondary" className="shrink-0">
            Not published
          </Badge>
        )}
        {onClick && (
          <ArrowRight
            className={cn(
              'ml-auto h-4 w-4 shrink-0 text-muted-foreground transition-transform',
              hover ? 'translate-x-0.5 text-action' : ''
            )}
            aria-hidden="true"
          />
        )}
      </div>

      {item.caveat && (
        <p className="mt-3 text-xs text-muted-foreground line-clamp-2">{item.caveat}</p>
      )}
    </div>
  );
});

ReportCard.Skeleton = function ReportCardSkeleton({ rows = 3 }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="rounded-xl border border-border bg-card p-4">
          <Skeleton className="mb-2 h-5 w-40" />
          <Skeleton className="mb-3 h-3.5 w-3/4" />
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-8 rounded-full" />
            <Skeleton className="h-5 w-16" />
          </div>
        </div>
      ))}
    </div>
  );
};

export const ReportCardItem = memo(function ReportCardItem({ item, onClick }) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-card p-2.5',
        onClick &&
          'cursor-pointer hover:border-action hover:bg-paper-soft',
        item.className
      )}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={(e) => {
        if (onClick && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-ink">{item.studentName}</p>
        <p className="truncate text-xs text-muted-foreground">
          {item.examName}
          {item.subject && ` · ${item.subject}`}
          {item.batchName && ` · ${item.batchName}`}
        </p>
      </div>
      <span className="tabular-nums text-sm font-semibold text-ink">
        {item.score !== null && item.maxMarks !== null ? `${item.score}/${item.maxMarks}` : '—'}
      </span>
      {item.reviewPending && <Badge variant="warning" className="shrink-0">Review pending</Badge>}
      {!item.reportPublished && <Badge variant="secondary" className="shrink-0">Not published</Badge>}
      {onClick && (
        <ArrowRight
          className={cn(
            'h-4 w-4 text-muted-foreground transition-transform hover:translate-x-0.5',
            onClick && 'hover:text-action'
          )}
          aria-hidden="true"
        />
      )}
    </div>
  );
});
