import { Button } from './ui/Button';

function PriorityCard({ label, index, item }) {
  if (!item) return null;
  return (
    <article className="flex gap-3 rounded-2xl border border-border bg-paper-soft px-4 py-3.5">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 border-ink bg-card font-display text-sm font-extrabold tabular-nums text-ink" aria-hidden="true">{index}</span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-bold text-foreground-secondary">{label}</p>
        <h3 className="mt-0.5 font-display text-base leading-snug text-foreground">{item.topic}</h3>
        <p className="mt-1 text-sm leading-relaxed text-foreground-secondary">{item.reason}</p>
        <div className="mt-2 flex flex-wrap gap-1.5 text-[13px] text-foreground-secondary">
          {item.estimated_time && <span className="rounded-full border border-border bg-card px-2.5 py-0.5 font-semibold text-foreground">{item.estimated_time}</span>}
          {(item.evidence_qids || []).slice(0, 4).map((qid) => (
            <span key={qid} className="rounded-full border border-border bg-card px-2.5 py-0.5">{qid}</span>
          ))}
        </div>
        {(item.resources || []).length > 0 && (
          <p className="mt-2 text-[13px] text-foreground-secondary">Resources: {item.resources.join(' · ')}</p>
        )}
      </div>
    </article>
  );
}

export default function RevisionPlan({ plan, loading, error, onGenerate }) {
  return (
    <section className="rounded-[20px] border-2 border-ink bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-[21px] leading-tight text-foreground">Revision plan</h2>
          <p className="mt-1 text-sm text-foreground-secondary">Prioritized from your gaps and Learning DNA.</p>
        </div>
        {onGenerate && (
          <Button
            type="button"
            disabled={loading}
            onClick={onGenerate}
            className="h-11 px-4 text-sm"
          >
            {loading ? 'Building…' : plan ? 'Refresh plan' : 'Create plan'}
          </Button>
        )}
      </div>
      {error && <p className="mt-3 text-sm font-medium text-destructive">{error}</p>}
      {!plan && !loading && !error && (
        <p className="mt-4 text-sm text-muted-foreground">Generate a plan when you want a focused study order.</p>
      )}
      {plan && (
        <div className="mt-4 space-y-3">
          <PriorityCard label="Priority 1" index={1} item={plan.priority_1} />
          <PriorityCard label="Priority 2" index={2} item={plan.priority_2} />
          <PriorityCard label="Priority 3" index={3} item={plan.priority_3} />
          <div className="rounded-2xl bg-info-soft px-4 py-3 text-sm text-foreground">
            <p><span className="font-semibold">Total time:</span> {plan.total_study_time}</p>
            <p className="mt-1"><span className="font-semibold">Leverage:</span> {plan.strength_to_leverage}</p>
          </div>
        </div>
      )}
    </section>
  );
}
