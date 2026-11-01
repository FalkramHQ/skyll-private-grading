// Create, reschedule and reassign dialogs for CRM tasks (FLKRM-326 S2). Times
// are entered in the school's timezone and sent as UTC.
import { useEffect, useState } from 'react';
import { Alert, AlertDescription } from '../../ui/Alert';
import { Button } from '../../ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../ui/Dialog';
import { Input } from '../../ui/Input';
import { Select } from '../../ui/Select';
import { taskWrite } from '../../../lib/crm/tasks';
import { fieldErrors } from '../../../../shared/crm/leads.js';
import { PRIORITY_LABELS, TASK_PRIORITIES, createTaskBody } from '../../../../shared/crm/tasks.js';
import { defaultDueInput, isoToLocalInput, localInputToIso } from '../../../../shared/crm/time.js';
import { Field, Textarea } from '../leads/leadUi';

function tzLabel(timezone) {
  return timezone === 'Asia/Kolkata' ? 'IST' : timezone;
}

function DialogFooter({ busy, onCancel, submitLabel, disabled }) {
  return (
    <div className="flex justify-end gap-2">
      <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
      <Button type="submit" disabled={busy || disabled}>{submitLabel}</Button>
    </div>
  );
}

function OwnerOptions({ assignees, me }) {
  return assignees.map((person) => (
    <option key={person.userId} value={person.userId}>
      {person.userId === me.user.id ? `${person.name || 'Me'} (me)` : person.name}
    </option>
  ));
}

// `ownerUserId: undefined` means "not chosen": the server assigns the creator
// (or leaves it unassigned for platform support).
function blankTask(timezone) {
  return { title: '', details: '', due: defaultDueInput(Date.now(), timezone), priority: 'normal', ownerUserId: undefined };
}

/** New task. `related` pins the task to a lead or student (e.g. from its profile). */
export function NewTaskDialog({ open, onOpenChange, me, assignees, related, relatedLabel, onCreated }) {
  const timezone = me.school.timezone;
  const schoolWide = me.taskScope === 'school';
  const [form, setForm] = useState(() => blankTask(timezone));
  const [touched, setTouched] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    setForm(blankTask(timezone));
    setTouched({});
    setError(null);
  }, [open, timezone]);

  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const body = {
    title: form.title.trim(),
    ...(form.details.trim() ? { details: form.details.trim() } : {}),
    dueAt: localInputToIso(form.due, timezone) || '',
    priority: form.priority,
    ...(schoolWide && form.ownerUserId !== undefined ? { ownerUserId: form.ownerUserId || null } : {}),
    ...(related ? { related } : {}),
  };
  const parsed = createTaskBody.safeParse(body);
  const errors = fieldErrors(parsed);

  const submit = async (event) => {
    event.preventDefault();
    setTouched({ title: true, due: true });
    if (!parsed.success) return;
    setBusy(true);
    setError(null);
    try {
      onCreated(await taskWrite('tasks', body));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
          <DialogDescription>{relatedLabel ? `For ${relatedLabel}.` : 'A follow-up or reminder for your team.'}</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit} noValidate>
          <Field label="What needs doing" htmlFor="task-title" error={touched.title ? errors.title : undefined}>
            <Input id="task-title" maxLength={160} value={form.title} onChange={set('title')} onBlur={() => setTouched((t) => ({ ...t, title: true }))} autoFocus />
          </Field>
          <Field label="Details (optional)" htmlFor="task-details">
            <Textarea id="task-details" maxLength={2000} value={form.details} onChange={set('details')} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={`Due (${tzLabel(timezone)})`} htmlFor="task-due" error={touched.due ? errors.dueAt : undefined}>
              <Input id="task-due" type="datetime-local" value={form.due} onChange={set('due')} onBlur={() => setTouched((t) => ({ ...t, due: true }))} />
            </Field>
            <Field label="Priority" htmlFor="task-priority">
              <Select id="task-priority" value={form.priority} onChange={set('priority')}>
                {TASK_PRIORITIES.map((priority) => <option key={priority} value={priority}>{PRIORITY_LABELS[priority]}</option>)}
              </Select>
            </Field>
            {schoolWide && (
              <Field label="Assigned to" htmlFor="task-owner">
                <Select id="task-owner" value={form.ownerUserId ?? (assignees.some((person) => person.userId === me.user.id) ? me.user.id : '')} onChange={set('ownerUserId')}>
                  <option value="">Unassigned</option>
                  <OwnerOptions assignees={assignees} me={me} />
                </Select>
              </Field>
            )}
          </div>
          {error && <Alert variant="destructive"><AlertDescription>{error.message}</AlertDescription></Alert>}
          <DialogFooter busy={busy} onCancel={() => onOpenChange(false)} submitLabel="Create task" disabled={!parsed.success} />
        </form>
      </DialogContent>
    </Dialog>
  );
}

function quickTimes(timezone) {
  const tomorrow = defaultDueInput(Date.now(), timezone);
  const nextWeek = defaultDueInput(Date.now() + 6 * 86_400_000, timezone);
  return [['Tomorrow 10:00', tomorrow], ['Next week', nextWeek]];
}

/** Pick a new due time for an open task. */
export function RescheduleDialog({ task, me, onClose, onSaved }) {
  const timezone = me.school.timezone;
  const [due, setDue] = useState(() => (task ? isoToLocalInput(task.dueAt, timezone) : ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const dueAt = localInputToIso(due, timezone);
  const unchanged = task && dueAt === new Date(task.dueAt).toISOString();

  const submit = async (event) => {
    event.preventDefault();
    if (!dueAt || unchanged) return;
    setBusy(true);
    setError(null);
    try {
      onSaved(await taskWrite('tasks/reschedule', { taskId: task.id, dueAt, expectedVersion: task.version }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={Boolean(task)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reschedule</DialogTitle>
          <DialogDescription>{task?.title}</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit}>
          <Field label={`New due time (${tzLabel(timezone)})`} htmlFor="task-reschedule">
            <Input id="task-reschedule" type="datetime-local" value={due} onChange={(event) => setDue(event.target.value)} />
          </Field>
          <div className="flex flex-wrap gap-2">
            {quickTimes(timezone).map(([label, value]) => (
              <Button key={label} type="button" size="sm" variant="outline" onClick={() => setDue(value)}>{label}</Button>
            ))}
          </div>
          {error && <Alert variant="destructive"><AlertDescription>{error.message}</AlertDescription></Alert>}
          <DialogFooter busy={busy} onCancel={onClose} submitLabel="Reschedule" disabled={!dueAt || unchanged} />
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Hand an open task to someone else, or leave it unassigned. */
export function ReassignDialog({ task, me, assignees, onClose, onSaved }) {
  const [ownerUserId, setOwner] = useState(task?.owner?.userId || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const unchanged = (task?.owner?.userId || '') === ownerUserId;

  const submit = async (event) => {
    event.preventDefault();
    if (unchanged) return;
    setBusy(true);
    setError(null);
    try {
      onSaved(await taskWrite('tasks/reassign', { taskId: task.id, ownerUserId: ownerUserId || null, expectedVersion: task.version }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={Boolean(task)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reassign</DialogTitle>
          <DialogDescription>{task?.title}</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit}>
          <Field label="Assigned to" htmlFor="task-reassign">
            <Select id="task-reassign" value={ownerUserId} onChange={(event) => setOwner(event.target.value)}>
              <option value="">Unassigned</option>
              <OwnerOptions assignees={assignees} me={me} />
            </Select>
          </Field>
          {error && <Alert variant="destructive"><AlertDescription>{error.message}</AlertDescription></Alert>}
          <DialogFooter busy={busy} onCancel={onClose} submitLabel="Reassign" disabled={unchanged} />
        </form>
      </DialogContent>
    </Dialog>
  );
}
