import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { LEARNING_MODES } from '../lib/learnerDna';
import { getHiveClass } from '../lib/db';
import Loader from '../components/Loader';

const modeLabel = (id) => LEARNING_MODES.find((mode) => mode.id === id)?.label?.replace(/^The /, '') || id || '-';

const STATUS_TONE = {
  ready: { label: 'Ready', className: 'bg-success-soft text-success-soft-foreground' },
  developing: { label: 'Developing', className: 'bg-warning-soft text-warning-soft-foreground' },
  at_risk: { label: 'At risk', className: 'bg-destructive-soft text-destructive-soft-foreground' },
};

// Percentage chip: the status word travels with it for screen readers.
function TopicPct({ row }) {
  const tone = STATUS_TONE[row.status] || { label: '', className: 'bg-sunken text-foreground-secondary' };
  return (
    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[12px] font-bold tabular-nums ${tone.className}`} title={tone.label || undefined}>
      {row.avgPct}%{tone.label && <span className="sr-only"> · {tone.label}</span>}
    </span>
  );
}

const LABEL = 'text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground';

export default function ClassHivePanel({ className = '' }) {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError('');
      try {
        const payload = await getHiveClass({ className: className || undefined });
        if (!cancelled) setData(payload);
      } catch (err) {
        if (!cancelled) setError(err.message || 'Could not load class Hive');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [className]);

  if (loading) {
    return (
      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="flex items-center gap-2 text-sm text-foreground-secondary">
          <Loader size="inline" className="text-ink" />
          Loading class Hive…
        </div>
      </section>
    );
  }

  if (error || !data) {
    return null;
  }

  if ((data.totals?.dnaProfiles || 0) === 0) {
    return (
      <section className="rounded-2xl border border-border bg-card p-5">
        <h3 className="font-headline text-lg font-extrabold text-ink">Class Hive</h3>
        <p className="mt-1 text-[13px] leading-relaxed text-foreground-secondary">
          No DNA profiles for this class yet. Class Hive builds once deep-signal
          extraction runs on graded answers - profiles appear after the next grading
          or Hive synthesis run. If this persists, deep-signal extraction may not be
          enabled for your school.
        </p>
      </section>
    );
  }

  const maxPrimary = Math.max(1, ...(data.primaryModes || []).map((row) => row.count));
  const weakTopics = data.mastery?.weakest || [];
  const strongTopics = data.mastery?.strongest || [];

  return (
    <section className="rounded-2xl border border-border bg-card p-5">
      <h3 className="font-headline text-lg font-extrabold text-ink">Class Hive</h3>
      <p className="mt-0.5 text-[13px] tabular-nums text-foreground-secondary">
        {data.totals.dnaProfiles} DNA profile{data.totals.dnaProfiles === 1 ? '' : 's'}
        {className ? ` · Class ${className}` : ''}
        {' · '}
        {data.totals.activeSignals} active signal{data.totals.activeSignals === 1 ? '' : 's'}
        {data.totals.topicsTracked ? ` · ${data.totals.topicsTracked} topics` : ''}
      </p>

      <div className="mt-4 flex flex-col gap-2">
        <p className={LABEL}>Primary modes</p>
        {(data.primaryModes || []).length === 0 ? (
          <p className="text-[13px] text-muted-foreground">No primary modes recorded yet.</p>
        ) : (
          data.primaryModes.map((row) => (
            <div key={row.modeId} className="flex items-center gap-3">
              <span className="w-24 shrink-0 truncate text-[13px] font-medium text-foreground-secondary">{modeLabel(row.modeId)}</span>
              <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-sunken">
                <div
                  className="h-full rounded-full bg-chart-1"
                  style={{ width: `${Math.round((row.count / maxPrimary) * 100)}%` }}
                />
              </div>
              <span className="w-6 text-right text-[13px] font-semibold tabular-nums text-ink">{row.count}</span>
            </div>
          ))
        )}
      </div>

      {(weakTopics.length > 0 || strongTopics.length > 0) && (
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <div>
            <p className={LABEL}>Class weak topics</p>
            <ul className="mt-1.5">
              {weakTopics.length === 0 ? (
                <li className="text-[13px] text-muted-foreground">No at-risk topics yet.</li>
              ) : weakTopics.map((row) => (
                <li key={row.topic} className="border-b border-border py-2 last:border-b-0">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-[13px] font-semibold text-ink">{row.topic}</p>
                    <TopicPct row={row} />
                  </div>
                  <p className="mt-0.5 text-[12px] tabular-nums text-muted-foreground">
                    {row.studentCount} student{row.studentCount === 1 ? '' : 's'} · {row.evidenceCount} evidence
                  </p>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className={LABEL}>Class strengths</p>
            <ul className="mt-1.5">
              {strongTopics.length === 0 ? (
                <li className="text-[13px] text-muted-foreground">No strong topics yet.</li>
              ) : strongTopics.slice(0, 6).map((row) => (
                <li key={row.topic} className="border-b border-border py-2 last:border-b-0">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-[13px] font-semibold text-ink">{row.topic}</p>
                    <TopicPct row={row} />
                  </div>
                  <p className="mt-0.5 text-[12px] tabular-nums text-muted-foreground">
                    {row.studentCount} student{row.studentCount === 1 ? '' : 's'}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {data.students?.length > 0 && (
        <div className="mt-5 flex flex-col gap-2">
          <p className={LABEL}>Recent profiles</p>
          {data.students.slice(0, 6).map((student) => (
            <button
              key={student.studentId}
              type="button"
              onClick={() => {
                if (!student.username) return;
                navigate(`/hive?student=${encodeURIComponent(student.username)}`);
              }}
              className="flex min-h-11 w-full items-center justify-between gap-2 rounded-xl border border-border px-3 py-2 text-left transition-colors hover:border-hairline-strong hover:bg-paper-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <div className="min-w-0">
                <p className="truncate text-[13px] font-semibold text-ink">{student.name || student.username}</p>
                <p className="truncate text-[12px] text-foreground-secondary">
                  {modeLabel(student.primaryMode)} → grow {modeLabel(student.growthEdge)}
                </p>
              </div>
              <ChevronRight className="h-4 w-4 shrink-0 text-faint" aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
