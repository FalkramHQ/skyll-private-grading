// One class session (FLKRM-327 S4, D6): details, and for people with classes
// write: a substitute or a different room/link, cancel with a reason, and
// undo a cancel while the class is still ahead.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import { Alert, AlertDescription } from '../../ui/Alert';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../ui/Dialog';
import { Input } from '../../ui/Input';
import { Select } from '../../ui/Select';
import { crmFetch } from '../../../lib/crm/api';
import { classesWrite, formatTime, formatWeekday, textOrNull } from '../../../lib/crm/classes';
import { cancelSessionBody } from '../../../../shared/crm/timetable.js';
import { Field } from '../leads/leadUi';
import { SessionStatus } from './SessionCard';
import { ConflictPanel } from './TimetableDialogs';

const CANCEL_REASONS = ['Teacher unwell', 'Teacher on leave', 'School closed', 'Exam', 'Other'];

function Detail({ label, children }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd>{children || <span className="text-muted-foreground">—</span>}</dd>
    </div>
  );
}

function ChangeForm({ session, options, onSaved, onCancel }) {
  const [people, setPeople] = useState([]);
  const [form, setForm] = useState({ instructorUserId: session.instructor.userId, roomId: session.room?.id || '', onlineUrl: session.onlineUrl || '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [conflict, setConflict] = useState(null);
  useEffect(() => {
    crmFetch('classes/instructors').then((result) => setPeople(result.items)).catch(() => setPeople([]));
  }, []);
  const set = (key) => (event) => { setConflict(null); setForm((current) => ({ ...current, [key]: event.target.value })); };
  const save = async (acknowledgeConflicts = false) => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await classesWrite('classes/sessions/update', {
        sessionId: session.id, expectedVersion: session.version, instructorUserId: form.instructorUserId,
        roomId: textOrNull(form.roomId), onlineUrl: textOrNull(form.onlineUrl), ...(acknowledgeConflicts ? { acknowledgeConflicts: true } : {}),
      }));
    } catch (err) {
      if (err.code === 'schedule_conflict') setConflict(err.details);
      else setError(err);
    } finally {
      setBusy(false);
    }
  };
  const rooms = options?.rooms || [];
  return (
    <form className="space-y-3 rounded-lg border border-border p-3" onSubmit={(event) => { event.preventDefault(); save(false); }}>
      <p className="text-sm font-semibold">Change this class only</p>
      <Field label="Instructor" htmlFor="session-instructor" hint="A substitute can be any teacher or admin">
        <Select id="session-instructor" value={form.instructorUserId} onChange={set('instructorUserId')}>
          {!people.some((person) => person.userId === session.instructor.userId) && <option value={session.instructor.userId}>{session.instructor.name}</option>}
          {people.map((person) => <option key={person.userId} value={person.userId}>{person.name}</option>)}
        </Select>
      </Field>
      <Field label="Room" htmlFor="session-room">
        <Select id="session-room" value={form.roomId} onChange={set('roomId')}>
          <option value="">No room</option>
          {session.room && !rooms.some((room) => room.id === session.room.id) && <option value={session.room.id}>{session.room.name}</option>}
          {rooms.map((room) => <option key={room.id} value={room.id}>{room.name}</option>)}
        </Select>
      </Field>
      <Field label="Online link" htmlFor="session-link">
        <Input id="session-link" type="url" placeholder="https://" value={form.onlineUrl} onChange={set('onlineUrl')} />
      </Field>
      <p className="text-xs text-muted-foreground">The time can&apos;t change here. To move a class, cancel it and add a one-off class.</p>
      {conflict && <ConflictPanel details={conflict} batchName={session.batch.name} instructorName={people.find((person) => person.userId === form.instructorUserId)?.name} busy={busy} onSaveAnyway={() => save(true)} onDismiss={() => setConflict(null)} />}
      {error && <Alert variant="destructive"><AlertDescription>{error.code === 'version_conflict' ? 'This class changed meanwhile. Close and reopen it.' : error.message}</AlertDescription></Alert>}
      {!conflict && (
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={busy}>Back</Button>
          <Button type="submit" size="sm" disabled={busy}>Save</Button>
        </div>
      )}
    </form>
  );
}

function CancelForm({ session, onSaved, onBack }) {
  const [choice, setChoice] = useState(CANCEL_REASONS[0]);
  const [other, setOther] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const reason = choice === 'Other' ? other.trim() : choice;
  const parsed = cancelSessionBody.safeParse({ sessionId: session.id, expectedVersion: session.version, reason });
  const submit = async (event) => {
    event.preventDefault();
    if (!parsed.success) return;
    setBusy(true);
    setError(null);
    try {
      onSaved(await classesWrite('classes/sessions/cancel', parsed.data));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="space-y-3 rounded-lg border border-destructive/30 p-3" onSubmit={submit}>
      <p className="text-sm font-semibold">Cancel this class</p>
      <Field label="Reason" htmlFor="cancel-reason">
        <Select id="cancel-reason" value={choice} onChange={(event) => setChoice(event.target.value)}>
          {CANCEL_REASONS.map((item) => <option key={item}>{item}</option>)}
        </Select>
      </Field>
      {choice === 'Other' && (
        <Field label="Say why" htmlFor="cancel-other">
          <Input id="cancel-other" maxLength={280} value={other} onChange={(event) => setOther(event.target.value)} autoFocus />
        </Field>
      )}
      {error && <Alert variant="destructive"><AlertDescription>{error.message}</AlertDescription></Alert>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onBack} disabled={busy}>Keep the class</Button>
        <Button type="submit" variant="destructive" size="sm" disabled={busy || !parsed.success}>Cancel class</Button>
      </div>
    </form>
  );
}

export default function SessionDialog({ session: initial, me, options, onOpenChange, onChanged }) {
  const [shown, setShown] = useState(initial);
  const [session, setSession] = useState(initial);
  const [mode, setMode] = useState('view');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [conflict, setConflict] = useState(null);
  const [openedAt, setOpenedAt] = useState(() => new Date().toISOString());
  // A different session opens fresh. Reset during render, not in an effect, so a
  // click made just after opening isn't undone (see src/lib/crm/useDraft.js).
  if (shown !== initial) {
    setShown(initial);
    setSession(initial);
    setMode('view');
    setError(null);
    setConflict(null);
    setOpenedAt(new Date().toISOString());
  }
  if (!session) return null;

  const timezone = me.school.timezone;
  const canWrite = me.capabilities.includes('crm.classes.write');
  const future = session.startsAt > openedAt;
  const changed = (updated) => {
    // The leave flag belongs to the original instructor; the list recomputes it on reload.
    const sameInstructor = updated.instructor.userId === session.instructor.userId;
    setSession({ ...updated, onLeave: sameInstructor && updated.status === 'scheduled' ? session.onLeave : false });
    setMode('view');
    setConflict(null);
    onChanged?.();
  };
  const restore = async (acknowledgeConflicts = false) => {
    setBusy(true);
    setError(null);
    try {
      changed(await classesWrite('classes/sessions/restore', { sessionId: session.id, expectedVersion: session.version, ...(acknowledgeConflicts ? { acknowledgeConflicts: true } : {}) }));
    } catch (err) {
      if (err.code === 'schedule_conflict') setConflict(err.details);
      else setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={Boolean(initial)} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{session.batch.name}</DialogTitle>
          <DialogDescription>
            {formatWeekday(session.localDate)} · {formatTime(session.startsAt, timezone)}–{formatTime(session.endsAt, timezone)}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-1">
          <SessionStatus session={session} />
          {session.status === 'scheduled' && !session.notMarked && <Badge variant="outline">Scheduled</Badge>}
          {session.isEdited && <Badge variant="outline">Changed by hand</Badge>}
          {session.onLeave && <Badge variant="warning">Instructor on leave</Badge>}
        </div>
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <Detail label="Instructor">{session.instructor.name}</Detail>
          <Detail label="Subject">{session.subject?.name}</Detail>
          <Detail label="Room">{session.room?.name}</Detail>
          <Detail label="Online link">
            {session.onlineUrl && <a href={session.onlineUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">Open<ExternalLink className="h-3 w-3" aria-hidden="true" /></a>}
          </Detail>
          {session.status === 'cancelled' && <Detail label="Cancelled because">{session.cancelReason}</Detail>}
          {session.capacity && <Detail label="Seats">{session.capacity}</Detail>}
        </dl>
        {session.onLeave && session.status === 'scheduled' && (
          <p className="text-sm text-warning-soft-foreground">The instructor is on leave for this class. Put in a substitute or cancel it.</p>
        )}
        {error && <Alert variant="destructive"><AlertDescription>{error.code === 'version_conflict' ? 'This class changed meanwhile. Close and reopen it.' : error.message}</AlertDescription></Alert>}
        {conflict && <ConflictPanel details={conflict} batchName={session.batch.name} instructorName={session.instructor.name} busy={busy} onSaveAnyway={() => restore(true)} onDismiss={() => setConflict(null)} />}
        {canWrite && mode === 'change' && <ChangeForm session={session} options={options} onSaved={changed} onCancel={() => setMode('view')} />}
        {canWrite && mode === 'cancel' && <CancelForm session={session} onSaved={changed} onBack={() => setMode('view')} />}
        {mode === 'view' && !conflict && (
          <div className="flex flex-wrap justify-end gap-2">
            <Button asChild variant="ghost" size="sm"><Link to={`/crm/classes/batches/${session.batch.id}`}>Open batch</Link></Button>
            {me.capabilities.includes('crm.attendance.read') && session.status !== 'cancelled' && (
              <Button asChild variant="outline" size="sm"><Link to={`/crm/attendance/${session.id}`}>{session.status === 'held' ? 'Attendance' : 'Take attendance'}</Link></Button>
            )}
            {canWrite && session.status === 'scheduled' && (
              <>
                <Button variant="outline" size="sm" onClick={() => setMode('change')}>Substitute or room</Button>
                <Button variant="outline" size="sm" className="text-destructive" onClick={() => setMode('cancel')}>Cancel class</Button>
              </>
            )}
            {canWrite && session.status === 'cancelled' && future && <Button size="sm" onClick={() => restore(false)} disabled={busy}>Undo cancel</Button>}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
