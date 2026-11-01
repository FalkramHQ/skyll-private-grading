// Weekly hours and leave for one instructor (FLKRM-327 S2, D4). Times are the
// school's local time. A teacher edits their own; classes write edits anyone's.
import { useCallback, useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Alert, AlertDescription } from '../../ui/Alert';
import { Button } from '../../ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../ui/Dialog';
import { Input } from '../../ui/Input';
import { Skeleton } from '../../ui/Skeleton';
import { crmFetch } from '../../../lib/crm/api';
import { useDraft } from '../../../lib/crm/useDraft';
import { classesWrite, formatDay } from '../../../lib/crm/classes';
import { WEEKDAYS, WEEKDAY_LONG, availabilityBody, exceptionBody } from '../../../../shared/crm/availability.js';
import { fieldErrors } from '../../../../shared/crm/leads.js';
import { localDate } from '../../../../shared/crm/time.js';
import { Field } from '../leads/leadUi';

function toRows(windows) {
  return windows.map((window, index) => ({ key: `${window.id || index}`, weekday: window.weekday, start: window.start, end: window.end === '24:00' ? '23:59' : window.end }));
}

let rowKey = 0;

function WeeklyHours({ userId, initial, canEdit, onSaved }) {
  const [rows, setRows] = useDraft(initial, toRows);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  const body = { userId, windows: rows.map(({ weekday, start, end }) => ({ weekday, start, end })) };
  const parsed = availabilityBody.safeParse(body);
  const errors = fieldErrors(parsed);

  const update = (key, field, value) => { setSaved(false); setRows((current) => current.map((row) => (row.key === key ? { ...row, [field]: value } : row))); };
  const add = (weekday) => { setSaved(false); setRows((current) => [...current, { key: `new${rowKey += 1}`, weekday, start: '16:00', end: '18:00' }]); };
  const remove = (key) => { setSaved(false); setRows((current) => current.filter((row) => row.key !== key)); };
  const copyMonday = () => {
    const monday = rows.filter((row) => row.weekday === 1);
    setSaved(false);
    setRows([...rows.filter((row) => row.weekday === 1 || row.weekday > 5), ...[2, 3, 4, 5].flatMap((weekday) => monday.map((row) => ({ ...row, key: `new${rowKey += 1}`, weekday })))]);
  };

  const save = async () => {
    if (!parsed.success) return;
    setBusy(true);
    setError(null);
    try {
      onSaved(await classesWrite('classes/availability', body));
      setSaved(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3" aria-labelledby="weekly-hours-title">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="weekly-hours-title" className="text-sm font-semibold">Weekly hours</h3>
        {canEdit && rows.some((row) => row.weekday === 1) && (
          <Button type="button" size="sm" variant="ghost" className="ml-auto" onClick={copyMonday}>Copy Monday to Tue–Fri</Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">Leave every day empty if this person can teach at any time.</p>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {WEEKDAYS.map((weekday) => {
          const dayRows = rows.filter((row) => row.weekday === weekday);
          return (
            <li key={weekday} className="flex flex-wrap items-start gap-2 p-2 text-sm">
              <span className="w-24 pt-2 font-medium">{WEEKDAY_LONG[weekday]}</span>
              <div className="min-w-0 flex-1 space-y-2">
                {/* With no hours at all the person is available any time (D4). */}
                {!dayRows.length && <p className="pt-2 text-muted-foreground">{rows.length ? 'Not available' : 'Any time'}</p>}
                {dayRows.map((row) => (
                  <div key={row.key} className="flex items-center gap-2">
                    <Input type="time" aria-label={`${WEEKDAY_LONG[weekday]} from`} className="w-32" value={row.start} disabled={!canEdit} onChange={(event) => update(row.key, 'start', event.target.value)} />
                    <span aria-hidden="true">–</span>
                    <Input type="time" aria-label={`${WEEKDAY_LONG[weekday]} until`} className="w-32" value={row.end} disabled={!canEdit} onChange={(event) => update(row.key, 'end', event.target.value)} />
                    {canEdit && (
                      <Button type="button" size="icon" variant="ghost" aria-label={`Remove ${WEEKDAY_LONG[weekday]} ${row.start}–${row.end}`} onClick={() => remove(row.key)}>
                        <X className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
              {canEdit && (
                <Button type="button" size="sm" variant="ghost" aria-label={`Add hours on ${WEEKDAY_LONG[weekday]}`} onClick={() => add(weekday)}>
                  <Plus className="h-4 w-4" aria-hidden="true" />
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {!parsed.success && rows.length > 0 && <p className="text-xs text-destructive">{errors.windows || Object.values(errors)[0]}</p>}
      {error && <Alert variant="destructive"><AlertDescription>{error.message}</AlertDescription></Alert>}
      {canEdit && (
        <div className="flex items-center justify-end gap-3">
          {saved && <span className="text-xs text-success-soft-foreground">Saved</span>}
          <Button type="button" onClick={save} disabled={busy || !parsed.success}>Save weekly hours</Button>
        </div>
      )}
    </section>
  );
}

function leaveLabel(exception) {
  const days = exception.startsOn === exception.endsOn ? formatDay(exception.startsOn) : `${formatDay(exception.startsOn)} – ${formatDay(exception.endsOn)}`;
  return exception.start ? `${days}, ${exception.start}–${exception.end}` : days;
}

function Leave({ userId, exceptions, canEdit, timezone, onSaved }) {
  const [form, setForm] = useState(() => {
    const today = localDate(Date.now(), timezone);
    return { startsOn: today, endsOn: today, wholeDay: true, start: '09:00', end: '13:00', reason: 'Leave' };
  });
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.type === 'checkbox' ? event.target.checked : event.target.value }));
  const body = {
    userId, startsOn: form.startsOn, endsOn: form.endsOn || form.startsOn, reason: form.reason.trim(),
    ...(form.wholeDay ? {} : { start: form.start, end: form.end }),
  };
  const parsed = exceptionBody.safeParse(body);
  const errors = touched ? fieldErrors(parsed) : {};

  const run = async (path, payload) => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await classesWrite(path, payload));
      return true;
    } catch (err) {
      setError(err);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    setTouched(true);
    if (!parsed.success) return;
    if (await run('classes/availability/exceptions', body)) setTouched(false);
  };

  return (
    <section className="space-y-3" aria-labelledby="leave-title">
      <h3 id="leave-title" className="text-sm font-semibold">Leave and time off</h3>
      {exceptions.length
        ? (
          <ul className="divide-y divide-border rounded-lg border border-border text-sm">
            {exceptions.map((exception) => (
              <li key={exception.id} className="flex flex-wrap items-center gap-2 p-2">
                <span className="font-medium">{leaveLabel(exception)}</span>
                <span className="text-muted-foreground">{exception.reason}</span>
                {canEdit && (
                  <Button size="sm" variant="ghost" className="ml-auto text-muted-foreground" disabled={busy} onClick={() => run('classes/availability/exceptions/remove', { exceptionId: exception.id })}>
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )
        : <p className="text-sm text-muted-foreground">No leave planned.</p>}
      {canEdit && (
        <form className="space-y-3 rounded-lg border border-dashed border-border p-3" onSubmit={submit} noValidate>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="From" htmlFor="leave-from" error={errors.startsOn}>
              <Input id="leave-from" type="date" value={form.startsOn} onChange={set('startsOn')} />
            </Field>
            <Field label="Until" htmlFor="leave-until" error={errors.endsOn}>
              <Input id="leave-until" type="date" value={form.endsOn} onChange={set('endsOn')} />
            </Field>
            <Field label="Reason" htmlFor="leave-reason" error={errors.reason}>
              <Input id="leave-reason" maxLength={80} value={form.reason} onChange={set('reason')} />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="h-4 w-4" checked={form.wholeDay} onChange={set('wholeDay')} />
            Whole day
          </label>
          {!form.wholeDay && (
            <div className="flex flex-wrap items-center gap-2">
              <Input type="time" aria-label="Away from" className="w-32" value={form.start} onChange={set('start')} />
              <span aria-hidden="true">–</span>
              <Input type="time" aria-label="Away until" className="w-32" value={form.end} onChange={set('end')} />
              {errors.end && <span className="text-xs text-destructive">{errors.end}</span>}
            </div>
          )}
          {error && <Alert variant="destructive"><AlertDescription>{error.message}</AlertDescription></Alert>}
          <div className="flex justify-end"><Button type="submit" variant="outline" disabled={busy}>Add leave</Button></div>
        </form>
      )}
    </section>
  );
}

export default function AvailabilityDialog({ open, onOpenChange, userId, me, onChanged }) {
  const [state, setState] = useState({ status: 'loading', data: null, error: null });
  const load = useCallback(async () => {
    try {
      setState({ status: 'ready', data: await crmFetch(`classes/availability?${new URLSearchParams({ userId })}`), error: null });
    } catch (error) {
      setState({ status: 'error', data: null, error });
    }
  }, [userId]);
  useEffect(() => {
    if (!open || !userId) return;
    // Never show the previous person's (possibly editable) hours while loading.
    setState({ status: 'loading', data: null, error: null });
    load();
  }, [open, userId, load]);

  const saved = (data) => { setState({ status: 'ready', data, error: null }); onChanged?.(); };
  const own = userId === me.user.id;
  const data = state.data;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{own ? 'Your availability' : `${data?.name || 'Instructor'}'s availability`}</DialogTitle>
          <DialogDescription>
            Times are in {me.school.timezone === 'Asia/Kolkata' ? 'IST' : me.school.timezone}. The timetable warns when a class falls outside these hours or on leave.
          </DialogDescription>
        </DialogHeader>
        {state.status === 'loading' && <Skeleton className="h-64 w-full" />}
        {state.status === 'error' && <Alert variant="destructive"><AlertDescription>{state.error.message}</AlertDescription></Alert>}
        {state.status === 'ready' && (
          <div className="space-y-6">
            <WeeklyHours userId={userId} initial={data.windows} canEdit={data.canEdit} onSaved={saved} />
            <Leave userId={userId} exceptions={data.exceptions} canEdit={data.canEdit} timezone={me.school.timezone} onSaved={saved} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
