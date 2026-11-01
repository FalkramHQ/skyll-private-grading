// Task rows with complete / reopen / reschedule / reassign / cancel (FLKRM-326 S2).
// Shared by the Tasks page, the Overview dashboard and lead profiles.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarClock, RotateCcw, UserRound, X } from 'lucide-react';
import { Alert, AlertDescription } from '../../ui/Alert';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { cn } from '../../../lib/utils';
import { notifyTasksChanged, taskWrite, useNow } from '../../../lib/crm/tasks';
import { taskBucket } from '../../../../shared/crm/time.js';
import { ReassignDialog, RescheduleDialog } from './TaskDialogs';

const UNDO_MS = 6000;
const formats = new Map();
function format(timezone, options) {
  const key = `${timezone}|${JSON.stringify(options)}`;
  if (!formats.has(key)) formats.set(key, new Intl.DateTimeFormat('en-IN', { timeZone: timezone, ...options }));
  return formats.get(key);
}

/** "Overdue · 27 Sept, 5:00 pm", "Today · 5:00 pm", "Tue, 30 Sept, 10:00 am" in school time. */
export function dueLabel(task, timezone, now) {
  const due = new Date(task.dueAt);
  const time = format(timezone, { hour: 'numeric', minute: '2-digit' }).format(due);
  if (task.status !== 'open') return format(timezone, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(due);
  const bucket = taskBucket(task.dueAt, now, timezone);
  if (bucket === 'today') return `Today · ${time}`;
  const date = format(timezone, { weekday: 'short', day: 'numeric', month: 'short' }).format(due);
  return bucket === 'overdue' ? `Overdue · ${date}, ${time}` : `${date}, ${time}`;
}

function RelatedLink({ related }) {
  if (!related) return null;
  if (related.restricted) return <span className="text-xs text-muted-foreground">{related.type === 'lead' ? 'Lead (restricted)' : 'Student (restricted)'}</span>;
  const label = `${related.type === 'lead' ? 'Lead' : 'Student'}: ${related.name || 'Unknown'}`;
  return <Link to={`/crm/${related.type === 'lead' ? 'leads' : 'students'}/${related.id}`} className="text-xs text-accent underline-offset-4 hover:underline">{label}</Link>;
}

function TaskRow({ task, me, now, canWrite, schoolWide, showOwner, showRelated, busy, onAction, onReschedule, onReassign }) {
  const open = task.status === 'open';
  const overdue = open && taskBucket(task.dueAt, now, me.school.timezone) === 'overdue';
  return (
    <li className="flex items-start gap-3 py-3">
      {canWrite && task.status !== 'cancelled' ? (
        <input
          type="checkbox"
          className="mt-1 h-4 w-4 shrink-0 accent-[var(--primary)]"
          checked={task.status === 'done'}
          disabled={busy}
          aria-label={open ? `Mark "${task.title}" done` : `Reopen "${task.title}"`}
          onChange={() => onAction(task, open ? 'tasks/complete' : 'tasks/reopen')}
        />
      ) : <span className="mt-1 h-4 w-4 shrink-0" aria-hidden="true" />}
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn('font-medium text-foreground', task.status !== 'open' && 'text-muted-foreground line-through')}>{task.title}</span>
          {task.priority === 'high' && <Badge variant="destructive">High</Badge>}
          {task.priority === 'low' && <Badge variant="secondary">Low</Badge>}
          {task.status === 'cancelled' && <Badge variant="outline">Cancelled</Badge>}
        </div>
        {task.details && <p className="whitespace-pre-wrap text-sm text-muted-foreground">{task.details}</p>}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className={cn(overdue ? 'font-medium text-destructive' : 'text-muted-foreground')}>{dueLabel(task, me.school.timezone, now)}</span>
          {showOwner && (task.owner ? <span className="text-muted-foreground">{task.owner.name}</span> : <Badge variant="warning">Unassigned</Badge>)}
          {showRelated && <RelatedLink related={task.related} />}
        </div>
      </div>
      {canWrite && open && (
        <div className="flex shrink-0 items-center">
          <Button variant="ghost" size="icon" aria-label={`Reschedule "${task.title}"`} title="Reschedule" disabled={busy} onClick={() => onReschedule(task)}>
            <CalendarClock className="h-4 w-4" />
          </Button>
          {schoolWide && (
            <Button variant="ghost" size="icon" aria-label={`Reassign "${task.title}"`} title="Reassign" disabled={busy} onClick={() => onReassign(task)}>
              <UserRound className="h-4 w-4" />
            </Button>
          )}
          <Button variant="ghost" size="icon" aria-label={`Cancel "${task.title}"`} title="Cancel task" disabled={busy} onClick={() => onAction(task, 'tasks/cancel')}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      )}
      {canWrite && task.status !== 'open' && (
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => onAction(task, 'tasks/reopen')}>
          <RotateCcw className="mr-1 h-3.5 w-3.5" aria-hidden="true" />Reopen
        </Button>
      )}
    </li>
  );
}

/**
 * Every write announces itself (`notifyTasksChanged`), so lists built with
 * `useTasks` refresh on their own; `onChanged(task)` is an optional extra hook.
 */
export default function TaskList({ tasks, me, assignees = [], onChanged, showOwner = false, showRelated = true, emptyText = 'Nothing here.' }) {
  const canWrite = me.capabilities.includes('crm.tasks.write');
  const schoolWide = me.taskScope === 'school';
  const now = useNow();
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);
  const [rescheduling, setRescheduling] = useState(null);
  const [reassigning, setReassigning] = useState(null);
  // The task just cancelled, offered back for a few seconds (D12a).
  const [undo, setUndo] = useState(null);
  // Server replies newer than the list, shown until the list reloads, so a
  // tick or cancel is visible at once even on a slow connection.
  const [latest, setLatest] = useState({});
  const shown = tasks.map((task) => (latest[task.id]?.version > task.version ? latest[task.id] : task));

  useEffect(() => {
    if (!undo) return undefined;
    const timer = setTimeout(() => setUndo(null), UNDO_MS);
    return () => clearTimeout(timer);
  }, [undo]);

  const act = async (task, path) => {
    setBusyId(task.id);
    setError(null);
    try {
      // Not `onChanged?.(await …)`: an optional call skips its arguments, so the
      // write would never be sent when no callback is passed.
      const updated = await taskWrite(path, { taskId: task.id, expectedVersion: task.version });
      setLatest((current) => ({ ...current, [updated.id]: updated }));
      setUndo(path === 'tasks/cancel' ? updated : null);
      onChanged?.(updated);
    } catch (err) {
      setError(err.code === 'version_conflict' ? new Error('Someone else changed this task. The list has been refreshed; try again.') : err);
      // Lists reload on this signal, so the next attempt uses fresh versions.
      if (err.code === 'version_conflict') notifyTasksChanged();
    } finally {
      setBusyId(null);
    }
  };
  const saved = (task) => {
    setLatest((current) => ({ ...current, [task.id]: task }));
    setRescheduling(null);
    setReassigning(null);
    onChanged?.(task);
  };

  return (
    <div>
      {error && <Alert variant="destructive" className="mb-2"><AlertDescription>{error.message}</AlertDescription></Alert>}
      {undo && (
        <div role="status" className="mb-2 flex items-center justify-between gap-3 rounded-lg bg-foreground px-3 py-2 text-sm text-background">
          <span className="truncate">Cancelled &ldquo;{undo.title}&rdquo;</span>
          <Button size="sm" variant="ghost" className="h-7 text-background hover:bg-background/15 hover:text-background" disabled={busyId === undo.id} onClick={() => act(undo, 'tasks/reopen')}>
            Undo
          </Button>
        </div>
      )}
      {shown.length
        ? (
          <ul className="divide-y divide-border">
            {shown.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                me={me}
                now={now}
                canWrite={canWrite}
                schoolWide={schoolWide}
                showOwner={showOwner}
                showRelated={showRelated}
                busy={busyId === task.id}
                onAction={act}
                onReschedule={setRescheduling}
                onReassign={setReassigning}
              />
            ))}
          </ul>
        )
        : <p className="py-3 text-sm text-muted-foreground">{emptyText}</p>}
      {rescheduling && <RescheduleDialog key={rescheduling.id} task={rescheduling} me={me} onClose={() => setRescheduling(null)} onSaved={saved} />}
      {reassigning && <ReassignDialog key={reassigning.id} task={reassigning} me={me} assignees={assignees} onClose={() => setReassigning(null)} onSaved={saved} />}
    </div>
  );
}
