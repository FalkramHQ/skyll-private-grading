// Message a student's guardians, a lead, or a whole batch (CRM M2 phase 2 S2,
// D5/D8). Class notices use Skyll's approved wording and go to everyone who
// agreed to WhatsApp, one copy per phone. Free text goes through WhatsApp only
// inside the 24-hour window; otherwise staff use Send from my phone.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, MessageCircle, Smartphone } from 'lucide-react';
import { Alert, AlertDescription } from '../../ui/Alert';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../ui/Dialog';
import { Input } from '../../ui/Input';
import { Select } from '../../ui/Select';
import { Skeleton } from '../../ui/Skeleton';
import { crmFetch, newIdempotencyKey } from '../../../lib/crm/api';
import { FREE_TEXT_MAX, NOTICE_FIELD_LABELS } from '../../../../shared/crm/comms.js';
import { WA_VARIABLES, renderTemplate } from '../../../../shared/crm/waTemplates.js';
import { Field, Textarea } from '../leads/leadUi';
import { formatPhone } from '../leads/NewLeadDialog';

const SKIP_REASONS = { no_consent: 'hasn’t agreed to WhatsApp', no_guardian_phone: 'no guardian phone number', no_phone: 'no phone number' };
const FIELD_HINTS = { when: 'e.g. Wed 21 Oct, 5:00 pm', newWhen: 'e.g. Sat 24 Oct, 10:00 am', dates: 'e.g. 1 Nov or 1–3 Nov', occasion: 'e.g. Diwali', item: 'e.g. a geometry box' };

function joinNames(names) {
  const list = [...new Set(names.filter(Boolean))];
  return list.length <= 1 ? list[0] || '' : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

export function NoticeForm({ compose, fields, setFields, templateKey, setTemplateKey }) {
  const notice = compose.notices.find((item) => item.key === templateKey);
  const first = compose.recipients[0];
  const preview = useMemo(() => {
    if (!notice) return '';
    const examples = Object.fromEntries(Object.entries(WA_VARIABLES).map(([key, rule]) => [key, rule.example]));
    const values = { ...examples, senderName: compose.senderName || examples.senderName, contactLine: compose.contactLine || '', guardianName: first?.name || examples.guardianName, studentName: joinNames(first?.students || []) || examples.studentName };
    for (const field of notice.fields) values[field] = fields[field] || `[${NOTICE_FIELD_LABELS[field].toLowerCase()}]`;
    try { return renderTemplate(templateKey, compose.language, values); } catch { return ''; }
  }, [notice, fields, templateKey, compose.language, compose.senderName, compose.contactLine, first]);
  return (
    <div className="grid gap-4 md:grid-cols-[1fr_minmax(0,16rem)]">
      <div className="space-y-3">
        <Field label="Notice" htmlFor="msg-notice">
          <Select id="msg-notice" value={templateKey} onChange={(event) => setTemplateKey(event.target.value)}>
            {compose.notices.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
          </Select>
        </Field>
        {notice?.fields.map((field) => (
          <Field key={field} label={NOTICE_FIELD_LABELS[field]} htmlFor={`msg-${field}`} hint={FIELD_HINTS[field]}>
            <Input id={`msg-${field}`} maxLength={field === 'occasion' ? 40 : 80} value={fields[field] || ''} onChange={(event) => setFields((current) => ({ ...current, [field]: event.target.value }))} />
          </Field>
        ))}
      </div>
      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Preview</p>
        <div className="whitespace-pre-line rounded-xl rounded-tl-sm bg-[#DCF8C6] p-3 text-sm text-[#111B21] shadow-sm" data-testid="msg-preview">{preview}</div>
      </div>
    </div>
  );
}

export function Recipients({ compose }) {
  return (
    <div className="space-y-2 text-sm">
      <p className="font-medium">
        Goes to {compose.recipients.length} {compose.recipients.length === 1 ? 'guardian' : 'guardians'}
        {compose.target.studentCount > 1 ? ` of ${compose.target.studentCount} students` : ''}
        {compose.estimate && compose.recipients.length > 0 ? <span className="font-normal text-muted-foreground"> · {compose.estimate.total} (billed to your class by Meta)</span> : null}
      </p>
      <ul className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-hairline p-2">
        {compose.recipients.map((recipient) => (
          <li key={recipient.contactId} className="flex flex-wrap items-center gap-x-2">
            <span>{recipient.name}</span>
            {recipient.phone && <span className="text-xs text-muted-foreground">{formatPhone(recipient.phone)}</span>}
            <span className="text-xs text-muted-foreground">for {joinNames(recipient.students)}</span>
          </li>
        ))}
        {compose.skipped.map((item, index) => (
          <li key={`skip-${index}`} className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
            <span className="line-through decoration-muted-foreground/50">{item.name}</span>
            <Badge variant="secondary">Skipped: {SKIP_REASONS[item.reason] || item.reason}</Badge>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TextForm({ compose, contactId, setContactId, text, setText }) {
  const people = [...compose.recipients, ...compose.skipped.filter((item) => item.contactId)];
  const chosen = people.find((person) => person.contactId === contactId);
  return (
    <div className="space-y-3">
      {people.length > 1 && (
        <Field label="To" htmlFor="msg-to">
          <Select id="msg-to" value={contactId} onChange={(event) => setContactId(event.target.value)}>
            {people.map((person) => <option key={person.contactId} value={person.contactId}>{person.name}{person.phone ? ` · ${formatPhone(person.phone)}` : ''}</option>)}
          </Select>
        </Field>
      )}
      {people.length === 1 && <p className="text-sm">To <strong>{chosen?.name}</strong>{chosen?.phone ? ` · ${formatPhone(chosen.phone)}` : ''}</p>}
      <Field label="Message" htmlFor="msg-text" hint={`${text.length}/${FREE_TEXT_MAX}. Please don’t include anything you wouldn’t want forwarded.`}>
        <Textarea id="msg-text" rows={4} maxLength={FREE_TEXT_MAX} value={text} onChange={(event) => setText(event.target.value)} />
      </Field>
      {chosen && compose.connection && chosen.consent && !chosen.windowOpen && (
        <p className="text-xs text-muted-foreground">More than 24 hours since {chosen.name} last messaged your number, so WhatsApp only allows approved notices. Use <strong>Send from my phone</strong> instead.</p>
      )}
      {chosen && !chosen.consent && <p className="text-xs text-muted-foreground">{chosen.name} hasn’t agreed to WhatsApp messages from the class. You can still message from your own phone.</p>}
    </div>
  );
}

/**
 * `target`: `{ entityType: 'student' | 'lead' | 'batch', entityId, label }`.
 * `initialContactId` opens straight on a free-text reply to that guardian.
 */
export default function MessageDialog({ open, onClose, target, initialContactId = null, onSent }) {
  const [compose, setCompose] = useState(null);
  const [error, setError] = useState(null);
  const [mode, setMode] = useState('notice');
  const [templateKey, setTemplateKey] = useState('notice_cancelled');
  const [fields, setFields] = useState({});
  const [contactId, setContactId] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [requestKey, setRequestKey] = useState(newIdempotencyKey);

  const load = useCallback(async () => {
    setCompose(null);
    setError(null);
    try {
      const data = await crmFetch(`messages/compose?${new URLSearchParams({ entityType: target.entityType, entityId: target.entityId })}`);
      setCompose(data);
      const people = [...data.recipients, ...data.skipped.filter((item) => item.contactId)];
      setContactId(initialContactId && people.some((person) => person.contactId === initialContactId) ? initialContactId : people[0]?.contactId || '');
      setMode(initialContactId || target.entityType === 'lead' ? 'text' : 'notice');
      setFields(target.entityType === 'batch' ? { className: data.target.batchName } : {});
    } catch (err) {
      setError(err);
    }
  }, [target.entityType, target.entityId, initialContactId]);

  useEffect(() => {
    if (!open) return;
    setDone(null);
    setText('');
    setRequestKey(newIdempotencyKey());
    load();
  }, [open, load]);

  const send = async (how) => {
    setBusy(true);
    setError(null);
    try {
      const body = how === 'notice'
        ? { entityType: target.entityType, entityId: target.entityId, mode: 'notice', templateKey, fields }
        : { entityType: target.entityType, entityId: target.entityId, mode: how, contactId, text };
      const result = await crmFetch('messages', { method: 'POST', body, idempotencyKey: how === 'phone' ? newIdempotencyKey() : requestKey });
      if (how === 'phone') {
        window.open(result.link, '_blank', 'noopener');
        setDone('Opened WhatsApp on this device. Press send there; Skyll has noted it on the timeline.');
      } else {
        setDone(how === 'notice' ? `Sending to ${result.queued} ${result.queued === 1 ? 'guardian' : 'guardians'}. Each one shows on the timeline with its delivery status.` : 'Sending. It shows on the timeline with its delivery status.');
      }
      setRequestKey(newIdempotencyKey());
      onSent?.();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const people = compose ? [...compose.recipients, ...compose.skipped.filter((item) => item.contactId)] : [];
  const chosen = people.find((person) => person.contactId === contactId);
  const canNotice = Boolean(compose?.connection) && compose.recipients.length > 0;
  const noticeFields = compose?.notices.find((item) => item.key === templateKey)?.fields || [];
  const noticeReady = noticeFields.every((field) => String(fields[field] || '').trim());
  const canText = Boolean(compose?.connection && chosen?.consent && chosen?.windowOpen && text.trim());
  const textModes = target.entityType !== 'batch';
  const noticeModes = target.entityType !== 'lead';

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><MessageCircle className="h-5 w-5" aria-hidden /> Message {target.entityType === 'batch' ? 'the batch' : target.label}</DialogTitle>
          <DialogDescription>
            {compose?.connection ? <>Sent on WhatsApp from your class’s number {compose.connection.displayPhone}.</> : 'WhatsApp isn’t connected for your class, so you can message from your own phone.'}
          </DialogDescription>
        </DialogHeader>
        {!compose && !error && <Skeleton className="h-48 w-full" />}
        {error && <Alert variant="destructive"><AlertDescription>{error.message}</AlertDescription></Alert>}
        {compose?.connection?.health === 'blocked' && (
          <Alert variant="destructive" role="alert"><AlertTriangle className="h-4 w-4" aria-hidden /><AlertDescription><strong>Messages are on hold.</strong> {compose.connection.healthReason} They will send once this is fixed.</AlertDescription></Alert>
        )}
        {compose && done && (
          <div className="space-y-4">
            <Alert><AlertDescription role="status">{done}</AlertDescription></Alert>
            <div className="flex justify-end"><Button onClick={onClose}>Done</Button></div>
          </div>
        )}
        {compose && !done && (
          <div className="space-y-5">
            {noticeModes && textModes && (
              <div className="inline-flex rounded-full bg-sunken p-1" role="tablist" aria-label="Kind of message">
                {[['notice', 'Class notice'], ['text', 'Message']].map(([key, label]) => (
                  <button key={key} type="button" role="tab" aria-selected={mode === key} className={`rounded-full px-4 py-1.5 text-sm ${mode === key ? 'bg-card font-semibold shadow-sm' : 'text-muted-foreground'}`} onClick={() => setMode(key)}>{label}</button>
                ))}
              </div>
            )}
            {mode === 'notice' && noticeModes && (
              <>
                <NoticeForm compose={compose} fields={fields} setFields={setFields} templateKey={templateKey} setTemplateKey={setTemplateKey} />
                <Recipients compose={compose} />
                {!compose.connection && <p className="text-sm text-muted-foreground">Class notices go out from the class’s WhatsApp number. Ask an admin to connect it in Settings → WhatsApp.</p>}
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={onClose}>Cancel</Button>
                  <Button onClick={() => send('notice')} disabled={busy || !canNotice || !noticeReady}>{busy ? 'Sending…' : `Send to ${compose.recipients.length}`}</Button>
                </div>
              </>
            )}
            {mode === 'text' && textModes && (
              <>
                {people.length ? <TextForm compose={compose} contactId={contactId} setContactId={setContactId} text={text} setText={setText} /> : <p className="text-sm text-muted-foreground">No guardian with a phone number.</p>}
                <div className="flex flex-wrap justify-end gap-2">
                  <Button variant="outline" onClick={onClose}>Cancel</Button>
                  <Button variant={canText ? 'outline' : 'default'} onClick={() => send('phone')} disabled={busy || !chosen || !text.trim()}><Smartphone className="h-4 w-4" aria-hidden /> Send from my phone</Button>
                  {compose.connection && <Button onClick={() => send('text')} disabled={busy || !canText}>{busy ? 'Sending…' : 'Send on WhatsApp'}</Button>}
                </div>
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** A Message button that owns its dialog. Shown only with `crm.comms.send`. */
export function MessageButton({ me, target, onSent, label = 'Message', variant = 'outline', size }) {
  const [open, setOpen] = useState(false);
  if (!me?.capabilities?.includes('crm.comms.send')) return null;
  return (
    <>
      <Button variant={variant} size={size} onClick={() => setOpen(true)}><MessageCircle className="h-4 w-4" aria-hidden /> {label}</Button>
      <MessageDialog open={open} onClose={() => setOpen(false)} target={target} onSent={onSent} />
    </>
  );
}
