// Timetable forms (FLKRM-327 S3, D5/D7): add or change a weekly timetable,
// end one, and add a one-off class. A clash or availability problem shows a
// panel; "Save anyway" resubmits with the override, which is audited.
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Alert, AlertDescription } from '../../ui/Alert';
import { Button } from '../../ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../ui/Dialog';
import { Input } from '../../ui/Input';
import { Select } from '../../ui/Select';
import { crmFetch } from '../../../lib/crm/api';
import { classesWrite, formatDay, sampleDates, textOrNull } from '../../../lib/crm/classes';
import { WEEKDAYS, WEEKDAY_SHORT } from '../../../../shared/crm/availability.js';
import { fieldErrors } from '../../../../shared/crm/leads.js';
import { addDays, localDate } from '../../../../shared/crm/time.js';
import { MAX_RULE_DAYS, endRuleBody, oneOffSessionBody, ruleBody, ruleDates, updateRuleBody } from '../../../../shared/crm/timetable.js';
import { Field } from '../leads/leadUi';
import { FormFooter } from './ClassDialogs';

function tzLabel(timezone) {
  return timezone === 'Asia/Kolkata' ? 'IST' : timezone;
}

function conflictLine(conflict, batchName) {
  const when = `${conflict.time} on ${sampleDates(conflict.dates, conflict.count)}`;
  if (conflict.kind === 'instructor') return `${conflict.instructorName || 'This instructor'} is already teaching ${conflict.otherBatch.name} at ${when}.`;
  if (conflict.kind === 'room') return `${conflict.roomName || 'This room'} is booked for ${conflict.otherBatch.name} at ${when}.`;
  return `${batchName} already has a class at ${when}.`;
}

function availabilityLine(issue, instructorName) {
  const dates = sampleDates(issue.dates, issue.count);
  if (issue.kind === 'on_leave') return `${instructorName || 'The instructor'} is away (${issue.reason}) on ${dates}.`;
  return `Outside ${instructorName || 'the instructor'}'s weekly hours on ${dates}.`;
}

/** What clashes or doesn't suit, with "Save anyway". */
export function ConflictPanel({ details, batchName, instructorName, busy, onSaveAnyway, onDismiss }) {
  return (
    <div role="alert" className="space-y-2 rounded-lg border border-warning-soft-foreground/30 bg-warning-soft p-3 text-sm text-warning-soft-foreground">
      <p className="flex items-center gap-2 font-semibold"><AlertTriangle className="h-4 w-4" aria-hidden="true" />Check before saving</p>
      <ul className="list-disc space-y-1 pl-5">
        {details.conflicts.map((conflict) => <li key={`${conflict.kind}-${conflict.otherBatch.id}-${conflict.time}`}>{conflictLine(conflict, batchName)}</li>)}
        {details.availability.map((issue) => <li key={`${issue.kind}-${issue.reason}`}>{availabilityLine(issue, instructorName)}</li>)}
      </ul>
      <p className="text-xs">Save anyway for a combined class or a planned exception; the override is recorded.</p>
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="outline" onClick={onDismiss} disabled={busy}>Change it</Button>
        <Button type="button" size="sm" onClick={onSaveAnyway} disabled={busy}>Save anyway</Button>
      </div>
    </div>
  );
}

export function CapacityNote({ capacity }) {
  if (!capacity) return null;
  return <p className="text-xs text-warning-soft-foreground">{capacity.students} students, but only {capacity.capacity} seats. Nobody is turned away; consider a bigger room.</p>;
}

function useBatchInstructors(open, batchId) {
  const [items, setItems] = useState([]);
  useEffect(() => {
    if (!open || !batchId) return;
    crmFetch(`classes/batches/instructors?${new URLSearchParams({ batchId })}`)
      .then((result) => setItems(result.items.filter((item) => item.status === 'active')))
      .catch(() => setItems([]));
  }, [open, batchId]);
  return items;
}

function InstructorOptions({ instructors, current }) {
  const people = new Map();
  for (const item of instructors) {
    if (!people.has(item.userId)) people.set(item.userId, { name: item.name, subjects: [] });
    people.get(item.userId).subjects.push(item.subject?.name || 'All subjects');
  }
  if (current && !people.has(current.userId)) people.set(current.userId, { name: `${current.name || 'Instructor'} (not assigned now)`, subjects: [] });
  return [...people.entries()].map(([userId, person]) => (
    <option key={userId} value={userId}>{person.name}{person.subjects.length ? ` · ${person.subjects.join(', ')}` : ''}</option>
  ));
}

function DayPicker({ value, onChange, error }) {
  const toggle = (day) => onChange(value.includes(day) ? value.filter((item) => item !== day) : [...value, day].sort((a, b) => a - b));
  return (
    <div>
      <p className="mb-1.5 text-sm font-medium">Days</p>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Days">
        {WEEKDAYS.map((day) => (
          <Button key={day} type="button" size="sm" variant={value.includes(day) ? 'default' : 'outline'} aria-pressed={value.includes(day)} onClick={() => toggle(day)}>
            {WEEKDAY_SHORT[day]}
          </Button>
        ))}
      </div>
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  );
}

function initialRuleForm(rule, batch, timezone) {
  const today = localDate(Date.now(), timezone);
  if (rule) {
    return {
      subjectId: rule.subject?.id || '', instructorUserId: rule.instructor.userId, weekdays: rule.weekdays, startTime: rule.startTime, endTime: rule.endTime,
      roomId: rule.room?.id || '', onlineUrl: rule.onlineUrl || '', validFrom: rule.validFrom, applyFrom: rule.validFrom > today ? rule.validFrom : today, validUntil: rule.validUntil,
    };
  }
  const validFrom = batch.startsOn && batch.startsOn > today ? batch.startsOn : today;
  const cap = addDays(validFrom, MAX_RULE_DAYS - 1);
  const end = batch.endsOn || batch.academicYear?.endsOn || addDays(validFrom, 90);
  return {
    subjectId: batch.subject?.id || '', instructorUserId: batch.lead?.userId || '', weekdays: [], startTime: '16:00', endTime: '17:00',
    roomId: batch.defaultRoom?.status === 'active' ? batch.defaultRoom.id : '', onlineUrl: batch.defaultOnlineUrl || '', validFrom, applyFrom: validFrom,
    validUntil: end > cap ? cap : end,
  };
}

/** New weekly timetable for `batch`, or a change to `rule` from a chosen date. */
export function RuleDialog({ open, onOpenChange, batch, rule, options, me, onSaved }) {
  const timezone = me.school.timezone;
  const instructors = useBatchInstructors(open, batch.id);
  const [form, setForm] = useState(null);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [conflict, setConflict] = useState(null);

  useEffect(() => {
    if (!open) return;
    setForm(initialRuleForm(rule, batch, timezone));
    setTouched(false);
    setError(null);
    setConflict(null);
  }, [open, rule, batch, timezone]);

  // The lead may load after the form opens.
  useEffect(() => {
    if (!form || form.instructorUserId || !instructors.length) return;
    setForm((current) => ({ ...current, instructorUserId: (instructors.find((item) => item.isLead) || instructors[0]).userId }));
  }, [instructors, form]);

  const preview = useMemo(() => {
    if (!form || !form.weekdays.length) return 0;
    const from = rule ? form.applyFrom : form.validFrom;
    if (!from || !form.validUntil || form.validUntil < from) return 0;
    return ruleDates({ weekdays: form.weekdays, validFrom: from, validUntil: form.validUntil }).length;
  }, [form, rule]);

  if (!form) return null;
  const set = (key) => (event) => { setConflict(null); setForm((current) => ({ ...current, [key]: event.target.value })); };
  const body = {
    subjectId: textOrNull(form.subjectId), instructorUserId: form.instructorUserId, weekdays: form.weekdays, startTime: form.startTime, endTime: form.endTime,
    roomId: textOrNull(form.roomId), onlineUrl: textOrNull(form.onlineUrl), validUntil: form.validUntil,
    ...(rule ? { ruleId: rule.id, expectedVersion: rule.version, applyFrom: form.applyFrom } : { batchId: batch.id, validFrom: form.validFrom }),
  };
  const parsed = (rule ? updateRuleBody : ruleBody).safeParse(body);
  const errors = touched ? fieldErrors(parsed) : {};
  const instructorName = instructors.find((item) => item.userId === form.instructorUserId)?.name || rule?.instructor.name;

  const save = async (acknowledgeConflicts = false) => {
    setTouched(true);
    if (!parsed.success) return;
    setBusy(true);
    setError(null);
    try {
      const result = await classesWrite(rule ? 'classes/rules/update' : 'classes/rules', { ...body, ...(acknowledgeConflicts ? { acknowledgeConflicts: true } : {}) });
      setConflict(null);
      onSaved(result);
    } catch (err) {
      if (err.code === 'schedule_conflict') setConflict(err.details);
      else setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{rule ? 'Change timetable' : `New timetable for ${batch.name}`}</DialogTitle>
          <DialogDescription>
            {rule
              ? 'Classes before the change date, and classes already taken, cancelled or changed by hand, stay as they are.'
              : `A weekly slot. Each matching date becomes a class. Times are in ${tzLabel(timezone)}.`}
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); save(false); }} noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Subject (optional)" htmlFor="rule-subject">
              <Select id="rule-subject" value={form.subjectId} onChange={set('subjectId')}>
                <option value="">No single subject</option>
                {(options?.subjects || []).map((subject) => <option key={subject.id} value={subject.id}>{subject.name}</option>)}
              </Select>
            </Field>
            <Field label="Instructor" htmlFor="rule-instructor" error={errors.instructorUserId} hint={!instructors.length ? 'Assign instructors on the Instructors tab first' : undefined}>
              <Select id="rule-instructor" value={form.instructorUserId} onChange={set('instructorUserId')}>
                <option value="">Choose an instructor</option>
                <InstructorOptions instructors={instructors} current={rule?.instructor} />
              </Select>
            </Field>
          </div>
          <DayPicker value={form.weekdays} onChange={(weekdays) => { setConflict(null); setForm((current) => ({ ...current, weekdays })); }} error={errors.weekdays} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={`Starts (${tzLabel(timezone)})`} htmlFor="rule-start" error={errors.startTime}>
              <Input id="rule-start" type="time" value={form.startTime} onChange={set('startTime')} />
            </Field>
            <Field label={`Ends (${tzLabel(timezone)})`} htmlFor="rule-end" error={errors.endTime}>
              <Input id="rule-end" type="time" value={form.endTime} onChange={set('endTime')} />
            </Field>
            <Field label="Room (optional)" htmlFor="rule-room">
              <Select id="rule-room" value={form.roomId} onChange={set('roomId')}>
                <option value="">No room</option>
                {(options?.rooms || []).map((room) => <option key={room.id} value={room.id}>{room.seats ? `${room.name} · ${room.seats} seats` : room.name}</option>)}
              </Select>
            </Field>
            <Field label="Online link (optional)" htmlFor="rule-link" error={errors.onlineUrl}>
              <Input id="rule-link" type="url" placeholder="https://" value={form.onlineUrl} onChange={set('onlineUrl')} />
            </Field>
            {rule
              ? (
                <Field label="Changes apply from" htmlFor="rule-apply" error={errors.applyFrom} hint={`This timetable started ${formatDay(rule.validFrom)}`}>
                  <Input id="rule-apply" type="date" min={rule.validFrom} value={form.applyFrom} onChange={set('applyFrom')} />
                </Field>
              )
              : (
                <Field label="First date" htmlFor="rule-from" error={errors.validFrom}>
                  <Input id="rule-from" type="date" value={form.validFrom} onChange={set('validFrom')} />
                </Field>
              )}
            <Field label="Last date" htmlFor="rule-until" error={errors.validUntil} hint="At most a year">
              <Input id="rule-until" type="date" value={form.validUntil} onChange={set('validUntil')} />
            </Field>
          </div>
          {preview > 0 && <p className="text-sm text-muted-foreground">{rule ? 'From the change date' : 'This'} makes about {preview} class{preview === 1 ? '' : 'es'} (holidays are skipped).</p>}
          {conflict && (
            <ConflictPanel details={conflict} batchName={batch.name} instructorName={instructorName} busy={busy} onSaveAnyway={() => save(true)} onDismiss={() => setConflict(null)} />
          )}
          {error && <Alert variant="destructive"><AlertDescription>{error.code === 'version_conflict' ? 'Someone else changed this timetable meanwhile. Close and reopen to see the latest.' : error.message}</AlertDescription></Alert>}
          {!conflict && <FormFooter busy={busy} onCancel={() => onOpenChange(false)} submitLabel={rule ? 'Save changes' : 'Create timetable'} />}
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Stop a timetable after a date; later plain classes are removed. */
export function EndRuleDialog({ open, onOpenChange, rule, me, onEnded }) {
  const [lastDate, setLastDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!open || !rule) return;
    const today = localDate(Date.now(), me.school.timezone);
    setLastDate(today < rule.validUntil ? today : rule.validUntil);
    setError(null);
  }, [open, rule, me.school.timezone]);
  if (!rule) return null;
  const parsed = endRuleBody.safeParse({ ruleId: rule.id, expectedVersion: rule.version, lastDate });
  const submit = async (event) => {
    event.preventDefault();
    if (!parsed.success) return;
    setBusy(true);
    setError(null);
    try {
      onEnded(await classesWrite('classes/rules/end', parsed.data));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>End this timetable</DialogTitle>
          <DialogDescription>Classes after the last date are removed, unless they were taken, cancelled or changed by hand.</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit}>
          <Field label="Last class date" htmlFor="end-last">
            <Input id="end-last" type="date" max={rule.validUntil} value={lastDate} onChange={(event) => setLastDate(event.target.value)} />
          </Field>
          {error && <Alert variant="destructive"><AlertDescription>{error.message}</AlertDescription></Alert>}
          <FormFooter busy={busy} onCancel={() => onOpenChange(false)} submitLabel="End timetable" disabled={!parsed.success} />
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** An extra class outside the weekly timetable. */
export function OneOffDialog({ open, onOpenChange, batch, options, me, onSaved }) {
  const timezone = me.school.timezone;
  const instructors = useBatchInstructors(open, batch.id);
  const [form, setForm] = useState(null);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [conflict, setConflict] = useState(null);

  useEffect(() => {
    if (!open) return;
    setForm({
      subjectId: batch.subject?.id || '', instructorUserId: batch.lead?.userId || '', localDate: localDate(Date.now(), timezone),
      startTime: '10:00', endTime: '11:00', roomId: batch.defaultRoom?.status === 'active' ? batch.defaultRoom.id : '', onlineUrl: batch.defaultOnlineUrl || '',
    });
    setTouched(false);
    setError(null);
    setConflict(null);
  }, [open, batch, timezone]);

  if (!form) return null;
  const set = (key) => (event) => { setConflict(null); setForm((current) => ({ ...current, [key]: event.target.value })); };
  const body = {
    batchId: batch.id, subjectId: textOrNull(form.subjectId), instructorUserId: form.instructorUserId, localDate: form.localDate,
    startTime: form.startTime, endTime: form.endTime, roomId: textOrNull(form.roomId), onlineUrl: textOrNull(form.onlineUrl),
  };
  const parsed = oneOffSessionBody.safeParse(body);
  const errors = touched ? fieldErrors(parsed) : {};

  const save = async (acknowledgeConflicts = false) => {
    setTouched(true);
    if (!parsed.success) return;
    setBusy(true);
    setError(null);
    try {
      onSaved(await classesWrite('classes/sessions', { ...body, ...(acknowledgeConflicts ? { acknowledgeConflicts: true } : {}) }));
    } catch (err) {
      if (err.code === 'schedule_conflict') setConflict(err.details);
      else setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add a one-off class</DialogTitle>
          <DialogDescription>An extra or revision class for {batch.name}, outside the weekly timetable.</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); save(false); }} noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Date" htmlFor="one-date" error={errors.localDate}>
              <Input id="one-date" type="date" value={form.localDate} onChange={set('localDate')} />
            </Field>
            <Field label="Instructor" htmlFor="one-instructor" error={errors.instructorUserId}>
              <Select id="one-instructor" value={form.instructorUserId} onChange={set('instructorUserId')}>
                <option value="">Choose an instructor</option>
                <InstructorOptions instructors={instructors} />
              </Select>
            </Field>
            <Field label={`Starts (${tzLabel(timezone)})`} htmlFor="one-start" error={errors.startTime}>
              <Input id="one-start" type="time" value={form.startTime} onChange={set('startTime')} />
            </Field>
            <Field label={`Ends (${tzLabel(timezone)})`} htmlFor="one-end" error={errors.endTime}>
              <Input id="one-end" type="time" value={form.endTime} onChange={set('endTime')} />
            </Field>
            <Field label="Subject (optional)" htmlFor="one-subject">
              <Select id="one-subject" value={form.subjectId} onChange={set('subjectId')}>
                <option value="">No single subject</option>
                {(options?.subjects || []).map((subject) => <option key={subject.id} value={subject.id}>{subject.name}</option>)}
              </Select>
            </Field>
            <Field label="Room (optional)" htmlFor="one-room">
              <Select id="one-room" value={form.roomId} onChange={set('roomId')}>
                <option value="">No room</option>
                {(options?.rooms || []).map((room) => <option key={room.id} value={room.id}>{room.name}</option>)}
              </Select>
            </Field>
          </div>
          <Field label="Online link (optional)" htmlFor="one-link" error={errors.onlineUrl}>
            <Input id="one-link" type="url" placeholder="https://" value={form.onlineUrl} onChange={set('onlineUrl')} />
          </Field>
          {conflict && (
            <ConflictPanel details={conflict} batchName={batch.name} instructorName={instructors.find((item) => item.userId === form.instructorUserId)?.name} busy={busy} onSaveAnyway={() => save(true)} onDismiss={() => setConflict(null)} />
          )}
          {error && <Alert variant="destructive"><AlertDescription>{error.message}</AlertDescription></Alert>}
          {!conflict && <FormFooter busy={busy} onCancel={() => onOpenChange(false)} submitLabel="Add class" />}
        </form>
      </DialogContent>
    </Dialog>
  );
}

