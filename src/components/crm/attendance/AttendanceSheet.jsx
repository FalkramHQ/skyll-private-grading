// Taking attendance for one class (FLKRM-327 S5, D8–D10). Phone first: one
// row per student with P / A / L / E, "All present" for anyone unmarked, live
// counts and one Save for the whole class. Changing a saved mark asks why
// (a correction). Nothing is stored until Save, so taps before it are free.
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, CheckCheck, MessageSquarePlus } from 'lucide-react';
import { Alert, AlertDescription } from '../../ui/Alert';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Input } from '../../ui/Input';
import { Select } from '../../ui/Select';
import { Skeleton } from '../../ui/Skeleton';
import { cn } from '../../../lib/utils';
import { crmFetch } from '../../../lib/crm/api';
import { classesWrite, formatDay, formatTime, formatWeekday } from '../../../lib/crm/classes';
import { CORRECTION_REASONS, MARKABLE_STATUSES, STATUS_LABELS, STATUS_SHORT, markBody, tally } from '../../../../shared/crm/attendance.js';

const STATUS_STYLE = {
  present: 'bg-success-soft text-success-soft-foreground border-success-soft-foreground/40',
  absent: 'bg-destructive text-destructive-foreground border-destructive',
  late: 'bg-warning-soft text-warning-soft-foreground border-warning-soft-foreground/40',
  excused: 'bg-muted text-foreground border-foreground/30',
};

const BLOCKED_TEXT = {
  read_only: 'You can view this sheet but not mark it.',
  session_cancelled: 'This class was cancelled, so attendance can\'t be taken.',
  not_yet: 'Attendance opens on the day of the class.',
  not_your_class: 'Not your class. Only its instructor or the batch\'s teachers can take attendance.',
  attendance_locked: 'This sheet locked 7 days after the class. Ask an admin to change it.',
};

function StatusButtons({ value, disabled, onChange, name }) {
  return (
    <div className="flex gap-1.5" role="radiogroup" aria-label={`Attendance for ${name}`}>
      {MARKABLE_STATUSES.map((status) => (
        <button
          key={status}
          type="button"
          role="radio"
          aria-checked={value === status}
          aria-label={STATUS_LABELS[status]}
          title={STATUS_LABELS[status]}
          disabled={disabled}
          onClick={() => onChange(status)}
          className={cn(
            'h-10 w-10 rounded-lg border text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60',
            value === status ? STATUS_STYLE[status] : 'border-border bg-card text-muted-foreground hover:bg-muted',
          )}
        >
          {STATUS_SHORT[status]}
        </button>
      ))}
    </div>
  );
}

function CorrectionReason({ draft, onChange, name }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-warning-soft/60 p-2 text-xs">
      <span className="font-medium text-warning-soft-foreground">Why the change?</span>
      <Select aria-label={`Reason for changing ${name}'s mark`} className="h-8 w-auto text-xs" value={draft.reasonKey || ''} onChange={(event) => onChange({ reasonKey: event.target.value || undefined })}>
        <option value="">Choose a reason</option>
        {CORRECTION_REASONS.map((reason) => <option key={reason.key} value={reason.key}>{reason.label}</option>)}
      </Select>
      {draft.reasonKey === 'other' && (
        <Input aria-label={`Say why ${name}'s mark changed`} className="h-8 min-w-[10rem] flex-1 text-xs" maxLength={200} value={draft.reasonNote || ''} onChange={(event) => onChange({ reasonNote: event.target.value })} />
      )}
    </div>
  );
}

export default function AttendanceSheet({ me }) {
  const { sessionId } = useParams();
  const timezone = me.school.timezone;
  const [state, setState] = useState({ status: 'loading', sheet: null, error: null });
  // Unsaved changes per student: { status, note, reasonKey, reasonNote }.
  const [drafts, setDrafts] = useState({});
  const [openNotes, setOpenNotes] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const sheet = await crmFetch(`attendance/sheet?${new URLSearchParams({ sessionId })}`);
      setState({ status: 'ready', sheet, error: null });
      setDrafts({});
    } catch (err) {
      setState({ status: 'error', sheet: null, error: err });
    }
  }, [sessionId]);

  useEffect(() => { load(); }, [load]);

  const students = state.sheet?.students || [];
  const current = (student) => ({ status: drafts[student.studentId]?.status ?? student.status, note: drafts[student.studentId]?.note ?? student.note ?? '' });
  const statuses = students.map((student) => drafts[student.studentId]?.status ?? student.status);
  const counts = { ...tally(statuses), unmarked: statuses.filter((status) => !status).length };

  if (state.status === 'loading') return <Skeleton className="h-96 w-full" />;
  if (state.status === 'error') {
    return (
      <div className="space-y-4">
        <BackLink />
        <Alert variant="destructive"><AlertDescription>{state.error.status === 404 ? 'This class was not found.' : state.error.message}</AlertDescription></Alert>
      </div>
    );
  }

  const { sheet } = state;
  const { session } = sheet;
  const editable = sheet.canMark;
  const update = (studentId, patch) => {
    setSaved(false);
    setDrafts((all) => ({ ...all, [studentId]: { ...all[studentId], ...patch } }));
  };
  const allPresent = () => {
    setSaved(false);
    setDrafts((all) => {
      const next = { ...all };
      for (const student of students) if (!(next[student.studentId]?.status ?? student.status)) next[student.studentId] = { ...next[student.studentId], status: 'present' };
      return next;
    });
  };

  // Only students whose status or note differ from what's saved are sent.
  const changes = students.flatMap((student) => {
    const draft = drafts[student.studentId];
    if (!draft) return [];
    const { status, note } = current(student);
    if (!status || (status === student.status && (note || null) === (student.note || null))) return [];
    const correction = Boolean(student.status) && status !== student.status;
    return [{
      studentId: student.studentId, status, ...(note ? { note } : {}),
      ...(student.version ? { expectedVersion: student.version } : {}),
      ...(correction && draft.reasonKey ? { reasonKey: draft.reasonKey } : {}),
      ...(correction && draft.reasonKey === 'other' && draft.reasonNote ? { reasonNote: draft.reasonNote.trim() } : {}),
      correction,
    }];
  });
  const needsReason = changes.filter((change) => change.correction && (!change.reasonKey || (change.reasonKey === 'other' && !change.reasonNote)));
  const body = { sessionId, marks: changes.map(({ correction: _correction, ...mark }) => mark) };
  const valid = changes.length > 0 && !needsReason.length && markBody.safeParse(body).success;

  const save = async () => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const sheetAfter = await classesWrite('attendance/mark', body);
      setState({ status: 'ready', sheet: sheetAfter, error: null });
      setDrafts({});
      setOpenNotes({});
      setSaved(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 pb-24">
      <BackLink />
      <div className="space-y-1">
        <h2 className="font-headline text-2xl">{session.batch.name}</h2>
        <p className="text-sm text-muted-foreground">
          {formatWeekday(session.localDate)} · {formatTime(session.startsAt, timezone)}–{formatTime(session.endsAt, timezone)}
          {[session.subject?.name, session.instructor.name, session.room?.name].filter(Boolean).map((part) => ` · ${part}`).join('')}
        </p>
        {editable && !sheet.schoolWide && <p className="text-xs text-muted-foreground">You can change this sheet until {formatDay(sheet.locksAfter)}.</p>}
      </div>

      {!editable && <Alert><AlertDescription>{BLOCKED_TEXT[sheet.blockedReason] || 'You can\'t mark this class.'}</AlertDescription></Alert>}
      {error && (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-2">
            {error.code === 'attendance_conflict' ? 'Someone else saved this sheet meanwhile. Reload to see their marks, then redo yours.' : error.message}
            {error.code === 'attendance_conflict' && <Button size="sm" variant="outline" onClick={() => { setError(null); load(); }}>Reload</Button>}
          </AlertDescription>
        </Alert>
      )}
      {saved && <Alert variant="success"><AlertDescription>Attendance saved.</AlertDescription></Alert>}

      <div className="flex flex-wrap items-center gap-2 text-sm" aria-live="polite">
        <Badge variant={counts.present ? 'success' : 'secondary'}>{counts.present} present</Badge>
        <Badge variant={counts.absent ? 'destructive' : 'secondary'}>{counts.absent} absent</Badge>
        <Badge variant={counts.late ? 'warning' : 'secondary'}>{counts.late} late</Badge>
        <Badge variant="secondary">{counts.excused} excused</Badge>
        {counts.unmarked > 0 && <span className="text-muted-foreground">{counts.unmarked} not marked</span>}
        {editable && counts.unmarked > 0 && (
          <Button size="sm" variant="outline" className="ml-auto" onClick={allPresent}><CheckCheck className="mr-1 h-4 w-4" aria-hidden="true" />All present</Button>
        )}
      </div>

      {!students.length && <p className="text-sm text-muted-foreground">Nobody was in this batch when the class started.</p>}
      {students.length > 0 && (
        <Card>
          <ul className="divide-y divide-border">
            {students.map((student) => {
              const { status, note } = current(student);
              const draft = drafts[student.studentId] || {};
              const correcting = Boolean(student.status) && status !== student.status;
              return (
                <li key={student.studentId} className="space-y-2 p-3">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    {/* Full width on phones, so the buttons sit on their own line under the name. */}
                    <div className="min-w-0 basis-full sm:basis-0 sm:flex-1">
                      <p className="font-medium">{student.name}</p>
                      {student.status && (
                        <p className="text-xs text-muted-foreground">
                          Saved: {STATUS_LABELS[student.status]}{student.updatedBy ? ` by ${student.updatedBy}` : student.markedBy ? ` by ${student.markedBy}` : ''}
                        </p>
                      )}
                      {student.note && !openNotes[student.studentId] && <p className="text-xs text-muted-foreground">Note: {student.note}</p>}
                    </div>
                    <StatusButtons value={status} disabled={!editable || busy} name={student.name} onChange={(next) => update(student.studentId, { status: next })} />
                    {editable && (
                      <Button size="icon" variant="ghost" aria-label={`Note for ${student.name}`} aria-pressed={Boolean(openNotes[student.studentId])} onClick={() => setOpenNotes((all) => ({ ...all, [student.studentId]: !all[student.studentId] }))}>
                        <MessageSquarePlus className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    )}
                  </div>
                  {editable && openNotes[student.studentId] && (
                    <Input aria-label={`Note about ${student.name}`} placeholder="Left early, came with a parent…" maxLength={200} value={note} onChange={(event) => update(student.studentId, { note: event.target.value })} />
                  )}
                  {editable && correcting && <CorrectionReason draft={draft} name={student.name} onChange={(patch) => update(student.studentId, patch)} />}
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {editable && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-card/95 p-3 backdrop-blur sm:static sm:border-0 sm:bg-transparent sm:p-0">
          <div className="flex items-center justify-end gap-3">
            {needsReason.length > 0 && <span className="text-xs text-warning-soft-foreground">Add a reason for each changed mark.</span>}
            <Button className="w-full sm:w-auto" onClick={save} disabled={busy || !valid}>
              {changes.length ? `Save ${changes.length} mark${changes.length === 1 ? '' : 's'}` : 'Save'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function BackLink() {
  return (
    <Link to="/crm/attendance" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft className="h-4 w-4" aria-hidden="true" />Attendance
    </Link>
  );
}
