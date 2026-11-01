import { Target } from 'lucide-react';
import { RangeBar } from './ui/RangeBar';
import { StatusBadge } from './ui/StatusBadge';
import { groupMasteryBySubject, normalizeMasteryRows } from '../lib/mastery';

// Rendered on student and teacher pages, so it stays at the quiet volume.
const STATUS_STYLE = {
  ready: { label: 'Ready', status: 'positive' },
  developing: { label: 'Developing', status: 'info' },
  at_risk: { label: 'At risk', status: 'caution' },
};

function MasteryRow({ row }) {
  const style = STATUS_STYLE[row.status] || STATUS_STYLE.developing;
  return (
    <div className="py-3">
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 truncate text-[15px] font-semibold text-foreground">{row.kcLabel}</p>
        <span className="shrink-0 font-display text-base font-extrabold tabular-nums text-foreground">{row.pct}%</span>
      </div>
      {/* Estimate marker + 95% credible-interval band */}
      <RangeBar
        className="mt-2"
        value={row.pct}
        low={row.hasCi ? row.ciLow * 100 : undefined}
        high={row.hasCi ? row.ciHigh * 100 : undefined}
        label={`${row.kcLabel}: ${row.pct}% mastery${row.hasCi ? `, 95% CI ${Math.round(row.ciLow * 100)}–${Math.round(row.ciHigh * 100)}%` : ', gathering evidence'}`}
      />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        {row.wide ? (
          <StatusBadge status="neutral">Gathering evidence</StatusBadge>
        ) : (
          <StatusBadge status={style.status}>{style.label}</StatusBadge>
        )}
        <span className="text-[13px] tabular-nums text-foreground-secondary">{row.evidenceCount} piece{row.evidenceCount === 1 ? '' : 's'} of evidence</span>
      </div>
    </div>
  );
}

/** Accepts rows in route shape OR normalized shape; internally normalized via `normalizeMasteryRows`. */
export default function MasteryPanel({ rows, loading = false }) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const normalized = normalizeMasteryRows(safeRows);
  const groups = groupMasteryBySubject(normalized);
  return (
    <section className="rounded-2xl border border-border bg-card p-5 sm:p-7">
      <div className="flex items-start gap-3">
        <Target aria-hidden="true" className="mt-0.5 h-5 w-5 text-ink" />
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-lg text-foreground">Knowledge mastery</h2>
          <p className="mt-1 text-sm text-foreground-secondary">Measured per knowledge component from graded evidence · the shaded band shows the 95% credible interval</p>
        </div>
      </div>
      {loading ? (
        <p className="mt-4 text-sm text-muted-foreground">Measuring knowledge components…</p>
      ) : !safeRows.length ? (
        <p className="mt-4 text-sm text-muted-foreground">
          No measured knowledge components yet. Mastery appears after graded exams are analysed - we never estimate without evidence.
        </p>
      ) : (
        <div className="mt-4 space-y-5">
          {groups.map((group) => (
            <div key={group.subject}>
              <p className="text-[13px] font-bold text-foreground-secondary">{group.subject}</p>
              <div className="divide-y divide-border">
                {group.rows.slice(0, 12).map((row) => <MasteryRow key={row.kcId} row={row} />)}
              </div>
              {group.rows.length > 12 && (
                <p className="mt-1 text-[13px] text-muted-foreground">+{group.rows.length - 12} more knowledge component{group.rows.length - 12 === 1 ? '' : 's'}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
