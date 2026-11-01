// Classes → Rooms & holidays → Holidays (FLKRM-327 S4, D6). Adding a holiday
// shows how many scheduled classes it cancels first; removing one never
// brings classes back.
import { useCallback, useEffect, useState } from 'react';
import { Alert, AlertDescription } from '../../ui/Alert';
import { Button } from '../../ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/Card';
import { Input } from '../../ui/Input';
import { Skeleton } from '../../ui/Skeleton';
import { crmFetch } from '../../../lib/crm/api';
import { classesWrite, formatDay } from '../../../lib/crm/classes';
import { fieldErrors } from '../../../../shared/crm/leads.js';
import { holidayBody } from '../../../../shared/crm/timetable.js';
import { Field } from '../leads/leadUi';

function range(holiday) {
  return holiday.startsOn === holiday.endsOn ? formatDay(holiday.startsOn) : `${formatDay(holiday.startsOn)} – ${formatDay(holiday.endsOn)}`;
}

export default function HolidaysCard({ me, onChanged }) {
  const canWrite = me.capabilities.includes('crm.classes.write');
  const [state, setState] = useState({ status: 'loading', items: [], error: null });
  const [form, setForm] = useState({ startsOn: '', endsOn: '', label: '' });
  const [touched, setTouched] = useState(false);
  const [impact, setImpact] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    try {
      setState({ status: 'ready', items: (await crmFetch('classes/holidays')).items, error: null });
    } catch (err) {
      setState({ status: 'error', items: [], error: err });
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const body = { startsOn: form.startsOn, endsOn: form.endsOn || form.startsOn, label: form.label.trim() };
  const parsed = holidayBody.safeParse(body);
  const errors = touched ? fieldErrors(parsed) : {};

  // Preview the classes the holiday would cancel as soon as the dates are valid.
  useEffect(() => {
    if (!canWrite || !form.startsOn || (form.endsOn && form.endsOn < form.startsOn)) { setImpact(null); return undefined; }
    const timer = setTimeout(() => {
      crmFetch(`classes/holidays/impact?${new URLSearchParams({ startsOn: form.startsOn, endsOn: form.endsOn || form.startsOn })}`)
        .then(setImpact).catch(() => setImpact(null));
    }, 200);
    return () => clearTimeout(timer);
  }, [canWrite, form.startsOn, form.endsOn]);

  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const add = async (event) => {
    event.preventDefault();
    setTouched(true);
    if (!parsed.success) return;
    setBusy(true);
    setError(null);
    try {
      const result = await classesWrite('classes/holidays', parsed.data);
      setNotice(`${result.holiday.label} added. ${result.sessionsCancelled} class${result.sessionsCancelled === 1 ? '' : 'es'} cancelled.`);
      setForm({ startsOn: '', endsOn: '', label: '' });
      setTouched(false);
      load();
      onChanged?.();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (holiday) => {
    setError(null);
    try {
      await classesWrite('classes/holidays/remove', { holidayId: holiday.id });
      setNotice(`${holiday.label} removed. Cancelled classes stay cancelled; undo them one by one if needed.`);
      load();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle className="text-base">Holidays</CardTitle>
        <CardDescription>Days the school is closed. Timetables skip them, and adding one cancels the classes already planned.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {notice && <Alert variant="success"><AlertDescription>{notice}</AlertDescription></Alert>}
        {error && <Alert variant="destructive"><AlertDescription>{error.message}</AlertDescription></Alert>}
        {state.status === 'loading' && <Skeleton className="h-16 w-full" />}
        {state.status === 'error' && <Alert variant="destructive"><AlertDescription>{state.error.message}</AlertDescription></Alert>}
        {state.status === 'ready' && !state.items.length && <p className="text-sm text-muted-foreground">No holidays yet.</p>}
        {state.items.length > 0 && (
          <ul className="divide-y divide-border text-sm">
            {state.items.map((holiday) => (
              <li key={holiday.id} className="flex flex-wrap items-center gap-2 py-2">
                <span className="font-medium">{holiday.label}</span>
                <span className="text-muted-foreground">{range(holiday)}</span>
                {canWrite && <Button size="sm" variant="ghost" className="ml-auto text-muted-foreground" onClick={() => remove(holiday)}>Remove</Button>}
              </li>
            ))}
          </ul>
        )}
        {canWrite && (
          <form className="space-y-3 rounded-lg border border-dashed border-border p-3" onSubmit={add} noValidate>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Holiday name" htmlFor="holiday-label" error={errors.label}>
                <Input id="holiday-label" maxLength={60} placeholder="Diwali" value={form.label} onChange={set('label')} />
              </Field>
              <Field label="From" htmlFor="holiday-from" error={errors.startsOn}>
                <Input id="holiday-from" type="date" value={form.startsOn} onChange={set('startsOn')} />
              </Field>
              <Field label="Until (optional)" htmlFor="holiday-until" error={errors.endsOn}>
                <Input id="holiday-until" type="date" value={form.endsOn} min={form.startsOn} onChange={set('endsOn')} />
              </Field>
            </div>
            {impact && (
              <p className="text-sm text-muted-foreground" aria-live="polite">
                {impact.sessions
                  ? `This cancels ${impact.sessions} class${impact.sessions === 1 ? '' : 'es'}: ${impact.batches.map((batch) => `${batch.name} (${batch.sessions})`).join(', ')}.`
                  : 'No classes are planned on these dates.'}
              </p>
            )}
            <div className="flex justify-end">
              <Button type="submit" disabled={busy}>{impact?.sessions ? `Add holiday and cancel ${impact.sessions}` : 'Add holiday'}</Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
