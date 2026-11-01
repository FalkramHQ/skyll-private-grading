// Settings → WhatsApp (CRM M2 phase 2 S1, D2/D6/D7/D15): connect the class's
// own number, see Meta's template approvals, and set the class details,
// automatic messages, reminder schedule and monthly limit.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, MessageCircle, RefreshCw, Smartphone } from 'lucide-react';
import { Alert, AlertDescription } from '../../ui/Alert';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/Card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../ui/Dialog';
import { Input } from '../../ui/Input';
import { Select } from '../../ui/Select';
import { Skeleton } from '../../ui/Skeleton';
import { crmFetch, newIdempotencyKey } from '../../../lib/crm/api';
import { useDraft } from '../../../lib/crm/useDraft';
import { launchEmbeddedSignup } from '../../../lib/crm/embeddedSignup';
import {
  AUTO_MESSAGES, CONNECTION_MODE_LABELS, QUALITY_LABELS, SCHEDULE_FIELDS, TEMPLATE_STATUS_LABELS, waSettingsBody,
} from '../../../../shared/crm/comms.js';
import { WA_LANGUAGES, WA_LANGUAGE_LABELS, WA_VARIABLES, renderTemplate } from '../../../../shared/crm/waTemplates.js';
import { fieldErrors } from '../../../../shared/crm/leads.js';
import { Field, Textarea, formatDate } from '../leads/leadUi';
import UsageCard from './UsageCard';

const post = (path, body = {}) => crmFetch(path, { method: 'POST', body, idempotencyKey: newIdempotencyKey() });

const STATUS_VARIANT = { approved: 'success', pending: 'warning', rejected: 'destructive', paused: 'destructive', disabled: 'destructive', failed: 'destructive' };

const SCHEDULE_LABELS = {
  remindDaysBefore: ['Days before the due date', '0 turns the before-due reminder off'],
  overdueFirstDay: ['First overdue reminder, days after', null],
  overdueGapDays: ['Then every … days', null],
  overdueCount: ['Overdue reminders at most', '0 turns overdue reminders off'],
  sendHour: ['Send at (school time)', 'Between 8:00 and 20:00'],
};

function formFrom(settings) {
  return {
    language: settings.language,
    senderName: settings.senderName,
    contactLine: settings.contactLine,
    paymentInstructions: settings.paymentInstructions,
    auto: { ...settings.auto },
    schedule: Object.fromEntries(Object.entries(settings.schedule).map(([key, value]) => [key, String(value)])),
    monthlyLimit: settings.monthlyLimitPaise === null ? '' : String(settings.monthlyLimitPaise / 100),
  };
}

function toBody(form, version) {
  const limit = form.monthlyLimit.trim();
  return {
    language: form.language,
    senderName: form.senderName.trim(),
    contactLine: form.contactLine.trim(),
    paymentInstructions: form.paymentInstructions.trim(),
    auto: form.auto,
    schedule: form.schedule,
    monthlyLimitPaise: limit === '' ? null : Math.round(Number(limit) * 100),
    expectedVersion: version,
  };
}

function ManualConnectDialog({ open, onClose, onDone }) {
  const [form, setForm] = useState({ wabaId: '', phoneNumberId: '', accessToken: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value.trim() }));
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onDone(await post('settings/whatsapp/connect-manual', form));
      setForm({ wabaId: '', phoneNumberId: '', accessToken: '' });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect a number manually</DialogTitle>
          <DialogDescription>For Meta’s test number or a number set up in Falkram’s Meta account. Use a system-user token with WhatsApp messaging and management permissions.</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit}>
          <Field label="WhatsApp Business Account ID" htmlFor="wa-waba"><Input id="wa-waba" inputMode="numeric" value={form.wabaId} onChange={set('wabaId')} /></Field>
          <Field label="Phone number ID" htmlFor="wa-phone"><Input id="wa-phone" inputMode="numeric" value={form.phoneNumberId} onChange={set('phoneNumberId')} /></Field>
          <Field label="Access token" htmlFor="wa-token" hint="Stored encrypted. It is never shown again."><Input id="wa-token" type="password" autoComplete="off" value={form.accessToken} onChange={set('accessToken')} /></Field>
          {error && <Alert variant="destructive"><AlertDescription>{error.message}</AlertDescription></Alert>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy || !form.wabaId || !form.phoneNumberId || !form.accessToken}>{busy ? 'Connecting…' : 'Connect'}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DisconnectDialog({ open, connection, onClose, onDone }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      onDone(await post('settings/whatsapp/disconnect', { expectedVersion: connection.version }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Disconnect WhatsApp?</DialogTitle>
          <DialogDescription>
            Skyll stops sending from {connection?.displayPhone}. Messages waiting to go out are cancelled, and staff can only use Send from my phone until you connect again.
            The number keeps working in the WhatsApp Business app.
          </DialogDescription>
        </DialogHeader>
        {error && <Alert variant="destructive"><AlertDescription>{error.message}</AlertDescription></Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Keep connected</Button>
          <Button variant="destructive" onClick={confirm} disabled={busy}>{busy ? 'Disconnecting…' : 'Disconnect'}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ConnectionCard({ data, onChange }) {
  const { connection, signup, platform } = data;
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [manual, setManual] = useState(false);
  const [disconnect, setDisconnect] = useState(false);

  const connect = async (coexistence) => {
    setBusy(coexistence ? 'app' : 'new');
    setError(null);
    try {
      const session = await launchEmbeddedSignup(signup, { coexistence });
      onChange(await post('settings/whatsapp/connect', session));
    } catch (err) {
      if (!err.cancelled) setError(err);
    } finally {
      setBusy(null);
    }
  };
  const useTest = async () => {
    setBusy('test');
    setError(null);
    try { onChange(await post('settings/whatsapp/connect-test')); } catch (err) { setError(err); } finally { setBusy(null); }
  };

  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><MessageCircle className="h-5 w-5" aria-hidden /> WhatsApp number</CardTitle>
        <CardDescription>Messages to parents go out from your class’s own WhatsApp number. Meta bills your class for them (about ₹0.14 each, including GST).</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {connection ? (
          <>
            {connection.health === 'blocked' && (
              <Alert variant="destructive" role="alert">
                <AlertTriangle className="h-4 w-4" aria-hidden />
                <AlertDescription><strong>Messages are on hold.</strong> {connection.healthReason}</AlertDescription>
              </Alert>
            )}
            <div className="flex flex-wrap items-start justify-between gap-4 rounded-xl border border-hairline p-4">
              <div className="space-y-1">
                <p className="text-lg font-semibold">{connection.displayPhone}</p>
                <p className="text-sm text-muted-foreground">{connection.verifiedName} · connected {formatDate(connection.connectedAt)}</p>
                <div className="flex flex-wrap gap-2 pt-1">
                  <Badge variant={connection.health === 'ok' ? 'success' : 'destructive'}>{connection.health === 'ok' ? 'Sending' : 'On hold'}</Badge>
                  <Badge variant="outline">{CONNECTION_MODE_LABELS[connection.mode]}</Badge>
                  {connection.coexistence && <Badge variant="info"><Smartphone className="h-3 w-3" aria-hidden /> Phone app still works</Badge>}
                  {connection.qualityRating && <Badge variant="secondary">Quality: {QUALITY_LABELS[connection.qualityRating] || connection.qualityRating}</Badge>}
                </div>
              </div>
              <Button variant="outline" onClick={() => setDisconnect(true)}>Disconnect</Button>
            </div>
            {connection.coexistence && (
              <p className="text-sm text-muted-foreground">Open the WhatsApp Business app on the class phone at least once every two weeks, or Meta disconnects the number from Skyll.</p>
            )}
            {connection.provider === 'meta' && (
              <p className="text-sm text-muted-foreground">
                Meta needs a payment card before messages can go out. Add or update it in{' '}
                <a className="underline" href="https://business.facebook.com/billing_hub/payment_settings" target="_blank" rel="noreferrer">Meta Business Suite → Billing</a>.
              </p>
            )}
          </>
        ) : (
          <>
            <p className="text-sm">Not connected. Until you connect, automatic messages are not sent and staff can use <strong>Send from my phone</strong>.</p>
            {signup.available ? (
              <>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => connect(true)} disabled={Boolean(busy)}>{busy === 'app' ? 'Opening Meta…' : 'Connect our WhatsApp Business number'}</Button>
                  <Button variant="outline" onClick={() => connect(false)} disabled={Boolean(busy)}>{busy === 'new' ? 'Opening Meta…' : 'Connect a new number'}</Button>
                </div>
                <p className="text-xs text-muted-foreground">A Meta window opens. Log in with the Facebook account that manages your business, then choose your number. Keeping the number on the WhatsApp Business app is recommended: staff can still chat from the phone.</p>
              </>
            ) : (
              <Alert><AlertDescription>WhatsApp isn’t set up on this server yet. Ask Skyll support to finish the Meta setup.</AlertDescription></Alert>
            )}
          </>
        )}
        {platform && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg bg-sunken p-3">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Skyll support</span>
            <Button size="sm" variant="outline" onClick={() => setManual(true)} disabled={Boolean(busy)}>Connect manually</Button>
            <Button size="sm" variant="outline" onClick={useTest} disabled={Boolean(busy)}>{busy === 'test' ? 'Connecting…' : 'Use test provider'}</Button>
          </div>
        )}
        {error && <Alert variant="destructive"><AlertDescription>{error.message}</AlertDescription></Alert>}
      </CardContent>
      <ManualConnectDialog open={manual} onClose={() => setManual(false)} onDone={(next) => { setManual(false); onChange(next); }} />
      <DisconnectDialog open={disconnect} connection={connection} onClose={() => setDisconnect(false)} onDone={(next) => { setDisconnect(false); onChange(next); }} />
    </Card>
  );
}

function TemplatesCard({ templates, onChange }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const rows = useMemo(() => {
    const byKey = new Map();
    for (const template of templates) {
      if (!byKey.has(template.key)) byKey.set(template.key, { key: template.key, label: template.label });
      byKey.get(template.key)[template.language] = template;
    }
    return [...byKey.values()];
  }, [templates]);
  const refresh = async () => {
    setBusy(true);
    setError(null);
    try { onChange(await post('settings/whatsapp/templates/refresh')); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const approved = templates.filter((template) => template.status === 'approved').length;
  return (
    <Card className="max-w-3xl">
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>Message templates</CardTitle>
          <CardDescription>Meta approves each message’s wording for your number, usually within minutes. {approved} of {templates.length} approved.</CardDescription>
        </div>
        <Button size="sm" variant="outline" onClick={refresh} disabled={busy}><RefreshCw className="h-4 w-4" aria-hidden /> {busy ? 'Checking…' : 'Refresh'}</Button>
      </CardHeader>
      <CardContent>
        {error && <Alert variant="destructive" className="mb-3"><AlertDescription>{error.message}</AlertDescription></Alert>}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs text-muted-foreground"><th className="py-2 pr-4 font-medium">Message</th>{WA_LANGUAGES.map((language) => <th key={language} className="py-2 pr-4 font-medium">{WA_LANGUAGE_LABELS[language]}</th>)}</tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className="border-t border-hairline">
                  <td className="py-2 pr-4">{row.label}</td>
                  {WA_LANGUAGES.map((language) => {
                    const template = row[language];
                    return (
                      <td key={language} className="py-2 pr-4">
                        {template ? <Badge variant={STATUS_VARIANT[template.status]} title={template.reason || undefined}>{TEMPLATE_STATUS_LABELS[template.status]}</Badge> : '—'}
                        {template?.category && template.category !== 'UTILITY' && <span className="ml-2 text-xs text-warning">Meta marked this {template.category.toLowerCase()}</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function Toggle({ id, label, hint, checked, onChange }) {
  return (
    <label htmlFor={id} className="flex items-start gap-3 rounded-lg border border-hairline p-3 text-sm">
      <input id={id} type="checkbox" className="mt-0.5 h-4 w-4" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span><span className="font-medium">{label}</span><span className="block text-xs text-muted-foreground">{hint}</span></span>
    </label>
  );
}

function DetailsForm({ settings, onChange }) {
  const [form, setForm] = useDraft(settings, formFrom);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  const body = toBody(form, settings.version);
  const parsed = waSettingsBody.safeParse(body);
  const errors = touched ? fieldErrors(parsed) : {};
  const dirty = !settings.saved || JSON.stringify(formFrom(settings)) !== JSON.stringify(form);
  const set = (key) => (event) => { setForm((current) => ({ ...current, [key]: event.target.value })); setSaved(false); };
  const setAuto = (key) => (value) => { setForm((current) => ({ ...current, auto: { ...current.auto, [key]: value } })); setSaved(false); };
  const setSchedule = (key) => (event) => { setForm((current) => ({ ...current, schedule: { ...current.schedule, [key]: event.target.value } })); setSaved(false); };

  const preview = useMemo(() => {
    const examples = Object.fromEntries(Object.entries(WA_VARIABLES).map(([key, rule]) => [key, rule.example]));
    try {
      return renderTemplate('fee_due', form.language, {
        ...examples, senderName: form.senderName || examples.senderName, contactLine: form.contactLine, paymentInstructions: form.paymentInstructions,
      });
    } catch { return ''; }
  }, [form.language, form.senderName, form.contactLine, form.paymentInstructions]);

  const submit = async (event) => {
    event.preventDefault();
    setTouched(true);
    if (!parsed.success) return;
    setBusy(true);
    setError(null);
    try {
      onChange(await post('settings/whatsapp', parsed.data));
      setSaved(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="max-w-3xl space-y-6" onSubmit={submit} noValidate>
      <Card>
        <CardHeader>
          <CardTitle>Message details</CardTitle>
          <CardDescription>Filled into Skyll’s approved wording. Changing them never needs Meta’s approval.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6 lg:grid-cols-[1fr_minmax(0,18rem)]">
          <div className="space-y-4">
            <Field label="Language" htmlFor="wa-language">
              <Select id="wa-language" value={form.language} onChange={set('language')}>
                {WA_LANGUAGES.map((language) => <option key={language} value={language}>{WA_LANGUAGE_LABELS[language]}</option>)}
              </Select>
            </Field>
            <Field label="Sender name" htmlFor="wa-sender" error={errors.senderName} hint="How messages introduce your class, e.g. Sharma Classes, Andheri">
              <Input id="wa-sender" maxLength={60} value={form.senderName} onChange={set('senderName')} />
            </Field>
            <Field label="Contact line (optional)" htmlFor="wa-contact" hint="Shown after “Contact:”. Empty means “reply to this message”.">
              <Input id="wa-contact" maxLength={120} value={form.contactLine} onChange={set('contactLine')} placeholder="98200 00000 (office, 10 am to 6 pm)" />
            </Field>
            <Field label="Payment instructions (optional)" htmlFor="wa-pay" hint="Shown on fee reminders. Empty means “Please pay at the class office.”">
              <Textarea id="wa-pay" maxLength={200} value={form.paymentInstructions} onChange={set('paymentInstructions')} placeholder="Pay by UPI to sharmaclasses@okhdfc" />
            </Field>
          </div>
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Preview: fee due soon</p>
            <div className="whitespace-pre-line rounded-xl rounded-tl-sm bg-[#DCF8C6] p-3 text-sm text-[#111B21] shadow-sm" data-testid="wa-preview">{preview}</div>
            <p className="mt-2 text-xs text-muted-foreground">With a <strong>View fees</strong> button that opens the parent’s fees page.</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Automatic messages</CardTitle>
          <CardDescription>Sent to parents who agreed to WhatsApp updates. Fee messages go to the fee payer; the rest go to every guardian.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          {AUTO_MESSAGES.map((item) => (
            <Toggle key={item.key} id={`wa-auto-${item.key}`} label={item.label} hint={item.hint} checked={form.auto[item.key]} onChange={setAuto(item.key)} />
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Fee reminder schedule</CardTitle>
          <CardDescription>Reminders stop once fees are paid, voided or corrected, if the student leaves, or if the parent replies STOP.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {SCHEDULE_FIELDS.map((field) => (
            <Field key={field.key} label={SCHEDULE_LABELS[field.key][0]} htmlFor={`wa-${field.key}`} hint={SCHEDULE_LABELS[field.key][1]} error={errors[`schedule.${field.key}`] && `Enter ${field.min}–${field.max}`}>
              {field.key === 'sendHour' ? (
                <Select id={`wa-${field.key}`} value={form.schedule.sendHour} onChange={setSchedule('sendHour')}>
                  {Array.from({ length: field.max - field.min + 1 }, (_, i) => field.min + i).map((hour) => <option key={hour} value={String(hour)}>{`${String(hour).padStart(2, '0')}:00`}</option>)}
                </Select>
              ) : (
                <Input id={`wa-${field.key}`} type="number" min={field.min} max={field.max} value={form.schedule[field.key]} onChange={setSchedule(field.key)} />
              )}
            </Field>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Monthly limit</CardTitle>
          <CardDescription>When this month’s estimated WhatsApp cost reaches the limit, automatic messages wait until next month or until you raise it.</CardDescription>
        </CardHeader>
        <CardContent>
          <Field label="Limit in ₹ (optional)" htmlFor="wa-limit" error={errors.monthlyLimitPaise && 'Between ₹100 and ₹1,00,00,000'} hint="Empty means no limit.">
            <Input id="wa-limit" className="w-48" type="number" min={100} step={1} value={form.monthlyLimit} onChange={set('monthlyLimit')} />
          </Field>
        </CardContent>
      </Card>

      {error && <Alert variant="destructive"><AlertDescription>{error.code === 'version_conflict' ? 'Someone else saved these settings meanwhile. Reload to see the latest.' : error.message}</AlertDescription></Alert>}
      <div className="flex items-center justify-end gap-3">
        {saved && !dirty && <span className="flex items-center gap-1 text-sm text-muted-foreground" role="status"><CheckCircle2 className="h-4 w-4" aria-hidden /> Saved</span>}
        <Button type="submit" disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save'}</Button>
      </div>
    </form>
  );
}

export default function WhatsAppSettings() {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setStatus('loading');
    try {
      setData(await crmFetch('settings/whatsapp'));
      setStatus('ready');
    } catch (err) {
      setError(err);
      setStatus('error');
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (status === 'loading') return <Skeleton className="h-64 w-full max-w-3xl" />;
  if (status === 'error') return <Alert variant="destructive"><AlertDescription>{error.message}</AlertDescription></Alert>;

  return (
    <div className="space-y-6">
      <ConnectionCard data={data} onChange={setData} />
      {data.connection && <UsageCard refreshKey={data.settings.version} />}
      {data.connection && data.templates.length > 0 && <TemplatesCard templates={data.templates} onChange={setData} />}
      <DetailsForm settings={data.settings} onChange={setData} />
    </div>
  );
}
