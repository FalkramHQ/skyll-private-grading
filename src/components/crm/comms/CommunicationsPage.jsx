// Communications (CRM M2 phase 2 S5, D8/D9/D12): every WhatsApp message with
// its status, parents' replies, replies from unknown numbers, and class
// notices to a filtered group. A banner shows when WhatsApp isn't connected
// or messages are on hold.
import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, BellOff, MessageCircle, MessageSquareReply, Plus, Smartphone } from 'lucide-react';
import { Alert, AlertDescription } from '../../ui/Alert';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card, CardContent } from '../../ui/Card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../ui/Dialog';
import { Select } from '../../ui/Select';
import { Skeleton } from '../../ui/Skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../ui/Tabs';
import { crmFetch, newIdempotencyKey } from '../../../lib/crm/api';
import { MESSAGE_KIND_LABELS, MESSAGE_STATUS_LABELS, phoneLink } from '../../../../shared/crm/comms.js';
import { formatDateTime } from '../leads/leadUi';
import { formatPhone } from '../leads/NewLeadDialog';
import MessageDialog, { NoticeForm, Recipients } from './MessageDialog';

const STATUS_VARIANT = { queued: 'secondary', sending: 'secondary', held: 'warning', sent: 'outline', delivered: 'info', read: 'success', failed: 'destructive', cancelled: 'secondary', skipped: 'secondary' };
const KIND_FILTERS = [['', 'All kinds'], ['fee', 'Fee reminders'], ['receipt', 'Receipts'], ['report_ready', 'Report ready'], ['absent', 'Absences'], ['notice', 'Class notices'], ['free_text', 'Messages']];
const STATUS_FILTERS = [['', 'Any status'], ['attention', 'Needs attention'], ['failed', 'Failed'], ['held', 'On hold'], ['sent', 'Sent'], ['skipped', 'Not sent']];

function recordLink(record) {
  return record.entityType === 'lead' ? `/crm/leads/${record.entityId}` : `/crm/students/${record.entityId}`;
}

function StatusBanner({ status }) {
  if (!status) return null;
  if (!status.connection) {
    return (
      <Alert>
        <MessageCircle className="h-4 w-4" aria-hidden />
        <AlertDescription>
          WhatsApp isn’t connected, so automatic messages aren’t sent and staff use Send from my phone.
          {status.canManage && <> <Link to="/crm/settings?tab=whatsapp" className="font-semibold underline">Connect WhatsApp</Link></>}
        </AlertDescription>
      </Alert>
    );
  }
  if (status.connection.health === 'blocked') {
    return (
      <Alert variant="destructive" role="alert">
        <AlertTriangle className="h-4 w-4" aria-hidden />
        <AlertDescription>
          <strong>WhatsApp messages are on hold{status.held ? ` (${status.held} waiting)` : ''}.</strong> {status.connection.healthReason}
          {status.canManage && <> <Link to="/crm/settings?tab=whatsapp" className="font-semibold underline">Open WhatsApp settings</Link></>}
        </AlertDescription>
      </Alert>
    );
  }
  return <p className="text-sm text-muted-foreground">Sending from {status.connection.displayPhone}.{status.failedThisWeek ? ` ${status.failedThisWeek} failed this week.` : ''}</p>;
}

function History({ me, refreshKey }) {
  const [params, setParams] = useSearchParams();
  const kind = params.get('kind') || '';
  const statusFilter = params.get('status') || '';
  const [state, setState] = useState({ status: 'loading', items: [], nextCursor: null, error: null });
  const [open, setOpen] = useState(null);
  const canSend = me.capabilities.includes('crm.comms.send');

  const load = useCallback(async (cursor = null) => {
    try {
      const query = new URLSearchParams({ ...(kind ? { kind } : {}), ...(statusFilter ? { status: statusFilter } : {}), ...(cursor ? { cursor } : {}) });
      const page = await crmFetch(`messages?${query}`);
      setState((current) => ({ status: 'ready', items: cursor ? [...current.items, ...page.items] : page.items, nextCursor: page.nextCursor, error: null }));
    } catch (error) {
      setState({ status: 'error', items: [], nextCursor: null, error });
    }
  }, [kind, statusFilter]);
  useEffect(() => { load(); }, [load, refreshKey]);

  const setFilter = (key) => (event) => setParams((current) => {
    const next = new URLSearchParams(current);
    if (event.target.value) next.set(key, event.target.value); else next.delete(key);
    return next;
  }, { replace: true });
  const retry = async (id) => {
    await crmFetch('messages/retry', { method: 'POST', body: { messageId: id }, idempotencyKey: newIdempotencyKey() });
    load();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Select aria-label="Kind" className="w-48" value={kind} onChange={setFilter('kind')}>{KIND_FILTERS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select>
        <Select aria-label="Status" className="w-48" value={statusFilter} onChange={setFilter('status')}>{STATUS_FILTERS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select>
      </div>
      {state.status === 'loading' && <Skeleton className="h-48 w-full" />}
      {state.status === 'error' && <Alert variant="destructive"><AlertDescription>{state.error.message}</AlertDescription></Alert>}
      {state.status === 'ready' && !state.items.length && <p className="text-sm text-muted-foreground">No messages yet.</p>}
      {state.items.length > 0 && (
        <ul className="divide-y divide-border rounded-xl border border-border bg-card" aria-label="Messages">
          {state.items.map((item) => (
            <li key={item.id} className="space-y-1 px-4 py-3 text-sm">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                {item.via === 'phone' ? <Smartphone className="h-4 w-4 text-muted-foreground" aria-hidden /> : <MessageCircle className="h-4 w-4 text-muted-foreground" aria-hidden />}
                <span className="font-medium">{MESSAGE_KIND_LABELS[item.kind]}</span>
                {item.recipientName && <span>to {item.recipientName}</span>}
                {item.subjects.length > 0 && (
                  <span className="text-muted-foreground">
                    about {item.subjects.map((subject, index) => (
                      <span key={`${subject.entityType}-${subject.entityId}`}>{index > 0 && ', '}<Link to={recordLink(subject)} className="hover:underline">{subject.name}</Link></span>
                    ))}
                  </span>
                )}
                <span className="ml-auto flex items-center gap-2">
                  <Badge variant={STATUS_VARIANT[item.status]}>{item.via === 'phone' ? 'From a phone' : MESSAGE_STATUS_LABELS[item.status]}</Badge>
                  <span className="text-xs text-muted-foreground">{formatDateTime(item.at)}</span>
                </span>
              </div>
              {item.statusReason && ['failed', 'held', 'cancelled', 'skipped', 'queued'].includes(item.status) && <p className="text-xs text-muted-foreground">{item.statusReason}</p>}
              <div className="flex flex-wrap items-center gap-2">
                {(item.body || item.amountsHidden) && (
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" aria-expanded={open === item.id} onClick={() => setOpen(open === item.id ? null : item.id)}>{open === item.id ? 'Hide text' : 'Show text'}</Button>
                )}
                {canSend && item.retryable && <Button size="sm" variant="outline" className="h-7" onClick={() => retry(item.id)}>Retry</Button>}
                <span className="text-xs text-muted-foreground">{item.actorName || (item.via === 'api' ? 'Automatic' : '')}</span>
              </div>
              {open === item.id && (
                <p className="whitespace-pre-line rounded-md bg-muted px-3 py-2">{item.amountsHidden ? 'Fee details are visible to staff with fee access.' : item.body}</p>
              )}
            </li>
          ))}
        </ul>
      )}
      {state.nextCursor && <Button variant="outline" onClick={() => load(state.nextCursor)}>Show more</Button>}
    </div>
  );
}

function Replies({ me, view }) {
  const [state, setState] = useState({ status: 'loading', items: [], nextCursor: null, error: null });
  const [replyTo, setReplyTo] = useState(null);
  const canSend = me.capabilities.includes('crm.comms.send');
  const load = useCallback(async () => {
    try {
      const page = await crmFetch(`messages/replies?${new URLSearchParams({ view })}`);
      setState({ status: 'ready', items: page.items, nextCursor: page.nextCursor, error: null });
    } catch (error) {
      setState({ status: 'error', items: [], nextCursor: null, error });
    }
  }, [view]);
  useEffect(() => { load(); }, [load]);

  if (state.status === 'loading') return <Skeleton className="h-48 w-full" />;
  if (state.status === 'error') return <Alert variant="destructive"><AlertDescription>{state.error.message}</AlertDescription></Alert>;
  if (!state.items.length) return <p className="text-sm text-muted-foreground">{view === 'unknown' ? 'No messages from unknown numbers.' : 'No replies yet. When parents reply to your WhatsApp number, their messages show here and on the student’s page.'}</p>;
  return (
    <>
      <ul className="divide-y divide-border rounded-xl border border-border bg-card" aria-label={view === 'unknown' ? 'Other numbers' : 'Replies'}>
        {state.items.map((item) => (
          <li key={item.id} className="space-y-1 px-4 py-3 text-sm">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {item.isStop ? <BellOff className="h-4 w-4 text-muted-foreground" aria-hidden /> : <MessageSquareReply className="h-4 w-4 text-muted-foreground" aria-hidden />}
              <span className="font-medium">{item.fromName || (item.fromPhone ? formatPhone(item.fromPhone) : 'A parent')}</span>
              {item.records.length > 0 && (
                <span className="text-muted-foreground">
                  for {item.records.map((record, index) => <span key={record.entityId}>{index > 0 && ', '}<Link to={recordLink(record)} className="hover:underline">{record.name}</Link></span>)}
                </span>
              )}
              {item.isStop && <Badge variant="secondary">Turned off WhatsApp updates</Badge>}
              <span className="ml-auto text-xs text-muted-foreground">{formatDateTime(item.at)}</span>
            </div>
            {(item.body || item.mediaLabel) && <p className="whitespace-pre-line rounded-md bg-muted px-3 py-2">{item.body || item.mediaLabel}</p>}
            {canSend && !item.isStop && item.records.length > 0 && item.contactId && (
              <Button size="sm" variant="outline" className="h-7" onClick={() => setReplyTo(item)}><MessageSquareReply className="h-3.5 w-3.5" aria-hidden /> Reply</Button>
            )}
            {canSend && view === 'unknown' && item.fromPhone && (
              <a className="inline-flex items-center gap-1 text-xs font-semibold text-accent hover:underline" href={phoneLink(item.fromPhone, '')} target="_blank" rel="noreferrer"><Smartphone className="h-3.5 w-3.5" aria-hidden /> Reply from my phone</a>
            )}
          </li>
        ))}
      </ul>
      {replyTo && (
        <MessageDialog
          open
          target={{ entityType: replyTo.records[0].entityType, entityId: replyTo.records[0].entityId, label: replyTo.records[0].name }}
          initialContactId={replyTo.contactId}
          onClose={() => setReplyTo(null)}
          onSent={load}
        />
      )}
    </>
  );
}

function GroupDialog({ open, onClose, onSent }) {
  const [options, setOptions] = useState(null);
  const [filters, setFilters] = useState({ batchIds: [], courseId: '', overdueOnly: false });
  const [compose, setCompose] = useState(null);
  const [templateKey, setTemplateKey] = useState('notice_holiday');
  const [fields, setFields] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [requestKey, setRequestKey] = useState(newIdempotencyKey);

  useEffect(() => {
    if (!open) return;
    setDone(null); setCompose(null); setError(null); setFilters({ batchIds: [], courseId: '', overdueOnly: false }); setFields({}); setRequestKey(newIdempotencyKey());
    crmFetch('messages/group/options').then(setOptions).catch(setError);
  }, [open]);

  const any = filters.batchIds.length || filters.courseId || filters.overdueOnly;
  useEffect(() => {
    if (!open || !any) { setCompose(null); return undefined; }
    let live = true;
    const query = new URLSearchParams({ ...(filters.batchIds.length ? { batchIds: filters.batchIds.join(',') } : {}), ...(filters.courseId ? { courseId: filters.courseId } : {}), ...(filters.overdueOnly ? { overdueOnly: 'true' } : {}) });
    crmFetch(`messages/group/preview?${query}`).then((data) => live && setCompose(data)).catch((err) => live && setError(err));
    return () => { live = false; };
  }, [open, any, filters]);

  const toggleBatch = (batchId) => setFilters((current) => ({ ...current, batchIds: current.batchIds.includes(batchId) ? current.batchIds.filter((id) => id !== batchId) : [...current.batchIds, batchId] }));
  const notice = compose?.notices.find((item) => item.key === templateKey);
  const ready = compose?.connection && compose.recipients.length > 0 && notice?.fields.every((field) => String(fields[field] || '').trim());
  const send = async () => {
    setBusy(true); setError(null);
    try {
      const result = await crmFetch('messages/group', {
        method: 'POST', idempotencyKey: requestKey,
        body: { filters: { batchIds: filters.batchIds, ...(filters.courseId ? { courseId: filters.courseId } : {}), overdueOnly: filters.overdueOnly }, templateKey, fields },
      });
      setDone(`Sending to ${result.queued} guardians${result.skipped ? `; ${result.skipped} skipped (no WhatsApp consent)` : ''}.`);
      onSent?.();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New class notice</DialogTitle>
          <DialogDescription>Choose who it’s for. Every guardian who agreed to WhatsApp gets one copy, even with two children in the group.</DialogDescription>
        </DialogHeader>
        {done ? (
          <div className="space-y-4"><Alert><AlertDescription role="status">{done}</AlertDescription></Alert><div className="flex justify-end"><Button onClick={onClose}>Done</Button></div></div>
        ) : (
          <div className="space-y-5">
            {!options && !error && <Skeleton className="h-24 w-full" />}
            {options && (
              <fieldset className="space-y-3">
                <legend className="text-sm font-medium">Who</legend>
                <div className="flex max-h-40 flex-wrap gap-2 overflow-y-auto">
                  {options.batches.map((batch) => (
                    <label key={batch.id} className={`flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1 text-sm ${filters.batchIds.includes(batch.id) ? 'border-ink bg-sunken font-semibold' : 'border-hairline'}`}>
                      <input type="checkbox" className="h-3.5 w-3.5" checked={filters.batchIds.includes(batch.id)} onChange={() => toggleBatch(batch.id)} />
                      {batch.name} <span className="text-xs text-muted-foreground">{batch.students}</span>
                    </label>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  {options.courses.length > 0 && (
                    <Select aria-label="Course" className="w-56" value={filters.courseId} onChange={(event) => setFilters((current) => ({ ...current, courseId: event.target.value }))}>
                      <option value="">Any course</option>
                      {options.courses.map((course) => <option key={course.id} value={course.id}>{course.name}</option>)}
                    </Select>
                  )}
                  {options.canFilterOverdue && (
                    <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4" checked={filters.overdueOnly} onChange={(event) => setFilters((current) => ({ ...current, overdueOnly: event.target.checked }))} /> Only students with overdue fees</label>
                  )}
                </div>
              </fieldset>
            )}
            {compose && (
              <>
                <NoticeForm compose={compose} fields={fields} setFields={setFields} templateKey={templateKey} setTemplateKey={setTemplateKey} />
                <Recipients compose={compose} />
              </>
            )}
            {error && <Alert variant="destructive"><AlertDescription>{error.message}</AlertDescription></Alert>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={onClose}>Cancel</Button>
              <Button onClick={send} disabled={busy || !ready}>{busy ? 'Sending…' : compose ? `Send to ${compose.recipients.length}` : 'Send'}</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function CommunicationsPage({ me }) {
  const [params, setParams] = useSearchParams();
  const tab = ['history', 'replies', 'unknown'].includes(params.get('tab')) ? params.get('tab') : 'history';
  const [status, setStatus] = useState(null);
  const [composing, setComposing] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const canSend = me.capabilities.includes('crm.comms.send');
  useEffect(() => { crmFetch('messages/status').then(setStatus).catch(() => setStatus(null)); }, [refreshKey]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1"><StatusBanner status={status} /></div>
        {canSend && <Button onClick={() => setComposing(true)}><Plus className="h-4 w-4" aria-hidden /> New class notice</Button>}
      </div>
      <Tabs value={tab} onValueChange={(value) => setParams(value === 'history' ? {} : { tab: value }, { replace: true })} className="space-y-6">
        <TabsList className="overflow-x-auto rounded-t-xl">
          <TabsTrigger value="history">History</TabsTrigger>
          <TabsTrigger value="replies">Replies</TabsTrigger>
          <TabsTrigger value="unknown">Other numbers</TabsTrigger>
        </TabsList>
        <TabsContent value="history"><Card><CardContent className="p-4"><History me={me} refreshKey={refreshKey} /></CardContent></Card></TabsContent>
        <TabsContent value="replies"><Replies me={me} view="matched" /></TabsContent>
        <TabsContent value="unknown"><Replies me={me} view="unknown" /></TabsContent>
      </Tabs>
      <GroupDialog open={composing} onClose={() => setComposing(false)} onSent={() => setRefreshKey((key) => key + 1)} />
    </div>
  );
}
