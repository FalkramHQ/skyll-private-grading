import { RangeBar } from './ui/RangeBar';
import { StatusBadge } from './ui/StatusBadge';

// Status in words; colour only confirms it.
const STATUS = {
  ready: { status: 'positive', label: 'Ready' },
  developing: { status: 'info', label: 'Developing' },
  at_risk: { status: 'caution', label: 'Practise next' },
  unknown: { status: 'neutral', label: 'Not measured' },
};

export default function ReadinessScore({ readiness, loading, error }) {
  const score = readiness?.score;

  return (
    <section className="rounded-[20px] border-2 border-ink bg-card p-5">
      <h2 className="font-display text-[21px] leading-tight text-foreground">Exam readiness</h2>
      <p className="mt-1 text-sm text-foreground-secondary">Weighted from knowledge-component mastery on likely tested topics.</p>
      {loading && <p className="mt-4 text-sm text-muted-foreground">Calculating…</p>}
      {error && <p className="mt-4 text-sm font-medium text-destructive">{error}</p>}
      {!loading && !error && (
        <div className="mt-4 flex items-start gap-4">
          <div className="flex shrink-0 flex-col items-start">
            <span className="font-display text-[44px] font-extrabold leading-none tracking-[-0.04em] tabular-nums text-foreground">{score == null ? '-' : `${score}%`}</span>
            <span className="mt-1 text-[13px] font-semibold text-foreground-secondary">ready</span>
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm leading-relaxed text-foreground">{readiness?.explanation || 'No readiness data yet.'}</p>
            <p className="mt-2 text-[13px] tabular-nums text-foreground-secondary">
              Known topics: {readiness?.coverage?.knownCount ?? 0}/{readiness?.coverage?.targetCount ?? 0}
            </p>
          </div>
        </div>
      )}
      {readiness?.breakdown?.length > 0 && (
        <ul className="mt-5 divide-y divide-border border-t-[1.5px] border-ink">
          {readiness.breakdown.slice(0, 8).map((row) => {
            const style = STATUS[row.status] || STATUS.unknown;
            return (
              <li key={row.topic} className="py-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate text-sm font-semibold text-foreground">{row.topic}</span>
                  <span className="shrink-0 font-display text-base font-extrabold tabular-nums text-foreground">
                    {row.masteryPct == null ? 'n/a' : `${row.masteryPct}%`}
                  </span>
                </div>
                {row.masteryPct != null && <RangeBar className="mt-2" value={row.masteryPct} label={`${row.topic}: ${row.masteryPct}% mastery`} />}
                <StatusBadge status={style.status} className="mt-2">{style.label}</StatusBadge>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
