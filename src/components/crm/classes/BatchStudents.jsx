// Batch → Students (FLKRM-327 S1, D12): add and remove students on the
// canonical batch memberships. Removing ends the membership; it is never
// deleted, so past attendance keeps its roster.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Search, UserPlus } from 'lucide-react';
import { Alert, AlertDescription } from '../../ui/Alert';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../ui/Dialog';
import { Input } from '../../ui/Input';
import { Skeleton } from '../../ui/Skeleton';
import { crmFetch } from '../../../lib/crm/api';
import { classesWrite } from '../../../lib/crm/classes';
import { formatDate } from '../leads/leadUi';
import { Segmented } from '../tasks/TasksPage';
import { FormFooter } from './ClassDialogs';

function AddStudentsDialog({ open, onOpenChange, batch, currentIds, onAdded }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState({ status: 'idle', items: [] });
  const [chosen, setChosen] = useState(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setChosen(new Map());
    setError(null);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const timer = setTimeout(async () => {
      setResults((current) => ({ ...current, status: 'loading' }));
      try {
        const params = new URLSearchParams({ status: 'active', limit: '50' });
        if (query.trim()) params.set('q', query.trim());
        const page = await crmFetch(`students?${params}`);
        setResults({ status: 'ready', items: page.items });
      } catch (err) {
        setResults({ status: 'error', items: [], error: err });
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [open, query]);

  const toggle = (student) => setChosen((current) => {
    const next = new Map(current);
    if (next.has(student.id)) next.delete(student.id);
    else next.set(student.id, student.name);
    return next;
  });

  const submit = async (event) => {
    event.preventDefault();
    if (!chosen.size) return;
    setBusy(true);
    setError(null);
    try {
      const result = await classesWrite('classes/batches/students/add', { batchId: batch.id, studentIds: [...chosen.keys()] });
      onAdded({ ...result, students: [...chosen].map(([id, name]) => ({ id, name })) });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const candidates = results.items.filter((student) => !currentIds.has(student.id));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add students to {batch.name}</DialogTitle>
          <DialogDescription>They join today. Tests created from now on include them; earlier tests don&apos;t change.</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit}>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input aria-label="Search students by name" placeholder="Search student name" className="pl-9" value={query} onChange={(event) => setQuery(event.target.value)} autoFocus />
          </div>
          <div className="max-h-72 overflow-y-auto rounded-lg border border-border">
            {results.status === 'loading' && !results.items.length && <Skeleton className="h-24 w-full" />}
            {results.status === 'error' && <p className="p-3 text-sm text-destructive">{results.error.message}</p>}
            {results.status === 'ready' && !candidates.length && <p className="p-3 text-sm text-muted-foreground">No other active students match.</p>}
            <ul className="divide-y divide-border">
              {candidates.map((student) => (
                <li key={student.id}>
                  <label className="flex cursor-pointer items-center gap-3 p-3 text-sm hover:bg-muted">
                    <input type="checkbox" className="h-4 w-4" checked={chosen.has(student.id)} onChange={() => toggle(student)} />
                    <span className="min-w-0 flex-1">{student.name}</span>
                    <span className="text-xs text-muted-foreground">{student.batches.map((item) => item.name).join(', ') || 'No batch'}</span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
          {chosen.size > 0 && <p className="text-sm">{chosen.size} selected: {[...chosen.values()].join(', ')}</p>}
          {error && <Alert variant="destructive"><AlertDescription>{error.message}</AlertDescription></Alert>}
          <FormFooter busy={busy} onCancel={() => onOpenChange(false)} submitLabel={chosen.size ? `Add ${chosen.size}` : 'Add'} disabled={!chosen.size} />
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RemoveButton({ student, batch, onRemoved, onError }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    onError(null);
    try {
      onRemoved(await classesWrite('classes/batches/students/remove', { batchId: batch.id, membershipId: student.membershipId }));
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };
  if (!confirming) {
    return <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setConfirming(true)} aria-label={`Remove ${student.name} from the batch`}>Remove</Button>;
  }
  return (
    <span className="flex items-center gap-1 text-xs" role="group" aria-label="Confirm removal">
      <span className="text-muted-foreground">Remove?</span>
      <Button size="sm" variant="destructive" className="h-7 px-2 text-xs" disabled={busy} onClick={remove}>Remove</Button>
      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={busy} onClick={() => setConfirming(false)}>Keep</Button>
    </span>
  );
}

export default function BatchStudents({ me, batch, onChanged }) {
  const canWrite = me.capabilities.includes('crm.classes.write') && batch.status === 'active';
  const canAdd = canWrite && me.capabilities.includes('crm.students.read');
  const canOpenStudents = me.capabilities.includes('crm.students.read');
  // CRM M2 S5 (D9): offer fee set-up after adding students; never automatic.
  const canSetUpFees = canOpenStudents && me.capabilities.includes('crm.finance.write');
  const [view, setView] = useState('current');
  const [state, setState] = useState({ status: 'loading', items: [], error: null });
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const page = await crmFetch(`classes/batches/students?${new URLSearchParams({ batchId: batch.id, view })}`);
      setState({ status: 'ready', items: page.items, error: null });
    } catch (err) {
      setState({ status: 'error', items: [], error: err });
    }
  }, [batch.id, view]);

  useEffect(() => { load(); }, [load]);

  const afterChange = (result) => {
    load();
    onChanged?.(result.batch);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented label="Students shown" options={[['current', 'Current'], ['past', 'Past']]} value={view} onChange={setView} />
        {canAdd && (
          <Button className="ml-auto" onClick={() => setAdding(true)}>
            <UserPlus className="mr-1 h-4 w-4" aria-hidden="true" />Add students
          </Button>
        )}
      </div>
      {notice && (
        <Alert variant={notice.warn ? 'default' : 'success'}>
          <AlertDescription>
            {notice.text}
            {notice.students?.length > 0 && (
              <span className="mt-1 block">
                Set up fees:{' '}
                {notice.students.map((student, index) => (
                  <span key={student.id}>
                    {index > 0 && ', '}
                    <Link to={`/crm/students/${student.id}?${new URLSearchParams({ fees: 'setup', batch: batch.id })}`} className="font-medium underline">{student.name}</Link>
                  </span>
                ))}
              </span>
            )}
          </AlertDescription>
        </Alert>
      )}
      {error && <Alert variant="destructive"><AlertDescription>{error.message}</AlertDescription></Alert>}
      {state.status === 'loading' && <Skeleton className="h-32 w-full" />}
      {state.status === 'error' && <Alert variant="destructive"><AlertDescription>{state.error.message}</AlertDescription></Alert>}
      {state.status === 'ready' && !state.items.length && (
        <p className="text-sm text-muted-foreground">{view === 'current' ? 'No students in this batch yet.' : 'Nobody has left this batch.'}</p>
      )}
      {state.status === 'ready' && state.items.length > 0 && (
        <Card>
          <ul className="divide-y divide-border text-sm">
            {state.items.map((student) => (
              <li key={student.membershipId} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3">
                <span className="min-w-0 flex-1 font-medium">
                  {canOpenStudents ? <Link to={`/crm/students/${student.studentId}`} className="hover:underline">{student.name}</Link> : student.name}
                </span>
                <span className="text-xs text-muted-foreground">
                  {view === 'current' ? `Joined ${formatDate(student.joinedAt) || '—'}` : `${formatDate(student.joinedAt) || '…'} – ${formatDate(student.leftAt)}`}
                </span>
                {canWrite && view === 'current' && (
                  <RemoveButton
                    student={student}
                    batch={batch}
                    onError={setError}
                    onRemoved={(result) => { setNotice({ text: `${student.name} left ${batch.name}. Their history stays.` }); afterChange(result); }}
                  />
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
      <AddStudentsDialog
        open={adding}
        onOpenChange={setAdding}
        batch={batch}
        currentIds={new Set(view === 'current' ? state.items.map((item) => item.studentId) : [])}
        onAdded={(result) => {
          setAdding(false);
          const parts = [`Added ${result.added} student${result.added === 1 ? '' : 's'}.`];
          if (result.alreadyInBatch) parts.push(`${result.alreadyInBatch} already in the batch.`);
          if (result.overCapacity) parts.push(`The batch is now over its capacity of ${result.batch.capacity}.`);
          setNotice({ text: parts.join(' '), warn: result.overCapacity, students: canSetUpFees && result.added ? result.students : [] });
          afterChange(result);
        }}
      />
    </div>
  );
}
