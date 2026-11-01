// Settings → Pipeline (CRM-010): rename, reorder, add and archive admission
// stages, and choose what must be recorded before a lead can be enrolled
// (FLKRM-326 S5, D5, D6). Stage types are fixed; the server re-checks every rule.
import { useCallback, useEffect, useState } from 'react';
import { Archive, ArrowDown, ArrowUp, Plus } from 'lucide-react';
import { Alert, AlertDescription } from '../ui/Alert';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/Card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/Dialog';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { Skeleton } from '../ui/Skeleton';
import { crmFetch, newIdempotencyKey } from '../../lib/crm/api';
import { useDraft } from '../../lib/crm/useDraft';
import { ADDABLE_CATEGORIES, REQUIREMENTS } from '../../../shared/crm/conversion.js';
import { STAGE_NAME_MAX } from '../../../shared/crm/pipeline.js';
import { STAGE_CATEGORY as CATEGORY } from './stageCategories';

function StageRow({ stage, index, count, busy, canArchive, onRename, onMove, onArchive }) {
  const [name, setName] = useDraft(stage.name);
  const changed = name.trim() && name.trim() !== stage.name;
  const category = CATEGORY[stage.category];

  return (
    <li className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
      <span className="w-6 text-sm tabular-nums text-muted-foreground">{index + 1}</span>
      <form
        className="flex flex-1 gap-2"
        onSubmit={(event) => { event.preventDefault(); if (changed) onRename(stage, name.trim()); }}
      >
        <Input
          aria-label={`Name of stage ${index + 1}`}
          value={name}
          maxLength={STAGE_NAME_MAX}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
        />
        {changed && <Button type="submit" disabled={busy}>Save</Button>}
      </form>
      <div className="flex items-center gap-2">
        {stage.leadCount !== undefined && (
          <span className="w-16 text-right text-xs tabular-nums text-muted-foreground">{stage.leadCount} lead{stage.leadCount === 1 ? '' : 's'}</span>
        )}
        <span className="flex w-20 justify-end"><Badge variant={category.variant} title="Stage type is fixed">{category.label}</Badge></span>
        <Button variant="ghost" size="icon" aria-label={`Move ${stage.name} up`} disabled={busy || index === 0} onClick={() => onMove(index, -1)}>
          <ArrowUp className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" aria-label={`Move ${stage.name} down`} disabled={busy || index === count - 1} onClick={() => onMove(index, 1)}>
          <ArrowDown className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Archive ${stage.name}`}
          title={canArchive.ok ? 'Archive stage' : canArchive.reason}
          disabled={busy || !canArchive.ok}
          onClick={() => onArchive(stage)}
        >
          <Archive className="h-4 w-4" />
        </Button>
      </div>
    </li>
  );
}

function ArchiveDialog({ stage, stages, busy, error, onCancel, onConfirm }) {
  const destinations = stages.filter((item) => item.id !== stage.id && ADDABLE_CATEGORIES.includes(item.category));
  const [destination, setDestination] = useState('');
  const needsDestination = stage.leadCount > 0;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Archive &ldquo;{stage.name}&rdquo;?</DialogTitle>
          <DialogDescription>
            It disappears from the board and can&apos;t be chosen again. Past stage history keeps its name.
          </DialogDescription>
        </DialogHeader>
        {needsDestination && (
          <div className="space-y-1.5">
            <label htmlFor="archive-destination" className="text-sm font-medium">
              Move its {stage.leadCount} lead{stage.leadCount === 1 ? '' : 's'} to
            </label>
            <Select id="archive-destination" value={destination} onChange={(event) => setDestination(event.target.value)}>
              <option value="">Choose a stage</option>
              {destinations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </Select>
            <p className="text-xs text-muted-foreground">Each moved lead gets a history entry &ldquo;Stage archived: {stage.name}&rdquo;.</p>
          </div>
        )}
        {error && <Alert variant="destructive"><AlertDescription>{error.message}</AlertDescription></Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button variant="destructive" disabled={busy || (needsDestination && !destination)} onClick={() => onConfirm(destination || undefined)}>Archive stage</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AddStageForm({ busy, onAdd }) {
  const [name, setName] = useState('');
  const [category, setCategory] = useState('open');
  return (
    <form
      className="flex flex-col gap-2 sm:flex-row sm:items-center"
      onSubmit={async (event) => {
        event.preventDefault();
        if (name.trim() && await onAdd(name.trim(), category)) setName('');
      }}
    >
      <Input aria-label="New stage name" placeholder="New stage, e.g. Demo class booked" maxLength={STAGE_NAME_MAX} value={name} disabled={busy} onChange={(event) => setName(event.target.value)} className="sm:max-w-xs" />
      <Select aria-label="New stage type" value={category} disabled={busy} onChange={(event) => setCategory(event.target.value)} className="sm:w-44">
        <option value="open">Lead stage</option>
        <option value="applicant">Applicant stage</option>
      </Select>
      <Button type="submit" variant="outline" disabled={busy || !name.trim()}>
        <Plus className="mr-1 h-4 w-4" aria-hidden="true" />Add stage
      </Button>
    </form>
  );
}

function asRequirements(value) {
  return Object.fromEntries(REQUIREMENTS.map((item) => [item.key, Boolean(value?.[item.key])]));
}

function RequirementsCard({ pipeline, busy, onSave }) {
  const saved = asRequirements(pipeline.requirements);
  const [draft, setDraft] = useDraft(pipeline.requirements, asRequirements);
  const changed = REQUIREMENTS.some((item) => draft[item.key] !== saved[item.key]);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Before enrollment</CardTitle>
        <CardDescription>A lead can only be converted into a student once everything ticked here is recorded.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {REQUIREMENTS.map((item) => (
          <label key={item.key} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={draft[item.key]}
              disabled={busy}
              onChange={(event) => setDraft((current) => ({ ...current, [item.key]: event.target.checked }))}
            />
            {item.label}
          </label>
        ))}
        <div className="flex justify-end">
          <Button size="sm" disabled={busy || !changed} onClick={() => onSave(draft)}>Save requirements</Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** Settings → Pipeline: stages and the requirements before enrollment. */
export default function PipelineSettings() {
  const [pipeline, setPipeline] = useState(null);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [archiving, setArchiving] = useState(null);

  const load = useCallback(async () => {
    setStatus('loading');
    setError(null);
    try {
      setPipeline(await crmFetch('settings/pipeline'));
      setStatus('ready');
    } catch (err) {
      setError(err);
      setStatus('error');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = async (path, body) => {
    setBusy(true);
    setError(null);
    try {
      setPipeline(await crmFetch(path, { method: 'POST', body, idempotencyKey: newIdempotencyKey() }));
      return true;
    } catch (err) {
      setError(err);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const rename = (stage, name) => save('settings/pipeline/rename', { stageId: stage.id, name, expectedVersion: stage.version });
  const move = (index, delta) => {
    const ids = pipeline.stages.map((stage) => stage.id);
    [ids[index], ids[index + delta]] = [ids[index + delta], ids[index]];
    save('settings/pipeline/reorder', { stageIds: ids, expectedVersion: pipeline.version });
  };
  const addStage = (name, category) => save('settings/pipeline/stages', { name, category, expectedVersion: pipeline.version });
  const archive = async (destinationStageId) => {
    if (await save('settings/pipeline/archive', { stageId: archiving.id, ...(destinationStageId ? { destinationStageId } : {}), expectedVersion: pipeline.version })) setArchiving(null);
  };

  if (status === 'loading') return <Skeleton className="h-64 w-full" />;
  if (status === 'error') return <Alert variant="destructive"><AlertDescription>{error.message}</AlertDescription></Alert>;

  const conflict = error?.code === 'version_conflict';
  const openStages = pipeline.stages.filter((stage) => stage.category === 'open').length;
  const canArchive = (stage) => {
    if (!ADDABLE_CATEGORIES.includes(stage.category)) return { ok: false, reason: 'Enrolled and Lost can be renamed but not archived' };
    if (stage.category === 'open' && openStages === 1) return { ok: false, reason: 'Keep at least one lead stage: new leads start there' };
    return { ok: true };
  };
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Rename, reorder, add or archive stages to match how your team works. Stage types are fixed: leads become students only through conversion.
      </p>
      {error && !archiving && (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            <span>{conflict ? 'Someone else changed the pipeline while you were editing.' : error.message}</span>
            {conflict && <Button size="sm" variant="outline" onClick={load}>Reload latest</Button>}
          </AlertDescription>
        </Alert>
      )}
      <Card>
        <ol className="divide-y divide-border" aria-label="Pipeline stages">
          {pipeline.stages.map((stage, index) => (
            <StageRow
              key={stage.id}
              stage={stage}
              index={index}
              count={pipeline.stages.length}
              busy={busy}
              canArchive={canArchive(stage)}
              onRename={rename}
              onMove={move}
              onArchive={(item) => { setError(null); setArchiving(item); }}
            />
          ))}
        </ol>
      </Card>
      <AddStageForm busy={busy} onAdd={addStage} />
      <RequirementsCard pipeline={pipeline} busy={busy} onSave={(requirements) => save('settings/pipeline/requirements', { requirements, expectedVersion: pipeline.version })} />
      {archiving && (
        <ArchiveDialog
          stage={archiving}
          stages={pipeline.stages}
          busy={busy}
          error={error}
          onCancel={() => { setArchiving(null); setError(null); }}
          onConfirm={archive}
        />
      )}
    </div>
  );
}
