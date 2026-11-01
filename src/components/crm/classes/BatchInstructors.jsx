// Batch → Instructors (FLKRM-327 S2, D2): who teaches this batch, per subject,
// with one lead. Ending an assignment keeps it in the history below.
import { useCallback, useEffect, useState } from 'react';
import { UserPlus } from 'lucide-react';
import { Alert, AlertDescription } from '../../ui/Alert';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/Card';
import { Select } from '../../ui/Select';
import { Skeleton } from '../../ui/Skeleton';
import { crmFetch } from '../../../lib/crm/api';
import { classesWrite } from '../../../lib/crm/classes';
import { Field, formatDate } from '../leads/leadUi';

function AssignForm({ batch, options, people, onAssigned }) {
  const defaultSubject = batch.subject?.id || options?.courses?.find((course) => course.id === batch.course?.id)?.subjectId || '';
  const [userId, setUserId] = useState('');
  const [subjectId, setSubjectId] = useState(defaultSubject);
  const [isLead, setIsLead] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (event) => {
    event.preventDefault();
    if (!userId) return;
    setBusy(true);
    setError(null);
    try {
      await classesWrite('classes/batches/instructors', { batchId: batch.id, userId, subjectId: subjectId || null, ...(isLead ? { isLead: true } : {}) });
      setUserId('');
      setIsLead(false);
      onAssigned();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="space-y-3" onSubmit={submit}>
      <div className="grid gap-3">
        <Field label="Instructor" htmlFor="assign-person">
          <Select id="assign-person" value={userId} onChange={(event) => setUserId(event.target.value)}>
            <option value="">Choose a teacher or admin</option>
            {people.map((person) => <option key={person.userId} value={person.userId}>{person.name || 'Unnamed'}{person.role === 'admin' ? ' (admin)' : ''}</option>)}
          </Select>
        </Field>
        <Field label="Subject (optional)" htmlFor="assign-subject">
          <Select id="assign-subject" value={subjectId} onChange={(event) => setSubjectId(event.target.value)}>
            <option value="">All subjects</option>
            {(options?.subjects || []).map((subject) => <option key={subject.id} value={subject.id}>{subject.name}</option>)}
          </Select>
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="h-4 w-4" checked={isLead} onChange={(event) => setIsLead(event.target.checked)} />
        Make lead instructor
      </label>
      {error && <Alert variant="destructive"><AlertDescription>{error.message}</AlertDescription></Alert>}
      <Button type="submit" disabled={busy || !userId}><UserPlus className="mr-1 h-4 w-4" aria-hidden="true" />Assign</Button>
    </form>
  );
}

function EndButton({ assignment, onEnd, busy }) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) return <Button size="sm" variant="ghost" className="text-muted-foreground" disabled={busy} onClick={() => setConfirming(true)}>End</Button>;
  return (
    <span className="flex items-center gap-1 text-xs" role="group" aria-label="Confirm ending">
      <span className="text-muted-foreground">End assignment?</span>
      <Button size="sm" variant="destructive" className="h-7 px-2 text-xs" disabled={busy} onClick={() => onEnd(assignment)}>End</Button>
      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={busy} onClick={() => setConfirming(false)}>Keep</Button>
    </span>
  );
}

export default function BatchInstructors({ me, batch, options, onChanged }) {
  const canWrite = me.capabilities.includes('crm.classes.write') && batch.status === 'active';
  const [state, setState] = useState({ status: 'loading', items: [], people: [], error: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const [assignments, people] = await Promise.all([
        crmFetch(`classes/batches/instructors?${new URLSearchParams({ batchId: batch.id })}`),
        canWrite ? crmFetch('classes/instructors') : { items: [] },
      ]);
      setState({ status: 'ready', items: assignments.items, people: people.items, error: null });
    } catch (err) {
      setState({ status: 'error', items: [], people: [], error: err });
    }
  }, [batch.id, canWrite]);

  useEffect(() => { load(); }, [load]);

  const act = async (path, assignment) => {
    setBusy(true);
    setError(null);
    try {
      await classesWrite(path, { assignmentId: assignment.id, expectedVersion: assignment.version });
      await load();
      onChanged?.();
    } catch (err) {
      setError(err);
      if (err.code === 'version_conflict') await load();
    } finally {
      setBusy(false);
    }
  };

  const active = state.items.filter((item) => item.status === 'active');
  const past = state.items.filter((item) => item.status !== 'active');
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader><CardTitle className="text-base">Instructors</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {error && <Alert variant="destructive"><AlertDescription>{error.code === 'version_conflict' ? 'Someone else changed this meanwhile. The latest version is shown; try again.' : error.message}</AlertDescription></Alert>}
          {state.status === 'loading' && <Skeleton className="h-24 w-full" />}
          {state.status === 'error' && <Alert variant="destructive"><AlertDescription>{state.error.message}</AlertDescription></Alert>}
          {state.status === 'ready' && !active.length && <p className="text-sm text-muted-foreground">Nobody is assigned yet.</p>}
          {active.length > 0 && (
            <ul className="divide-y divide-border text-sm">
              {active.map((assignment) => (
                <li key={assignment.id} className="flex flex-wrap items-center gap-2 py-2">
                  <span className="font-medium">{assignment.name || 'Unnamed'}</span>
                  <span className="text-muted-foreground">{assignment.subject?.name || 'All subjects'}</span>
                  {assignment.isLead && <Badge variant="success">Lead</Badge>}
                  {canWrite && (
                    <span className="ml-auto flex items-center gap-1">
                      {!assignment.isLead && <Button size="sm" variant="ghost" disabled={busy} onClick={() => act('classes/batches/instructors/lead', assignment)}>Make lead</Button>}
                      <EndButton assignment={assignment} busy={busy} onEnd={(item) => act('classes/batches/instructors/end', item)} />
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {state.status === 'ready' && active.length > 0 && !active.some((item) => item.isLead) && (
            <p className="text-xs text-warning-soft-foreground">No lead instructor. Choose one so parents and staff know who to ask.</p>
          )}
          {past.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground">Past instructors ({past.length})</summary>
              <ul className="mt-2 space-y-1 text-muted-foreground">
                {past.map((assignment) => (
                  <li key={assignment.id}>{assignment.name} · {assignment.subject?.name || 'All subjects'} · {formatDate(assignment.startedAt)} – {formatDate(assignment.endedAt)}</li>
                ))}
              </ul>
            </details>
          )}
        </CardContent>
      </Card>
      {canWrite && (
        <Card>
          <CardHeader><CardTitle className="text-base">Assign an instructor</CardTitle></CardHeader>
          <CardContent>
            <AssignForm batch={batch} options={options} people={state.people} onAssigned={() => { load(); onChanged?.(); }} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
