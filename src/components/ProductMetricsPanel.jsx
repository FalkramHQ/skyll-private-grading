import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { getProductMetrics } from '../lib/analytics';
import { Card } from './ui/Card';
import { Button } from './ui/Button';
import { Alert } from './ui/Alert';
import Loader from '../components/Loader';

function Stat({ label, value, hint }) {
  return (
    <Card className="flex flex-col gap-0.5 rounded-xl p-4">
      <p className="text-[13px] text-foreground-secondary">{label}</p>
      <p className="font-headline text-[28px] font-extrabold leading-tight tabular-nums text-ink">{value}</p>
      {hint ? <p className="text-[12px] text-muted-foreground">{hint}</p> : null}
    </Card>
  );
}

function pct(rate) {
  if (rate == null || Number.isNaN(Number(rate))) return '—';
  return `${Math.round(Number(rate) * 100)}%`;
}

export default function ProductMetricsPanel() {
  const [metrics, setMetrics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setMetrics(await getProductMetrics());
    } catch (loadError) {
      setError(loadError.message || 'Could not load product metrics');
      setMetrics(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const kpis = metrics?.kpis || {};
  const funnel = metrics?.funnel30d || {};
  const funnel7 = metrics?.funnel7d || {};

  return (
    <section className="mt-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-headline text-[26px] font-extrabold leading-tight text-ink">Product metrics</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            DAU / MAU, retention, and engagement funnel from authenticated product events
            {metrics?.generatedAt ? ` · updated ${new Date(metrics.generatedAt).toLocaleString()}` : ''}.
          </p>
        </div>
        <Button variant="secondary" onClick={load} disabled={loading} className="gap-2">
          {loading ? <Loader size="inline" /> : <RefreshCw size={16} aria-hidden="true" />}
          Refresh
        </Button>
      </div>
      {error ? <Alert variant="destructive" className="mt-4">{error}</Alert> : null}
      {loading && !metrics ? (
        <div className="flex justify-center py-10 text-muted-foreground"><Loader size="inline" /></div>
      ) : metrics ? (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="DAU" value={kpis.dau ?? 0} hint="Unique users · last 24h" />
            <Stat label="WAU" value={kpis.wau ?? 0} hint="Unique users · last 7d" />
            <Stat label="MAU" value={kpis.mau ?? 0} hint="Unique users · last 30d" />
            <Stat label="DAU / MAU" value={kpis.dauMauRatio ?? 0} hint="Stickiness ratio" />
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="D7 retention" value={pct(kpis.retentionD7?.rate)} hint={`${kpis.retentionD7?.retained || 0}/${kpis.retentionD7?.cohortSize || 0} cohort returned`} />
            <Stat label="Report → DNA (7d)" value={pct(funnel7.reportToDna)} hint={`${funnel7.dnaViewed || 0} DNA / ${funnel7.reportViewed || 0} reports`} />
            <Stat label="Logins (30d)" value={funnel.login ?? 0} />
            <Stat label="Hive viewers (30d)" value={funnel.hiveViewed ?? 0} />
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <Card className="rounded-xl p-4">
              <h3 className="font-headline text-lg font-extrabold text-ink">30-day funnel</h3>
              <ul className="mt-2 text-sm text-foreground-secondary">
                <li className="flex justify-between gap-3 border-b border-border py-2">Login <strong className="tabular-nums text-ink">{funnel.login ?? 0}</strong></li>
                <li className="flex justify-between gap-3 border-b border-border py-2">Report viewed <strong className="tabular-nums text-ink">{funnel.reportViewed ?? 0}</strong></li>
                <li className="flex justify-between gap-3 border-b border-border py-2">DNA viewed <strong className="tabular-nums text-ink">{funnel.dnaViewed ?? 0}</strong></li>
                <li className="flex justify-between gap-3 border-b border-border py-2">Hive viewed <strong className="tabular-nums text-ink">{funnel.hiveViewed ?? 0}</strong></li>
                <li className="flex justify-between gap-3 py-2">Report → DNA <strong className="tabular-nums text-ink">{pct(funnel.reportToDna)}</strong></li>
              </ul>
            </Card>
            <Card className="rounded-xl p-4">
              <h3 className="font-headline text-lg font-extrabold text-ink">Events · last 7 days</h3>
              <ul className="mt-2 max-h-56 overflow-auto text-sm text-foreground-secondary">
                {(metrics.events7d || []).length
                  ? metrics.events7d.map((row) => (
                    <li key={row.eventType} className="flex justify-between gap-3 border-b border-border py-2 last:border-b-0">
                      <span className="min-w-0 truncate font-data text-[13px]">{row.eventType}</span>
                      <span className="shrink-0 font-medium tabular-nums text-ink">{row.users} users · {row.events} events</span>
                    </li>
                  ))
                  : <li className="py-2 text-muted-foreground">No events yet.</li>}
              </ul>
            </Card>
          </div>

          {metrics.schoolsMau?.length ? (
            <Card className="mt-4 rounded-xl p-4">
              <h3 className="font-headline text-lg font-extrabold text-ink">MAU by school</h3>
              <ul className="mt-2 grid gap-x-6 text-sm text-foreground-secondary sm:grid-cols-2">
                {metrics.schoolsMau.map((row) => (
                  <li key={row.school} className="flex justify-between gap-3 border-b border-border py-2">
                    <span className="min-w-0 truncate">{row.school}</span>
                    <strong className="tabular-nums text-ink">{row.mau}</strong>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
