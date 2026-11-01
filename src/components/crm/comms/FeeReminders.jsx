// Fee reminders on the Fees screens (CRM M2 phase 2 S3, D7/D10): Send
// reminder (once per fee payer per day, or from the staff member's own phone),
// pausing a student's reminders, and revoking the fee payer's fees links.
import { useCallback, useEffect, useState } from 'react';
import { BellRing, PauseCircle, Smartphone } from 'lucide-react';
import { Alert, AlertDescription } from '../../ui/Alert';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../ui/Dialog';
import { Input } from '../../ui/Input';
import { Skeleton } from '../../ui/Skeleton';
import { crmFetch, newIdempotencyKey } from '../../../lib/crm/api';
import { formatDay } from '../../../lib/crm/classes';
import { MESSAGE_KIND_LABELS, MESSAGE_STATUS_LABELS } from '../../../../shared/crm/comms.js';
import { addDays } from '../../../../shared/crm/time.js';
import { Field, formatDateTime } from '../leads/leadUi';

const post = (path, body) => crmFetch(path, { method: 'POST', body, idempotencyKey: newIdempotencyKey() });

function useReminderStatus(studentId, open = true) {
  const [state, setState] = useState({ status: 'loading', data: null, error: null });
  const load = useCallback(async () => {
    try {
      setState({ status: 'ready', data: await crmFetch(`fees/reminders?${new URLSearchParams({ studentId })}`), error: null });
    } catch (error) {
      setState({ status: 'error', data: null, error });
    }
  }, [studentId]);
  useEffect(() => { if (open) load(); }, [open, load]);
  return [state, load];
}

export function SendReminderDialog({ studentId, studentName, open, onClose, onSent }) {
  const [state] = useReminderStatus(studentId, open);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);
  useEffect(() => { if (open) { setDone(null); setError(null); } }, [open]);

  const send = async (via) => {
    setBusy(true);
    setError(null);
    try {
      const result = await post('fees/reminders/send', { studentId, via });
      if (via === 'phone') {
        window.open(result.link, '_blank', 'noopener');
        setDone('Opened WhatsApp on this device with the reminder and a fees link typed in. Press send there.');
      } else {
        setDone(`Sending the ${result.templateKey === 'fee_overdue' ? 'overdue' : 'fee'} reminder. It shows on ${studentName}’s timeline with its delivery status.`);
      }
      onSent?.();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const data = state.data;
  const blocked = data && (!data.connected ? 'WhatsApp isn’t connected for your class.' : !data.payer?.consent ? `${data.payer?.name || 'The fee payer'} hasn’t agreed to WhatsApp messages.` : data.sentToday ? `${data.payer.name} was already reminded today.` : null);
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send fee reminder</DialogTitle>
          <DialogDescription>To {studentName}’s fee payer, with a link to their fees page.</DialogDescription>
        </DialogHeader>
        {state.status === 'loading' && <Skeleton className="h-20 w-full" />}
        {state.status === 'error' && <Alert variant="destructive"><AlertDescription>{state.error.message}</AlertDescription></Alert>}
        {done && <Alert><AlertDescription role="status">{done}</AlertDescription></Alert>}
        {data && !done && (
          <div className="space-y-3 text-sm">
            {data.nothingDue ? <p>Nothing is due for {studentName}.</p> : (
              <>
                <p>To <strong>{data.payer?.name || 'no fee payer'}</strong>{data.pausedUntil ? <> · <Badge variant="warning">Reminders paused until {formatDay(data.pausedUntil)}</Badge></> : null}</p>
                {data.last && <p className="text-muted-foreground">Last: {MESSAGE_KIND_LABELS[data.last.kind]} {formatDateTime(data.last.at)} · {MESSAGE_STATUS_LABELS[data.last.status]}</p>}
                {blocked && <p className="text-muted-foreground">{blocked} You can still send it from your own phone.</p>}
              </>
            )}
          </div>
        )}
        {error && <Alert variant="destructive"><AlertDescription>{error.message}</AlertDescription></Alert>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={onClose}>{done ? 'Done' : 'Cancel'}</Button>
          {data && !done && !data.nothingDue && (
            <>
              <Button variant={blocked ? 'default' : 'outline'} onClick={() => send('phone')} disabled={busy || !data.payer?.hasPhone}><Smartphone className="h-4 w-4" aria-hidden /> Send from my phone</Button>
              {!blocked && <Button onClick={() => send('api')} disabled={busy}>{busy ? 'Sending…' : 'Send on WhatsApp'}</Button>}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** "Send reminder" for one row of Dues (needs comms send). */
export function SendReminderButton({ me, studentId, studentName, onSent, size = 'sm' }) {
  const [open, setOpen] = useState(false);
  if (!me?.capabilities?.includes('crm.comms.send')) return null;
  return (
    <>
      <Button size={size} variant="outline" onClick={() => setOpen(true)}><BellRing className="h-4 w-4" aria-hidden /> Send reminder</Button>
      <SendReminderDialog open={open} onClose={() => setOpen(false)} studentId={studentId} studentName={studentName} onSent={onSent} />
    </>
  );
}

function PauseDialog({ open, onClose, studentId, today, onSaved }) {
  const [until, setUntil] = useState(() => addDays(today, 7));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try { await post('fees/reminders/pause', { studentId, untilDate: until }); onSaved(); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pause fee reminders</DialogTitle>
          <DialogDescription>For example, when a parent has promised to pay on a date. Automatic reminders start again the day after.</DialogDescription>
        </DialogHeader>
        <Field label="Pause until" htmlFor="pause-until"><Input id="pause-until" type="date" min={today} value={until} onChange={(event) => setUntil(event.target.value)} /></Field>
        {error && <Alert variant="destructive"><AlertDescription>{error.message}</AlertDescription></Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={busy || !until}>Pause</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The reminders row on a student's Fees card. */
export function ReminderStrip({ me, student, today, onChanged }) {
  const [state, load] = useReminderStatus(student.id);
  const [dialog, setDialog] = useState(null);
  const [notice, setNotice] = useState(null);
  const canWrite = me.capabilities.includes('crm.finance.write');
  if (state.status !== 'ready') return null;
  const data = state.data;
  const refresh = () => { setDialog(null); load(); onChanged?.(); };
  const resume = async () => { await post('fees/reminders/pause', { studentId: student.id, untilDate: null }); refresh(); };
  const revoke = async () => {
    const result = await post('fees/links/revoke', { studentId: student.id });
    setNotice(result.revoked ? `${result.revoked} fees link${result.revoked === 1 ? '' : 's'} turned off. New reminders carry a new link.` : 'No active fees links to turn off.');
  };
  return (
    <div className="space-y-2 rounded-lg border border-border px-3 py-2 text-sm" data-testid="reminder-strip">
      <div className="flex flex-wrap items-center gap-2">
        <BellRing className="h-4 w-4 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1">
          {data.pausedUntil
            ? <>Reminders paused until <strong>{formatDay(data.pausedUntil)}</strong></>
            : data.last ? <>Last reminder {formatDateTime(data.last.at)} · {MESSAGE_STATUS_LABELS[data.last.status]}</> : <>WhatsApp reminders {data.connected ? 'go to the fee payer automatically' : 'start once WhatsApp is connected'}</>}
          {data.payer && !data.payer.consent && <span className="block text-xs text-muted-foreground">{data.payer.name} hasn’t agreed to WhatsApp messages.</span>}
        </span>
        {!data.nothingDue && <SendReminderButton me={me} studentId={student.id} studentName={student.name} onSent={load} />}
        {canWrite && (data.pausedUntil
          ? <Button size="sm" variant="ghost" onClick={resume}>Resume</Button>
          : !data.nothingDue && <Button size="sm" variant="ghost" onClick={() => setDialog('pause')}><PauseCircle className="h-4 w-4" aria-hidden /> Pause</Button>)}
        {canWrite && data.payer && <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={revoke}>Turn off fees links</Button>}
      </div>
      {notice && <p className="text-xs text-muted-foreground" role="status">{notice}</p>}
      <PauseDialog open={dialog === 'pause'} onClose={() => setDialog(null)} studentId={student.id} today={today} onSaved={refresh} />
    </div>
  );
}
