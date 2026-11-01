import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  Brain,
  Compass,
  RefreshCw,
  Target,
} from 'lucide-react';
import DnaBadge from '../components/DnaBadge';
import MasteryPanel from '../components/MasteryPanel';
import { LEARNING_MODES, normalizeLearnerDna } from '../lib/learnerDna';
import { track } from '../lib/analytics';
import { getMastery, normalizeMasteryRows } from '../lib/mastery';
import { getHive, requestHiveSynthesis } from '../lib/db';
import Loader from '../components/Loader';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { StatusBadge } from '../components/ui/StatusBadge';

// Each learning-mode state carries a word and an icon; colour only confirms it.
// "Build next" is the coral "next up" accent, never an error.
const STATE_STYLE = {
  secure: { label: 'Secure', status: 'positive', node: 'fill-success' },
  developing: { label: 'Developing', status: 'caution', node: 'fill-warning' },
  needs_practice: { label: 'Build next', status: 'neutral', badgeClass: 'bg-coral text-ink', icon: Target, node: 'fill-coral' },
  not_observed: { label: 'Not measured', status: 'neutral', node: 'fill-faint' },
};

function StateBadge({ state }) {
  const style = STATE_STYLE[state] || STATE_STYLE.not_observed;
  return <StatusBadge status={style.status} icon={style.icon} className={style.badgeClass}>{style.label}</StatusBadge>;
}

function modePositions(count, radius = 118) {
  return Array.from({ length: count }, (_, index) => {
    const angle = (-Math.PI / 2) + (index / count) * Math.PI * 2;
    return { x: 160 + Math.cos(angle) * radius, y: 160 + Math.sin(angle) * radius };
  });
}

function Constellation({ dimensions, primaryId, growthId }) {
  const positions = modePositions(LEARNING_MODES.length);
  const byId = new Map((dimensions || []).map((dim) => [dim.id, dim]));

  return (
    <svg viewBox="0 0 320 320" className="mx-auto h-auto w-full max-w-md" role="img" aria-label="Learning mode constellation">
      <circle cx="160" cy="160" r="148" className="fill-paper-soft stroke-hairline" strokeWidth="1" />
      {positions.map((point, index) => {
        const next = positions[(index + 1) % positions.length];
        return (
          <line
            key={`edge-${index}`}
            x1={point.x}
            y1={point.y}
            x2={next.x}
            y2={next.y}
            className="stroke-hairline-strong"
            strokeWidth="1"
            strokeDasharray="3 4"
          />
        );
      })}
      {positions.map((point) => (
        <line key={`spoke-${point.x}`} x1="160" y1="160" x2={point.x} y2={point.y} className="stroke-hairline" strokeWidth="1" />
      ))}
      <circle cx="160" cy="160" r="28" className="fill-ink" />
      <text x="160" y="157" textAnchor="middle" className="fill-lime" fontSize="10" fontWeight="800">HIVE</text>
      <text x="160" y="169" textAnchor="middle" className="fill-white" fontSize="8" opacity="0.75">modes</text>
      {LEARNING_MODES.map((mode, index) => {
        const dim = byId.get(mode.id) || { state: 'not_observed' };
        const style = STATE_STYLE[dim.state] || STATE_STYLE.not_observed;
        const pos = positions[index];
        const isPrimary = mode.id === primaryId;
        const isGrowth = mode.id === growthId;
        const radius = isPrimary ? 18 : isGrowth ? 15 : 12;
        return (
          <g key={mode.id}>
            {(isPrimary || isGrowth) && (
              <circle
                cx={pos.x}
                cy={pos.y}
                r={radius + 6}
                fill="none"
                className="stroke-ink"
                strokeWidth="1.5"
                strokeDasharray={isGrowth && !isPrimary ? '3 3' : undefined}
              />
            )}
            <circle cx={pos.x} cy={pos.y} r={radius} className={`${style.node} stroke-ink`} strokeWidth="1.5" opacity={dim.state === 'not_observed' ? 0.5 : 1} />
            <text x={pos.x} y={pos.y + radius + 13} textAnchor="middle" className="fill-foreground-secondary" fontSize="9" fontWeight="600">
              {mode.label.replace(/^The /, '')}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function SignalCard({ signal }) {
  const pct = signal.marksTotal > 0
    ? Math.round((Number(signal.marksObtained || 0) / Number(signal.marksTotal)) * 100)
    : null;
  return (
    <article className="border-b border-border py-3 last:border-b-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[15px] font-semibold text-ink">
            Q{signal.questionNumber}{signal.topic ? ` · ${signal.topic}` : ''}
          </p>
          <p className="mt-0.5 text-[13px] tabular-nums text-muted-foreground">
            {signal.extractedAt ? new Date(signal.extractedAt).toLocaleString() : 'Extracted'}
            {pct != null ? ` · ${pct}%` : ''}
          </p>
        </div>
        {typeof signal.confidence === 'number' && (
          <span className="shrink-0 rounded-full bg-sunken px-2 py-0.5 text-[12px] font-semibold tabular-nums text-foreground-secondary">
            {Math.round(signal.confidence * 100)}% conf
          </span>
        )}
      </div>
      <dl className="mt-2 grid gap-1 text-[13px] leading-relaxed">
        {signal.strength && <div><dt className="inline font-semibold text-success">Strength: </dt><dd className="inline text-foreground">{signal.strength}</dd></div>}
        {signal.misconception && <div><dt className="inline font-semibold text-warning">Gap: </dt><dd className="inline text-foreground">{signal.misconception}</dd></div>}
        {signal.nextPractice && <div><dt className="inline font-semibold text-foreground-secondary">Next: </dt><dd className="inline text-foreground-secondary">{signal.nextPractice}</dd></div>}
      </dl>
    </article>
  );
}

function DiffViewer({ runs }) {
  const withDiff = (runs || []).filter((run) => run.diff);
  if (!withDiff.length) {
    return (
      <p className="text-sm text-muted-foreground">No synthesis diffs yet. Diffs appear after a successful Hive run.</p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {withDiff.slice(0, 5).map((run) => {
        const diff = run.diff || {};
        return (
          <article key={run.id} className="rounded-xl border border-border px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                {run.status} · {run.triggerSource || 'run'}
              </p>
              <p className="text-[12px] tabular-nums text-muted-foreground">
                {run.completedAt || run.startedAt
                  ? new Date(run.completedAt || run.startedAt).toLocaleString()
                  : ''}
              </p>
            </div>
            <ul className="mt-2 flex flex-col gap-1 text-sm text-foreground-secondary">
              <li>
                Primary mode:{' '}
                {diff.primary_mode_changed
                  ? `${diff.prior_primary_mode || '-'} → ${diff.next_primary_mode || '-'}`
                  : 'unchanged'}
              </li>
              <li>
                Growth edge:{' '}
                {diff.growth_edge_changed
                  ? `${diff.prior_growth_edge || '-'} → ${diff.next_growth_edge || '-'}`
                  : 'unchanged'}
              </li>
              <li>Next move: {diff.next_move_changed ? 'updated' : 'unchanged'}</li>
            </ul>
          </article>
        );
      })}
    </div>
  );
}

export default function Hive() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const studentParam = searchParams.get('student') || searchParams.get('username') || '';
  const role = localStorage.getItem('userRole');
  const staff = ['teacher', 'admin', 'skyll_admin'].includes(role);

  const [payload, setPayload] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [synthBusy, setSynthBusy] = useState(false);
  const [synthMessage, setSynthMessage] = useState('');
  const [masteryRows, setMasteryRows] = useState([]);
  const [masteryLoading, setMasteryLoading] = useState(true);

  const loadHive = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await getHive(studentParam || undefined);
      setPayload(data);
    } catch (err) {
      setError(err.message || 'Could not load Learning Hive');
    } finally {
      setLoading(false);
    }
  }, [studentParam]);

  useEffect(() => { loadHive(); }, [loadHive]);

  useEffect(() => {
    if (!payload) return undefined;
    track('hive_viewed', {
      student: payload?.student?.username || studentParam || null,
      surface: 'web_hive',
    });
    if (payload?.dna) track('dna_viewed', { surface: 'web_hive' });
    return undefined;
  }, [payload, studentParam]);

  useEffect(() => {
    const studentId = payload?.student?.id;
    const username = payload?.student?.username || studentParam;
    if (!studentId && !username) return undefined;
    let cancelled = false;
    setMasteryLoading(true);
    getMastery({ studentId: studentId || undefined, username: username || undefined })
      .then((data) => { if (!cancelled) setMasteryRows(normalizeMasteryRows(data.mastery)); })
      .catch((err) => { if (!cancelled) { console.warn('mastery load failed', err); setMasteryRows([]); } })
      .finally(() => { if (!cancelled) setMasteryLoading(false); });
    return () => { cancelled = true; };
  }, [payload?.student?.id, payload?.student?.username, studentParam]);

  const dna = useMemo(() => normalizeLearnerDna(payload?.dna), [payload]);
  const dimensions = dna?.dimensions || [];
  const primaryId = dna?.primary_mode?.mode_id;
  const growthId = dna?.growth_edge?.mode_id;
  const firstName = (payload?.student?.name || '').split(' ')[0] || 'Learner';

  async function triggerSynthesis() {
    if (!staff) return;
    setSynthBusy(true);
    setSynthMessage('');
    try {
      const result = await requestHiveSynthesis({
        username: payload?.student?.username || studentParam,
        studentId: payload?.student?.id,
      });
      setSynthMessage(result.message || `Queued (${result.jobId})`);
      await loadHive();
    } catch (err) {
      setSynthMessage(err.message || 'Could not queue synthesis');
    } finally {
      setSynthBusy(false);
    }
  }


  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3 text-sm text-foreground-secondary">
          <Loader size="inline" className="text-ink" />
          Opening Learning Hive…
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <Card className="max-w-sm p-6 text-center">
          <h1 className="font-headline text-[21px] font-extrabold text-ink">Hive unavailable</h1>
          <p role="alert" className="mt-2 text-sm text-foreground-secondary">{error}</p>
          <div className="mt-5 flex justify-center gap-3">
            <Button type="button" onClick={loadHive}>Try again</Button>
            <Button type="button" variant="secondary" onClick={() => navigate('/dashboard')}>Dashboard</Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between gap-3 px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <span className="hidden font-headline text-[22px] font-extrabold leading-none tracking-[-0.03em] text-ink sm:inline" aria-hidden="true">
              skyll<span className="text-coral">.</span>
            </span>
            <div className="hidden h-6 w-px bg-border sm:block" />
            <div className="min-w-0">
              <p className="truncate text-[15px] font-semibold text-ink">Learning Hive</p>
              <p className="truncate text-[13px] text-foreground-secondary">
                {payload.student?.name || payload.student?.username}
                {payload.student?.className ? ` · Class ${payload.student.className}` : ''}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button type="button" variant="ghost" size="icon" onClick={loadHive} aria-label="Refresh hive" className="text-foreground-secondary hover:text-foreground">
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
            </Button>
            <Button type="button" variant="ghost" onClick={() => navigate('/dashboard')} className="gap-1.5 px-3 text-sm text-foreground-secondary hover:text-foreground">
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              <span className="hidden sm:inline">Dashboard</span>
              <span className="sr-only sm:hidden">Dashboard</span>
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto flex max-w-5xl flex-col gap-5 px-4 pb-14 pt-7 sm:px-6 sm:pt-9">
        <Card className="grid gap-6 p-5 sm:grid-cols-[1.1fr_0.9fr] sm:p-7">
          <div className="flex flex-col gap-4">
            <div className="flex items-start gap-3">
              {primaryId ? <DnaBadge personaTitle={primaryId} size={56} /> : (
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-sunken text-foreground-secondary">
                  <Brain className="h-5 w-5" aria-hidden="true" />
                </div>
              )}
              <div className="min-w-0">
                <p className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">Evidence constellation</p>
                <h1 className="mt-1 font-headline text-[32px] font-extrabold leading-[1.05] tracking-[-0.03em] text-ink">{firstName}&apos;s Hive</h1>
                <p className="mt-1.5 text-sm text-foreground-secondary">
                  Modes crystallize from question-level signals - not personality labels.
                </p>
              </div>
            </div>
            {dna?.primary_mode && (
              <div className="rounded-xl border border-border px-4 py-3">
                <p className="flex items-center gap-1.5 text-[13px] font-semibold text-foreground-secondary">
                  <Compass className="h-3.5 w-3.5" aria-hidden="true" /> Primary mode
                </p>
                <p className="mt-1 text-[15px] font-bold text-ink">{dna.primary_mode.title}</p>
                <p className="mt-1 text-[13px] leading-relaxed text-foreground-secondary">{dna.primary_mode.description}</p>
              </div>
            )}
            {dna?.growth_edge && (
              <div className="rounded-xl border-[1.5px] border-ink px-4 py-3">
                <p className="flex items-center gap-1.5 text-[13px] font-semibold text-foreground-secondary">
                  <Target className="h-3.5 w-3.5" aria-hidden="true" /> Growth edge
                </p>
                <p className="mt-1 text-[15px] font-bold text-ink">{dna.growth_edge.title}</p>
                <p className="mt-1 text-[13px] leading-relaxed text-foreground-secondary">{dna.growth_edge.action}</p>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    const params = new URLSearchParams();
                    if (studentParam) params.set('student', studentParam);
                    if (dna.growth_edge?.title) params.set('topic', dna.growth_edge.title);
                    navigate(`/practice${params.toString() ? `?${params}` : ''}`);
                  }}
                  className="mt-3 h-9 px-3.5 text-[13px]"
                >
                  Practice this growth edge
                </Button>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Badge variant="secondary" className="tabular-nums">
                {payload.signals?.length || 0} signals
              </Badge>
              <Badge variant="secondary" className="tabular-nums">
                {payload.dnaMeta?.examCount || 0} exams in DNA
              </Badge>
              {payload.features?.deep_signals ? (
                <Badge variant="success">deep signals on</Badge>
              ) : (
                <Badge variant="secondary">legacy DNA path</Badge>
              )}
            </div>
          </div>
          <Constellation dimensions={dimensions} primaryId={primaryId} growthId={growthId} />
        </Card>

        <section aria-label="Learning modes" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {LEARNING_MODES.map((mode) => {
            const dim = dimensions.find((item) => item.id === mode.id) || { state: 'not_observed' };
            return (
              <Card key={mode.id} className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-[15px] font-bold text-ink">{mode.label}</p>
                  <StateBadge state={dim.state} />
                </div>
                <p className="mt-1.5 text-[13px] text-foreground-secondary">{mode.capability}</p>
              </Card>
            );
          })}
        </section>

        <MasteryPanel rows={masteryRows} loading={masteryLoading} />

        <Card role="region" aria-labelledby="hive-signals" className="p-5 sm:p-7">
          <h2 id="hive-signals" className="font-headline text-[21px] font-extrabold text-ink">Signal timeline</h2>
          <p className="mt-0.5 text-sm text-foreground-secondary">Recent deep signals extracted from graded answers.</p>
          <div className="mt-3">
            {(payload.signals || []).length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No deep signals yet. When the school flag is on, signals appear after report publish.
              </p>
            ) : (
              payload.signals.slice(0, 12).map((signal) => <SignalCard key={signal.id} signal={signal} />)
            )}
          </div>
        </Card>

        <Card role="region" aria-labelledby="hive-synthesis" className="p-5 sm:p-7">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 id="hive-synthesis" className="font-headline text-[21px] font-extrabold text-ink">Synthesis</h2>
              <p className="mt-0.5 text-sm text-foreground-secondary">What changed when signals were folded into DNA.</p>
            </div>
            {staff && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={synthBusy || !payload.features?.deep_signals}
                onClick={triggerSynthesis}
                className="h-9 gap-2 px-3.5 text-[13px]"
              >
                {synthBusy ? <Loader size="inline" /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
                Run synthesis
              </Button>
            )}
          </div>
          {synthMessage && <p role="status" className="mt-3 text-sm text-foreground-secondary">{synthMessage}</p>}
          <div className="mt-4">
            <DiffViewer runs={payload.synthesisRuns} />
          </div>
        </Card>
      </main>
    </div>
  );
}
