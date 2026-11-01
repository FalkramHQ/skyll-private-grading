// Leads workspace (CRM-009/010, FLKRM-326 S1): the admissions board, a list
// view, search, and New lead. The server enforces every rule; this page only
// offers the moves the lifecycle contract allows.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Columns3, List, Plus, Search } from 'lucide-react';
import { Alert, AlertDescription } from '../../ui/Alert';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Input } from '../../ui/Input';
import { Skeleton } from '../../ui/Skeleton';
import { cn } from '../../../lib/utils';
import { crmFetch } from '../../../lib/crm/api';
import LeadBoard, { OwnerLabel } from './LeadBoard';
import { TagChips } from '../records/TagPicker';
import NewLeadDialog from './NewLeadDialog';
import { MoveToSelect, StageBadge, sinceLabel } from './leadUi';
import { useLeadMove } from './useLeadMove';

const VIEW_KEY = 'skyll.crm.leadsView';
const BOARD_LIMIT = 200;

function storedView() {
  try { return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'board'; } catch { return 'board'; }
}

function LeadList({ leads, stages, canWrite, busy, onMove }) {
  if (!leads.length) return <p className="text-sm text-muted-foreground">No leads match.</p>;
  return (
    <Card className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="p-3 font-medium">Student</th>
            <th className="p-3 font-medium">Stage</th>
            <th className="p-3 font-medium">Owner</th>
            <th className="p-3 font-medium">Source</th>
            <th className="p-3 font-medium">Last activity</th>
            {canWrite && <th className="p-3 font-medium"><span className="sr-only">Move</span></th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {leads.map((lead) => (
            <tr key={lead.id}>
              <td className="p-3">
                <Link to={`/crm/leads/${lead.id}`} className="font-medium hover:underline">{lead.learnerName}</Link>
                {lead.learnerGrade && <span className="ml-2 text-xs text-muted-foreground">Gr {lead.learnerGrade}</span>}
                {lead.tags?.length > 0 && <div className="mt-1"><TagChips tags={lead.tags} max={3} /></div>}
              </td>
              <td className="p-3"><StageBadge category={lead.stage.category}>{lead.stage.name}</StageBadge></td>
              <td className="p-3"><OwnerLabel lead={lead} /></td>
              <td className="p-3 text-muted-foreground">{lead.source?.label || '—'}</td>
              <td className="p-3 text-muted-foreground">{sinceLabel(lead.lastActivityAt)}</td>
              {canWrite && <td className="w-44 p-3"><MoveToSelect lead={lead} stages={stages} disabled={busy} onMove={onMove} /></td>}
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

export default function LeadsPage({ me }) {
  const navigate = useNavigate();
  const canWrite = me.capabilities.includes('crm.leads.write');
  const [view, setView] = useState(storedView);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [state, setState] = useState({ status: 'loading', stages: [], leads: [], owners: [], truncated: false, error: null });
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  // Latest request wins, so a slow answer for an older search can't replace a
  // newer one. Stages and owners don't depend on the search: load them once
  // (and again on a version conflict), not on every keystroke.
  const seqRef = useRef(0);
  const metaRef = useRef(null);
  const load = useCallback(async ({ refreshMeta = false } = {}) => {
    const seq = ++seqRef.current;
    try {
      const params = new URLSearchParams({ limit: String(BOARD_LIMIT) });
      if (search) params.set('q', search);
      const needMeta = refreshMeta || !metaRef.current;
      const [pipeline, leads, owners] = await Promise.all([
        needMeta ? crmFetch('settings/pipeline') : null,
        crmFetch(`leads?${params}`),
        needMeta ? crmFetch('leads/owners') : null,
      ]);
      if (needMeta) metaRef.current = { stages: pipeline.stages, owners: owners.items };
      if (seq !== seqRef.current) return;
      setState({ status: 'ready', ...metaRef.current, leads: leads.items, truncated: Boolean(leads.nextCursor), error: null });
    } catch (error) {
      if (seq !== seqRef.current) return;
      setState((current) => ({ ...current, status: 'error', error }));
    }
  }, [search]);
  const reloadAll = useCallback(() => load({ refreshMeta: true }), [load]);

  useEffect(() => { load(); }, [load]);

  const replaceLead = (next) => {
    setState((current) => ({ ...current, leads: current.leads.map((lead) => (lead.id === next.id ? next : lead)) }));
  };
  const mover = useLeadMove(replaceLead);

  // Show the card in its new column at once; put it back if the server refuses.
  const moveLead = async (lead, stage) => {
    if (stage.category !== 'lost') replaceLead({ ...lead, stage: { id: stage.id, name: stage.name, category: stage.category } });
    const ok = await mover.move(lead, stage);
    if (ok === false) replaceLead(lead);
  };

  const chooseView = (next) => {
    setView(next);
    try { localStorage.setItem(VIEW_KEY, next); } catch { /* per-viewer convenience only */ }
  };

  if (state.status === 'loading') return <Skeleton className="h-96 w-full" />;
  if (state.status === 'error' && !state.leads.length) {
    return <Alert variant="destructive"><AlertDescription>{state.error.message}</AlertDescription></Alert>;
  }

  const conflict = mover.error?.code === 'version_conflict';
  const shared = { stages: state.stages, leads: state.leads, canWrite, busy: mover.busy, onMove: moveLead };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[12rem] flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input aria-label="Search leads by student name" placeholder="Search student name" className="pl-9" value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>
        <div className="flex rounded-lg border border-border p-0.5" role="group" aria-label="View">
          {[['board', 'Board', Columns3], ['list', 'List', List]].map(([key, label, Icon]) => (
            <Button
              key={key}
              size="sm"
              variant={view === key ? 'default' : 'ghost'}
              className={view === key ? 'shadow-sm' : 'text-muted-foreground'}
              aria-pressed={view === key}
              onClick={() => chooseView(key)}
            >
              <Icon className="mr-1.5 h-4 w-4" aria-hidden="true" />{label}
            </Button>
          ))}
        </div>
        {canWrite && (
          <Button className="ml-auto" onClick={() => setCreating(true)}>
            <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" />New lead
          </Button>
        )}
      </div>

      {mover.error && (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            <span>{conflict ? 'Someone else updated this lead. The board has been refreshed; try again.' : mover.error.message}</span>
            {!conflict && <Button size="sm" variant="outline" onClick={mover.clearError}>Dismiss</Button>}
          </AlertDescription>
        </Alert>
      )}
      {state.truncated && (
        <p className="text-xs text-muted-foreground">Showing the newest {BOARD_LIMIT} leads. Search to find older ones.</p>
      )}

      <div className={cn(mover.busy && 'opacity-70')}>
        {view === 'board' ? <LeadBoard {...shared} /> : <LeadList {...shared} />}
      </div>
      {mover.dialog}

      {canWrite && (
        <NewLeadDialog
          open={creating}
          onOpenChange={setCreating}
          me={me}
          owners={state.owners}
          onCreated={(lead) => { setCreating(false); navigate(`/crm/leads/${lead.id}`); }}
        />
      )}
      <ConflictReload conflict={conflict} reload={reloadAll} clear={mover.clearError} />
    </div>
  );
}

// On a version conflict, reload the board once so the next move uses fresh versions.
function ConflictReload({ conflict, reload, clear }) {
  useEffect(() => {
    if (!conflict) return undefined;
    reload();
    const timer = setTimeout(clear, 4000);
    return () => clearTimeout(timer);
  }, [conflict, reload, clear]);
  return null;
}
