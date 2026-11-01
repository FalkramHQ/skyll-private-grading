import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CircleHelp, RefreshCw, Server, Users } from 'lucide-react';
import Loader from '../components/Loader';
import { Button } from './ui/Button';
import { StatusBadge } from './ui/StatusBadge';

const STATUS_ORDER = { critical: 0, warning: 1, unknown: 2, healthy: 3, inactive: 4 };

const STATUS_STYLE = {
  healthy: { label: 'Healthy', status: 'positive', tile: 'border-border' },
  warning: { label: 'Warning', status: 'caution', tile: 'border-warning/40 bg-warning-soft text-warning-soft-foreground' },
  critical: { label: 'Critical', status: 'critical', tile: 'border-destructive/40 bg-destructive-soft text-destructive-soft-foreground' },
  unknown: { label: 'Unknown', status: 'neutral', icon: CircleHelp, tile: 'border-border' },
  inactive: { label: 'Inactive', status: 'neutral', icon: CircleHelp, tile: 'border-border' },
};

function formatDate(value) {
  if (!value) return 'Not checked yet';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Recently checked' : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function HealthBadge({ status }) {
  const style = STATUS_STYLE[status] || STATUS_STYLE.unknown;
  return <StatusBadge status={style.status} icon={style.icon} className="shrink-0">{style.label}</StatusBadge>;
}

function HealthItem({ item, type }) {
  const isClass = type === 'class';
  return <article className="rounded-xl border border-border bg-card p-4">
    <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><p className="text-[15px] font-bold text-ink">{item.name}</p><p className="mt-0.5 text-[13px] text-foreground-secondary">{isClass ? `${item.school || 'School not recorded'} · ${item.grade || 'Grade not recorded'} · ${item.studentCount} active student${item.studentCount === 1 ? '' : 's'}` : item.source === 'recent_job' ? 'Based on recent processing work' : item.source === 'heartbeat' ? 'Based on the worker heartbeat' : 'Live service check'}</p></div><HealthBadge status={item.status} /></div>
    <p className="mt-2.5 text-sm leading-6 text-foreground-secondary">{item.detail}</p>
    {!isClass && <p className="mt-2 text-[12px] tabular-nums text-muted-foreground">Last checked: {formatDate(item.lastCheckedAt)}</p>}
  </article>;
}

function Summary({ label, value, status }) {
  const style = STATUS_STYLE[status] || STATUS_STYLE.unknown;
  const attention = value > 0 && (status === 'warning' || status === 'critical');
  return <div className={`flex flex-col gap-0.5 rounded-xl border p-3.5 ${attention ? style.tile : 'border-border'}`}><p className="font-headline text-[28px] font-extrabold leading-tight tabular-nums">{value}</p><p className={`text-[13px] ${attention ? 'font-semibold' : 'text-foreground-secondary'}`}>{label}</p></div>;
}

function SubHeading({ icon: Icon, title, description }) {
  return <div className="flex items-start gap-2"><Icon size={18} className="mt-0.5 shrink-0 text-foreground-secondary" aria-hidden="true" /><div><h3 className="font-headline text-lg font-extrabold text-ink">{title}</h3><p className="text-sm text-foreground-secondary">{description}</p></div></div>;
}

export default function SystemHealthPanel() {
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/auth/health', { credentials: 'same-origin' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Could not load system health.');
      setHealth(payload);
    } catch (requestError) {
      setError(requestError.message || 'Could not load system health.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const services = useMemo(() => [...(health?.services || [])].sort((left, right) => (STATUS_ORDER[left.status] ?? 99) - (STATUS_ORDER[right.status] ?? 99) || left.name.localeCompare(right.name)), [health]);
  const classes = useMemo(() => [...(health?.classes || [])].sort((left, right) => (STATUS_ORDER[left.status] ?? 99) - (STATUS_ORDER[right.status] ?? 99) || left.name.localeCompare(right.name)), [health]);
  const needsAttention = useMemo(() => [...services, ...classes].filter((item) => ['critical', 'warning'].includes(item.status)), [services, classes]);
  const overall = STATUS_STYLE[health?.overallStatus] || STATUS_STYLE.unknown;

  return <section className="rounded-2xl border border-border bg-card p-5 sm:p-7" aria-labelledby="system-health-heading">
    <div className="flex flex-wrap items-start justify-between gap-4"><div className="min-w-0"><h2 id="system-health-heading" className="font-headline text-[26px] font-extrabold leading-tight text-ink">System health</h2><p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-foreground-secondary"><span>Overall status:</span> {health ? <HealthBadge status={health.overallStatus} /> : <span className="font-semibold">{overall.label}</span>}<span>· Last updated {formatDate(health?.generatedAt)}</span></p></div><Button type="button" variant="secondary" onClick={load} disabled={loading} className="gap-2">{loading ? <Loader size="inline" /> : <RefreshCw size={16} aria-hidden="true" />}Refresh health</Button></div>
    {error && <p role="alert" className="mt-5 rounded-xl bg-destructive-soft p-3 text-sm text-destructive">{error}</p>}
    {loading && !health ? <div className="flex justify-center py-12 text-muted-foreground"><Loader /></div> : health && <>
      <div className="mt-6 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5"><Summary label="Healthy" value={health.summary?.healthy || 0} status="healthy" /><Summary label="Warnings" value={health.summary?.warning || 0} status="warning" /><Summary label="Critical" value={health.summary?.critical || 0} status="critical" /><Summary label="Unknown" value={health.summary?.unknown || 0} status="unknown" /><Summary label="Inactive" value={health.summary?.inactive || 0} status="inactive" /></div>
      <div className="mt-8 grid gap-8 xl:grid-cols-2"><div><SubHeading icon={AlertTriangle} title="Health alerts" description="Critical and warning items appear first." />{needsAttention.length ? <div className="mt-4 grid gap-3">{needsAttention.map((item) => <HealthItem key={`${item.id}-${item.name}`} item={item} type={item.studentCount === undefined ? 'service' : 'class'} />)}</div> : <p className="mt-4 rounded-xl border border-dashed border-hairline-strong p-4 text-sm text-muted-foreground">No classes or services currently need attention.</p>}</div>
        <div><SubHeading icon={Server} title="Services" description="Unknown means no safe signal is available yet." /><div className="mt-4 grid gap-3">{services.map((item) => <HealthItem key={item.id} item={item} type="service" />)}</div></div></div>
      <div className="mt-8"><SubHeading icon={Users} title="Classes" description="Active classes are checked for roster and metadata completeness." />{classes.length ? <div className="mt-4 grid gap-3 lg:grid-cols-2">{classes.map((item) => <HealthItem key={item.id} item={item} type="class" />)}</div> : <p className="mt-4 rounded-xl border border-dashed border-hairline-strong p-4 text-sm text-muted-foreground">No classes are visible for this account.</p>}</div>
    </>}
  </section>;
}
