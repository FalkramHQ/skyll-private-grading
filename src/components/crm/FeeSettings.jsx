// Settings → Fees (CRM M2 phase 1 S1, D6): the prefix in invoice and receipt
// numbers, and the header printed on them. Until saved, the values come from
// the school's details.
import { useCallback, useEffect, useState } from 'react';
import { Alert, AlertDescription } from '../ui/Alert';
import { Button } from '../ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/Card';
import { Input } from '../ui/Input';
import { Skeleton } from '../ui/Skeleton';
import { crmFetch, newIdempotencyKey } from '../../lib/crm/api';
import { feeSettingsBody, financialYear } from '../../../shared/crm/fees.js';
import { fieldErrors } from '../../../shared/crm/leads.js';
import { localDate } from '../../../shared/crm/time.js';
import { Field, Textarea } from './leads/leadUi';

const FIELDS = ['prefix', 'headerName', 'headerAddress', 'headerPhone', 'headerGstin', 'footerNote'];
const formFrom = (settings) => Object.fromEntries(FIELDS.map((key) => [key, settings[key] || '']));

export default function FeeSettings({ timezone }) {
  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState(null);
  const [status, setStatus] = useState('loading');
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [fy] = useState(() => financialYear(localDate(Date.now(), timezone)));

  const show = (data) => { setSettings(data); setForm(formFrom(data)); };

  const load = useCallback(async () => {
    setStatus('loading');
    setError(null);
    try {
      show(await crmFetch('settings/fees'));
      setStatus('ready');
    } catch (err) {
      setError(err);
      setStatus('error');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (status === 'loading') return <Skeleton className="h-64 w-full" />;
  if (status === 'error') return <Alert variant="destructive"><AlertDescription>{error.message}</AlertDescription></Alert>;

  const set = (key) => (event) => {
    const value = key === 'prefix' ? event.target.value.toUpperCase() : event.target.value;
    setForm((current) => ({ ...current, [key]: value }));
    setSaved(false);
  };
  const body = { ...Object.fromEntries(FIELDS.map((key) => [key, form[key].trim()])), expectedVersion: settings.version };
  const parsed = feeSettingsBody.safeParse(body);
  const errors = touched ? fieldErrors(parsed) : {};
  const dirty = !settings.saved || FIELDS.some((key) => form[key] !== (settings[key] || ''));
  const prefix = parsed.success ? parsed.data.prefix : (form.prefix || 'XX');

  const submit = async (event) => {
    event.preventDefault();
    setTouched(true);
    if (!parsed.success) return;
    setBusy(true);
    setError(null);
    try {
      show(await crmFetch('settings/fees', { method: 'POST', idempotencyKey: newIdempotencyKey(), body: parsed.data }));
      setSaved(true);
    } catch (err) {
      setError(err);
      if (err.code === 'version_conflict') load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>Fee documents</CardTitle>
        <CardDescription>Used on every invoice and receipt. Documents already issued keep the details they were issued with.</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={submit} noValidate>
          {!settings.saved && (
            <Alert><AlertDescription>Filled in from your school&apos;s details. Check them and save before adding fees.</AlertDescription></Alert>
          )}
          <Field
            label="Number prefix"
            htmlFor="fees-prefix"
            error={errors.prefix}
            hint={`Invoices will be numbered ${prefix}/INV/${fy}/0001 and receipts ${prefix}/RCP/${fy}/0001.`}
          >
            <Input id="fees-prefix" className="w-40 uppercase" maxLength={8} value={form.prefix} onChange={set('prefix')} />
          </Field>
          <Field label="Name on documents" htmlFor="fees-name" error={errors.headerName}>
            <Input id="fees-name" maxLength={120} value={form.headerName} onChange={set('headerName')} />
          </Field>
          <Field label="Address (optional)" htmlFor="fees-address">
            <Textarea id="fees-address" maxLength={300} value={form.headerAddress} onChange={set('headerAddress')} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Phone (optional)" htmlFor="fees-phone">
              <Input id="fees-phone" type="tel" maxLength={40} value={form.headerPhone} onChange={set('headerPhone')} />
            </Field>
            <Field label="GSTIN (optional)" htmlFor="fees-gstin" hint="Printed only; fees are not taxed">
              <Input id="fees-gstin" className="uppercase" maxLength={20} value={form.headerGstin} onChange={set('headerGstin')} />
            </Field>
          </div>
          <Field label="Footer note (optional)" htmlFor="fees-footer" hint="For example your refund policy or bank details">
            <Textarea id="fees-footer" maxLength={300} value={form.footerNote} onChange={set('footerNote')} />
          </Field>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error.code === 'version_conflict' ? 'Someone else saved these settings meanwhile. The latest values are shown.' : error.message}</AlertDescription>
            </Alert>
          )}
          <div className="flex items-center justify-end gap-3">
            {saved && !dirty && <span className="text-sm text-muted-foreground" role="status">Saved</span>}
            <Button type="submit" disabled={busy || !dirty}>Save</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
