// Payment dialogs (CRM M2 phase 1 S3, D5/D8): Record payment with an editable
// oldest-first allocation preview, Reverse payment, and Move money between
// invoices and credit. The server and the database re-check every amount.
import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { Alert, AlertDescription } from '../../ui/Alert';
import { Button } from '../../ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../ui/Dialog';
import { Input } from '../../ui/Input';
import { Select } from '../../ui/Select';
import { Skeleton } from '../../ui/Skeleton';
import { crmFetch } from '../../../lib/crm/api';
import { formatDay } from '../../../lib/crm/classes';
import { feeErrorText, feeRequest } from '../../../lib/crm/fees';
import {
  PAYMENT_METHODS, PAYMENT_METHOD_LABELS, formatMoney, moveAllocationBody, oldestFirst, paiseToRupees, recordPaymentBody, reversePaymentBody, rupeesToPaise,
} from '../../../../shared/crm/fees.js';
import { fieldErrors } from '../../../../shared/crm/leads.js';
import { Field, Textarea } from '../leads/leadUi';
import { FormFooter } from '../classes/ClassDialogs';
import { DownloadButton, pdfName, receiptPdfPath } from './feeUi';

const plain = (paise) => paiseToRupees(paise).replace(/,/g, '');


/** Record payment for one student. Fetches their open invoices itself, so it works from Dues too. */
export function RecordPaymentDialog({ open, onOpenChange, studentId, onSaved }) {
  const [fees, setFees] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [form, setForm] = useState({ amount: '', receivedOn: '', method: 'cash', reference: '', payerName: '', note: '' });
  const [split, setSplit] = useState(null); // { invoiceId: rupees } once edited by hand
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [recorded, setRecorded] = useState(null);
  const send = useMemo(() => feeRequest(), [open, studentId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open || !studentId) return;
    setFees(null);
    setLoadError(null);
    setSplit(null);
    setTouched(false);
    setError(null);
    setRecorded(null);
    crmFetch(`fees/student?${new URLSearchParams({ studentId })}`).then((data) => {
      setFees(data);
      setForm({ amount: '', receivedOn: data.today, method: 'cash', reference: '', payerName: '', note: '' });
    }).catch(setLoadError);
  }, [open, studentId]);

  const openInvoices = fees ? fees.invoices.filter((invoice) => invoice.status === 'issued' && invoice.balancePaise > 0) : [];
  const amountPaise = rupeesToPaise(form.amount);
  const automatic = oldestFirst(openInvoices, amountPaise || 0);
  const allocations = split
    ? openInvoices.map((invoice) => ({ invoiceId: invoice.id, amountPaise: split[invoice.id] === '' || split[invoice.id] === undefined ? 0 : (rupeesToPaise(split[invoice.id]) ?? Number.NaN) })).filter((item) => item.amountPaise !== 0)
    : automatic;
  const allocated = allocations.reduce((sum, item) => sum + (Number.isNaN(item.amountPaise) ? 0 : item.amountPaise), 0);
  const overInvoice = split && openInvoices.some((invoice) => (rupeesToPaise(split[invoice.id] || '0') ?? 0) > invoice.balancePaise);
  const body = {
    studentId, amountPaise: amountPaise ?? Number.NaN, receivedOn: form.receivedOn, method: form.method,
    reference: form.reference.trim() || undefined, payerName: form.payerName.trim() || undefined, note: form.note.trim() || undefined, allocations,
  };
  const parsed = recordPaymentBody.safeParse(body);
  const errors = touched ? fieldErrors(parsed) : {};
  const valid = parsed.success && !overInvoice && (!fees || form.receivedOn <= fees.today);
  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const editSplit = (invoiceId) => (event) => setSplit((current) => ({
    ...(current || Object.fromEntries(automatic.map((item) => [item.invoiceId, plain(item.amountPaise)]))),
    [invoiceId]: event.target.value,
  }));

  const submit = async (event) => {
    event.preventDefault();
    setTouched(true);
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      setRecorded(await send('fees/payments', parsed.data));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const close = (next) => { if (!next && recorded) onSaved(recorded); onOpenChange(next); };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{recorded ? 'Payment recorded' : `Record payment${fees ? ` for ${fees.student.name}` : ''}`}</DialogTitle>
          <DialogDescription>
            {recorded ? 'The receipt number is final. Mistakes are fixed by reversing the payment.' : 'Money received. It goes to the oldest dues first unless you change it; anything left becomes credit.'}
          </DialogDescription>
        </DialogHeader>
        {loadError && <Alert variant="destructive"><AlertDescription>{loadError.message}</AlertDescription></Alert>}
        {!fees && !loadError && <Skeleton className="h-64 w-full" />}
        {recorded && (
          <div className="space-y-4">
            <div className="flex items-start gap-3 rounded-lg bg-muted p-4">
              <CheckCircle2 className="mt-0.5 h-5 w-5 text-success" aria-hidden="true" />
              <div className="space-y-1 text-sm">
                <p className="font-medium">Receipt {recorded.receiptNumber}</p>
                <p>{formatMoney(recorded.amountPaise)} by {PAYMENT_METHOD_LABELS[recorded.method]} on {formatDay(recorded.receivedOn)}</p>
                {recorded.allocations.map((item) => <p key={item.invoiceId} className="text-muted-foreground">{formatMoney(item.amountPaise)} → {item.invoiceNumber}</p>)}
                {recorded.unallocatedPaise > 0 && <p className="text-muted-foreground">{formatMoney(recorded.unallocatedPaise)} kept as credit</p>}
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <DownloadButton path={receiptPdfPath(recorded)} filename={pdfName(recorded.receiptNumber)} variant="outline">Download receipt</DownloadButton>
              <Button onClick={() => close(false)}>Done</Button>
            </div>
          </div>
        )}
        {fees && !recorded && (
          <form className="space-y-4" noValidate onSubmit={submit}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Amount (₹)" htmlFor="payment-amount" error={errors.amountPaise && 'Enter an amount above zero'}>
                <Input id="payment-amount" inputMode="decimal" autoFocus value={form.amount} onChange={set('amount')} />
              </Field>
              <Field label="Received on" htmlFor="payment-date" error={errors.receivedOn || (touched && form.receivedOn > fees.today ? 'Can\'t be in the future' : undefined)}>
                <Input id="payment-date" type="date" max={fees.today} value={form.receivedOn} onChange={set('receivedOn')} />
              </Field>
              <Field label="Method" htmlFor="payment-method">
                <Select id="payment-method" value={form.method} onChange={set('method')}>
                  {PAYMENT_METHODS.map((method) => <option key={method} value={method}>{PAYMENT_METHOD_LABELS[method]}</option>)}
                </Select>
              </Field>
              <Field label="Reference (optional)" htmlFor="payment-reference" hint="UPI or bank reference, cheque number">
                <Input id="payment-reference" maxLength={80} value={form.reference} onChange={set('reference')} />
              </Field>
            </div>
            <Field label="Paid by (optional)" htmlFor="payment-payer" hint={fees.billedTo ? `Leave blank for ${fees.billedTo}` : undefined}>
              <Input id="payment-payer" maxLength={120} placeholder={fees.billedTo || ''} value={form.payerName} onChange={set('payerName')} />
            </Field>

            <fieldset className="space-y-2">
              <legend className="flex w-full items-center text-sm font-medium">
                Goes towards
                {split && <Button type="button" variant="ghost" size="sm" className="ml-auto h-7" onClick={() => setSplit(null)}>Oldest first</Button>}
              </legend>
              {!openInvoices.length && <p className="text-sm text-muted-foreground">No unpaid invoices. The whole amount becomes credit.</p>}
              <ul className="divide-y divide-border rounded-lg border border-border">
                {openInvoices.map((invoice) => {
                  const auto = automatic.find((item) => item.invoiceId === invoice.id)?.amountPaise || 0;
                  return (
                    <li key={invoice.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{invoice.number}</span>
                        <span className="block text-xs text-muted-foreground">Due {formatDay(invoice.dueDate)} · {formatMoney(invoice.balancePaise)} owed{invoice.overdue ? ' · overdue' : ''}</span>
                      </span>
                      <Input
                        aria-label={`Amount for ${invoice.number} (₹)`}
                        inputMode="decimal"
                        className="h-8 w-28 text-right tabular-nums"
                        value={split ? (split[invoice.id] ?? '') : (auto ? plain(auto) : '')}
                        placeholder="0"
                        onChange={editSplit(invoice.id)}
                      />
                    </li>
                  );
                })}
              </ul>
              {overInvoice && <p className="text-xs text-destructive">An amount is more than that invoice owes.</p>}
              {errors.allocations && <p className="text-xs text-destructive">{errors.allocations}</p>}
              {amountPaise > 0 && !errors.allocations && allocated <= amountPaise && (
                <p className="text-xs text-muted-foreground">
                  {formatMoney(allocated)} to invoices{amountPaise - allocated > 0 ? ` · ${formatMoney(amountPaise - allocated)} becomes credit` : ''}
                </p>
              )}
            </fieldset>

            <Field label="Internal note (optional)" htmlFor="payment-note" hint="Staff only. Never printed on the receipt.">
              <Textarea id="payment-note" maxLength={500} value={form.note} onChange={set('note')} />
            </Field>
            {error && <Alert variant="destructive"><AlertDescription>{feeErrorText(error)}</AlertDescription></Alert>}
            <FormFooter busy={busy} onCancel={() => onOpenChange(false)} submitLabel={amountPaise ? `Record ${formatMoney(amountPaise)}` : 'Record payment'} />
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function useAction(onSaved, open) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const send = useMemo(() => feeRequest(), [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const run = async (path, body) => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await send(path, body));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}

export function ReversePaymentDialog({ open, onOpenChange, payment, onSaved }) {
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const action = useAction(onSaved, open);
  useEffect(() => { if (open) { setReason(''); setTouched(false); action.setError(null); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!payment) return null;
  const parsed = reversePaymentBody.safeParse({ paymentId: payment.id, reason: reason.trim() });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reverse {payment.receiptNumber}?</DialogTitle>
          <DialogDescription>
            {formatMoney(payment.amountPaise)} by {PAYMENT_METHOD_LABELS[payment.method]} on {formatDay(payment.receivedOn)}. The invoices it paid become due again, and the receipt shows REVERSED. This can&apos;t be undone; record a new payment if the money arrives later.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" noValidate onSubmit={(event) => { event.preventDefault(); setTouched(true); if (parsed.success) action.run('fees/payments/reverse', parsed.data); }}>
          <Field label="Reason" htmlFor="reverse-reason" error={touched && !parsed.success ? parsed.error.issues[0].message : undefined} hint="For example: Cheque bounced. Kept in the audit log.">
            <Input id="reverse-reason" maxLength={280} value={reason} onChange={(event) => setReason(event.target.value)} />
          </Field>
          {action.error && <Alert variant="destructive"><AlertDescription>{feeErrorText(action.error)}</AlertDescription></Alert>}
          <FormFooter busy={action.busy} onCancel={() => onOpenChange(false)} submitLabel="Reverse payment" />
        </form>
      </DialogContent>
    </Dialog>
  );
}

const CREDIT = '';

/** Moves part of one payment: between invoices, back to credit, or from credit onto an invoice. */
export function MoveAllocationDialog({ open, onOpenChange, payment, invoices, onSaved }) {
  const sources = payment ? [...payment.allocations.map((item) => ({ id: item.invoiceId, label: `${item.invoiceNumber} (${formatMoney(item.amountPaise)})`, max: item.amountPaise })), ...(payment.unallocatedPaise > 0 ? [{ id: CREDIT, label: `Credit (${formatMoney(payment.unallocatedPaise)})`, max: payment.unallocatedPaise }] : [])] : [];
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const action = useAction(onSaved, open);

  useEffect(() => {
    if (!open || !payment) return;
    const first = sources[0];
    setFrom(first?.id ?? CREDIT);
    setAmount(first ? plain(first.max) : '');
    setTo('');
    setReason('');
    setTouched(false);
    action.setError(null);
  }, [open, payment]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!payment) return null;
  const source = sources.find((item) => item.id === from);
  const targets = [
    ...invoices.filter((invoice) => invoice.status === 'issued' && invoice.id !== from && invoice.balancePaise > 0)
      .map((invoice) => ({ id: invoice.id, label: `${invoice.number} · ${formatMoney(invoice.balancePaise)} owed` })),
    ...(from !== CREDIT ? [{ id: CREDIT, label: 'Credit (not on any invoice)' }] : []),
  ];
  const amountPaise = rupeesToPaise(amount);
  const body = { paymentId: payment.id, fromInvoiceId: from || null, toInvoiceId: to || null, amountPaise: amountPaise ?? Number.NaN, reason: reason.trim() };
  const parsed = moveAllocationBody.safeParse(body);
  const tooMuch = source && amountPaise > source.max;
  const errors = touched ? fieldErrors(parsed) : {};

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move money from {payment.receiptNumber}</DialogTitle>
          <DialogDescription>Put part of this payment towards a different invoice, or keep it as credit. Recorded with your reason.</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" noValidate onSubmit={(event) => { event.preventDefault(); setTouched(true); if (parsed.success && !tooMuch) action.run('fees/allocations/move', parsed.data); }}>
          <div className="grid gap-4">
            <Field label="From" htmlFor="move-from">
              <Select id="move-from" value={from} onChange={(event) => { setFrom(event.target.value); setTo(''); setAmount(plain(sources.find((item) => item.id === event.target.value)?.max || 0)); }}>
                {sources.map((item) => <option key={item.id || 'credit'} value={item.id}>{item.label}</option>)}
              </Select>
            </Field>
            <Field label="To" htmlFor="move-to" error={touched && to === '' && from === CREDIT ? 'Choose an invoice' : errors.toInvoiceId}>
              <Select id="move-to" value={to} onChange={(event) => setTo(event.target.value)}>
                {from === CREDIT && <option value="">Choose an invoice…</option>}
                {targets.map((item) => <option key={item.id || 'credit'} value={item.id}>{item.label}</option>)}
              </Select>
            </Field>
          </div>
          <Field label="Amount (₹)" htmlFor="move-amount" error={tooMuch ? `At most ${formatMoney(source.max)}` : errors.amountPaise && 'Enter an amount above zero'}>
            <Input id="move-amount" inputMode="decimal" className="w-40" value={amount} onChange={(event) => setAmount(event.target.value)} />
          </Field>
          <Field label="Reason" htmlFor="move-reason" error={errors.reason} hint="Kept in the audit log.">
            <Input id="move-reason" maxLength={280} value={reason} onChange={(event) => setReason(event.target.value)} />
          </Field>
          {action.error && <Alert variant="destructive"><AlertDescription>{feeErrorText(action.error)}</AlertDescription></Alert>}
          <FormFooter busy={action.busy} onCancel={() => onOpenChange(false)} submitLabel="Move" />
        </form>
      </DialogContent>
    </Dialog>
  );
}
