// Activity timeline for a lead or student (FLKRM-326 S3, D13). The server
// merges the sources and leaves out what the viewer may not see.
import { useCallback, useEffect, useState } from 'react';
import {
  ArrowRight, BellOff, CalendarCheck, CalendarClock, CheckCircle2, CircleDot, LogIn, LogOut, MessageCircle, MessageSquare, MessageSquareReply, PencilLine, RotateCcw,
  ShieldCheck, Smartphone, Tag, Trash2, UserRound, Users, XCircle,
} from 'lucide-react';
import { Alert, AlertDescription } from '../../ui/Alert';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/Card';
import { Skeleton } from '../../ui/Skeleton';
import { crmFetch, newIdempotencyKey } from '../../../lib/crm/api';
import { useTasksChanged } from '../../../lib/crm/tasks';
import { formatWeekday } from '../../../lib/crm/classes';
import { STATUS_LABELS } from '../../../../shared/crm/attendance.js';
import { MESSAGE_KIND_LABELS, MESSAGE_STATUS_LABELS } from '../../../../shared/crm/comms.js';
import { formatDateTime } from '../leads/leadUi';
import MessageDialog from '../comms/MessageDialog';

const STATUS_VARIANT = { queued: 'secondary', sending: 'secondary', held: 'warning', sent: 'outline', delivered: 'info', read: 'success', failed: 'destructive', cancelled: 'secondary', skipped: 'secondary' };

function messageText(item) {
  const what = MESSAGE_KIND_LABELS[item.messageKind] || 'Message';
  const to = item.recipientName ? <> to <strong>{item.recipientName}</strong></> : '';
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1">
      <span>{what}{item.via === 'phone' ? ' sent from a phone' : ''}{to}</span>
      {item.via === 'api' && <Badge variant={STATUS_VARIANT[item.status]}>{MESSAGE_STATUS_LABELS[item.status]}</Badge>}
    </span>
  );
}

function messageDetail(item) {
  const parts = [];
  if (item.amountsHidden) parts.push('Fee details are visible to staff with fee access.');
  else if (item.body) parts.push(item.body);
  return parts.join('\n') || null;
}

const FIELD_LABELS = { learnerName: 'name', learnerGrade: 'grade', sourceKey: 'source', interest: 'interest' };
const GUARDIAN_FIELDS = { relationship: 'relationship', isEmergency: 'emergency contact', isFeePayer: 'fee payer' };

function guardianText(item) {
  const who = item.guardianName ? <strong>{item.guardianName}</strong> : 'A guardian';
  switch (item.change) {
    case 'added': return <>{who} added as a guardian</>;
    case 'restored': return <>{who} added back as a guardian</>;
    case 'removed': return <>{who} removed as a guardian</>;
    case 'primary_changed': return <>{who} is now the primary guardian</>;
    default: return <>{who}: {item.fields.map((field) => GUARDIAN_FIELDS[field] || field).join(', ')} changed</>;
  }
}

const TASK_EVENTS = {
  created: { icon: CircleDot, text: (item) => <>Task <strong>{item.title}</strong> created{item.toName ? <> for {item.toName}</> : ''}</> },
  completed: { icon: CheckCircle2, text: (item) => <>Task <strong>{item.title}</strong> done</> },
  reopened: { icon: RotateCcw, text: (item) => <>Task <strong>{item.title}</strong> reopened</> },
  cancelled: { icon: XCircle, text: (item) => <>Task <strong>{item.title}</strong> cancelled</> },
  rescheduled: { icon: CalendarClock, text: (item) => <>Task <strong>{item.title}</strong> moved to {formatDateTime(item.toDueAt)}</> },
  reassigned: { icon: UserRound, text: (item) => <>Task <strong>{item.title}</strong> given to {item.toName || 'nobody (unassigned)'}</> },
};

function describe(item) {
  switch (item.kind) {
    case 'created': return { icon: CircleDot, text: <>Lead created in <strong>{item.to.name}</strong></> };
    case 'stage': return {
      icon: ArrowRight,
      text: <>Moved from <strong>{item.from.name}</strong> to <strong>{item.to.name}</strong></>,
      detail: item.reason ? `Reason: ${item.reason}` : null,
    };
    case 'note': return { icon: MessageSquare, text: <>Note{item.edited ? ' (edited)' : ''}</>, detail: item.body, quote: true };
    case 'note_removed': return { icon: Trash2, text: 'A note was removed' };
    case 'tag': return { icon: Tag, text: <>Tag <strong>{item.label}</strong> {item.change === 'added' ? 'added' : 'removed'}</> };
    case 'owner': return { icon: UserRound, text: <>Owner changed{item.fromName ? <> from {item.fromName}</> : ''} to <strong>{item.toName || 'nobody'}</strong></> };
    case 'updated': return { icon: PencilLine, text: `Details edited: ${item.fields.map((field) => FIELD_LABELS[field] || field).join(', ')}` };
    case 'converted': return { icon: CheckCircle2, text: 'Converted to a student' };
    case 'batch': return {
      icon: item.change === 'joined' ? LogIn : LogOut,
      text: <>{item.change === 'joined' ? 'Joined' : 'Left'} <strong>{item.batchName}</strong></>,
    };
    case 'guardian': return { icon: item.change === 'primary_changed' ? ShieldCheck : Users, text: guardianText(item) };
    case 'attendance': return {
      icon: CalendarCheck,
      text: <>Attendance changed from <strong>{STATUS_LABELS[item.from] || item.from}</strong> to <strong>{STATUS_LABELS[item.to] || item.to}</strong>{item.batchName ? <> for {item.batchName}{item.localDate ? `, ${formatWeekday(item.localDate)}` : ''}</> : ''}</>,
      detail: item.reason ? `Reason: ${item.reason}` : null,
    };
    case 'message': return {
      icon: item.via === 'phone' ? Smartphone : MessageCircle,
      text: messageText(item),
      detail: messageDetail(item),
      quote: Boolean(item.body),
      note: ['failed', 'cancelled', 'held', 'skipped', 'queued'].includes(item.status) ? item.statusReason : null,
    };
    case 'reply': return item.isStop
      ? { icon: BellOff, text: <><strong>{item.fromName || 'A guardian'}</strong> replied STOP: WhatsApp updates turned off</> }
      : { icon: MessageSquareReply, text: <><strong>{item.fromName || 'A guardian'}</strong> replied on WhatsApp</>, detail: item.body || item.mediaLabel, quote: Boolean(item.body) };
    case 'task': {
      const event = TASK_EVENTS[item.event] || TASK_EVENTS.created;
      return { icon: event.icon, text: event.text(item) };
    }
    default: return { icon: CircleDot, text: item.kind };
  }
}

/** Reloads when `refreshKey` changes and after any task write. `me` enables Retry and Reply on messages. */
export default function ActivityTimeline({ entityType, entityId, refreshKey, me, label }) {
  const [state, setState] = useState({ status: 'loading', items: [], error: null });
  const [replyTo, setReplyTo] = useState(null);
  const [retrying, setRetrying] = useState(null);
  const canSend = Boolean(me?.capabilities?.includes('crm.comms.send'));
  const load = useCallback(async () => {
    try {
      const result = await crmFetch(`timeline?${new URLSearchParams({ entityType, entityId })}`);
      setState({ status: 'ready', items: result.items, error: null });
    } catch (error) {
      setState({ status: 'error', items: [], error });
    }
  }, [entityType, entityId]);

  useEffect(() => { load(); }, [load, refreshKey]);
  useTasksChanged(load);

  const retry = async (messageId) => {
    setRetrying(messageId);
    try {
      await crmFetch('messages/retry', { method: 'POST', body: { messageId }, idempotencyKey: newIdempotencyKey() });
      await load();
    } catch (error) {
      setState((current) => ({ ...current, error }));
    } finally {
      setRetrying(null);
    }
  };

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Activity</CardTitle></CardHeader>
      <CardContent>
        {state.status === 'loading' && <Skeleton className="h-24 w-full" />}
        {state.status === 'error' && <Alert variant="destructive"><AlertDescription>{state.error.message}</AlertDescription></Alert>}
        {state.status === 'ready' && !state.items.length && <p className="text-sm text-muted-foreground">No activity yet.</p>}
        {state.status === 'ready' && state.items.length > 0 && (
          <ol className="relative space-y-4 border-l border-border pl-5" aria-label="Activity">
            {state.items.map((item) => {
              const { icon: Icon, text, detail, quote, note } = describe(item);
              return (
                <li key={item.id} className="relative text-sm">
                  <span className="absolute -left-[1.95rem] top-0 flex h-6 w-6 items-center justify-center rounded-full border border-border bg-card text-muted-foreground">
                    <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                  </span>
                  <div className="text-foreground">{text}</div>
                  {detail && (
                    <p className={quote ? 'mt-1 line-clamp-3 whitespace-pre-wrap rounded-md bg-muted px-2 py-1 text-foreground' : 'text-muted-foreground'}>{detail}</p>
                  )}
                  {note && <p className="text-xs text-muted-foreground">{note}</p>}
                  <p className="text-xs text-muted-foreground">{[item.kind === 'message' && item.via === 'api' && !item.actorName ? 'Automatic' : item.actorName, formatDateTime(item.at)].filter(Boolean).join(' · ')}</p>
                  {canSend && item.kind === 'message' && item.retryable && (
                    <Button size="sm" variant="outline" className="mt-1 h-7" onClick={() => retry(item.messageId)} disabled={retrying === item.messageId}>{retrying === item.messageId ? 'Retrying…' : 'Retry'}</Button>
                  )}
                  {canSend && item.kind === 'reply' && !item.isStop && item.contactId && (
                    <Button size="sm" variant="outline" className="mt-1 h-7" onClick={() => setReplyTo(item.contactId)}><MessageSquareReply className="h-3.5 w-3.5" aria-hidden /> Reply</Button>
                  )}
                </li>
              );
            })}
          </ol>
        )}
        {state.status === 'ready' && state.error && <Alert variant="destructive" className="mt-3"><AlertDescription>{state.error.message}</AlertDescription></Alert>}
      </CardContent>
      {replyTo && (
        <MessageDialog open target={{ entityType, entityId, label: label || 'guardian' }} initialContactId={replyTo} onClose={() => setReplyTo(null)} onSent={load} />
      )}
    </Card>
  );
}
