// Invoice dialogs on the student's Fees card (CRM M2 phase 1 S2, D3/D4):
// Add fees from a plan (preview, per-student edits, confirm), a manual invoice,
// correct (void + re-issue), void, and stop future fees.
import { useEffect, useMemo, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Alert, AlertDescription } from '../../ui/Alert';
import { Button } from '../../ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../ui/Dialog';
import { Input } from '../../ui/Input';
import { Select } from '../../ui/Select';
import { crmFetch } from '../../../lib/crm/api';
import { formatDay } from '../../../lib/crm/classes';
import { feeErrorText, feeRequest } from '../../../lib/crm/fees';
import {
  applyBody, correctInvoiceBody, formatMoney, linesTotal, manualInvoiceBody, stopFutureBody, voidInvoiceBody,
} from '../../../../shared/crm/fees.js';
import { fieldErrors } from '../../../../shared/crm/leads.js';
import { Field, Textarea } from '../leads/leadUi';
import { FormFooter } from '../classes/ClassDialogs';
import { LinesEditor, fromEditableLines, lineErrors, toEditableLines } from './feeUi';

/** One request key per opening of a dialog (see feeRequest). */
function useSubmit(onDone, open) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const send = useMemo(() => feeRequest(), [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const run = async (path, body) => {
    setBusy(true);
    setError(null);
    try {
      onDone(await send(path, body));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}

const ErrorAlert = ({ error }) => (error ? <Alert variant="destructive"><AlertDescription>{feeErrorText(error)}</AlertDescription></Alert> : null);

function startNote(preview) {
  if (preview.startSource === 'batch') return `Dates count from ${formatDay(preview.startDate)}, when ${preview.batchName} started.`;
  if (preview.startSource === 'today') return `Dates count from today, ${formatDay(preview.startDate)}.`;
  return `Dates count from ${formatDay(preview.startDate)}.`;
}

/** Add fees: choose a plan, check and edit the invoices it makes, then issue them. */
export function AddFeesDialog({ open, onOpenChange, student, courseIds = [], batchId = null, onSaved }) {
  const [plans, setPlans] = useState(null);
  const [planId, setPlanId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [preview, setPreview] = useState(null);
  const [invoices, setInvoices] = useState([]);
  const [loadError, setLoadError] = useState(null);
  const [touched, setTouched] = useState(false);
  const submit = useSubmit(onSaved, open);

  useEffect(() => {
    if (!open) return;
    setPlanId('');
    setStartDate('');
    setPreview(null);
    setInvoices([]);
    setTouched(false);
    setLoadError(null);
    submit.setError(null);
    crmFetch('fees/plans?status=active').then((result) => {
      const suggested = result.items.filter((plan) => plan.course && courseIds.includes(plan.course.id));
      setPlans({ suggested, others: result.items.filter((plan) => !suggested.includes(plan)) });
      if (suggested.length === 1) setPlanId(suggested[0].id);
    }).catch(setLoadError);
    // courseIds is a fresh array each render; the dialog reloads only when opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || !planId) return;
    let cancelled = false;
    const query = new URLSearchParams({ studentId: student.id, planId, ...(startDate ? { startDate } : batchId ? { batchId } : {}) });
    crmFetch(`fees/preview?${query}`).then((result) => {
      if (cancelled) return;
      setPreview(result);
      setInvoices(result.invoices.map((invoice) => ({ dueDate: invoice.dueDate, lines: toEditableLines(invoice.lines) })));
    }).catch((err) => !cancelled && setLoadError(err));
    return () => { cancelled = true; };
  }, [open, planId, startDate, student.id, batchId]);

  // `startDate` is only what the user picked; until then the server's default applies.
  const body = { studentId: student.id, planId, startDate: startDate || preview?.startDate || '', invoices: invoices.map((invoice) => ({ dueDate: invoice.dueDate, lines: fromEditableLines(invoice.lines) })) };
  const parsed = applyBody.safeParse(body);
  const total = parsed.success ? parsed.data.invoices.reduce((sum, invoice) => sum + linesTotal(invoice.lines), 0) : null;
  const choosePlan = (event) => {
    // Choosing the plan already shown keeps its preview (and any edits).
    if (event.target.value === planId) return;
    setPlanId(event.target.value); setStartDate(''); setPreview(null); setInvoices([]);
  };
  const setInvoice = (index, patch) => setInvoices((current) => current.map((invoice, at) => (at === index ? { ...invoice, ...patch } : invoice)));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add fees for {student.name}</DialogTitle>
          <DialogDescription>Choose a plan, check the invoices it makes, change anything for this student, then issue them.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          noValidate
          onSubmit={(event) => { event.preventDefault(); setTouched(true); if (parsed.success) submit.run('fees/apply', parsed.data); }}
        >
          <ErrorAlert error={loadError} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Fee plan" htmlFor="add-fees-plan">
              <Select id="add-fees-plan" value={planId} onChange={choosePlan} disabled={!plans}>
                <option value="">{plans ? 'Choose a plan…' : 'Loading…'}</option>
                {plans?.suggested.length > 0 && (
                  <optgroup label="For this student's course">
                    {plans.suggested.map((plan) => <option key={plan.id} value={plan.id}>{plan.name} · {formatMoney(plan.totalPaise)}</option>)}
                  </optgroup>
                )}
                {plans?.others.length > 0 && (
                  <optgroup label={plans.suggested.length ? 'Other plans' : 'Plans'}>
                    {plans.others.map((plan) => <option key={plan.id} value={plan.id}>{plan.name} · {formatMoney(plan.totalPaise)}</option>)}
                  </optgroup>
                )}
              </Select>
            </Field>
            <Field label="Start date" htmlFor="add-fees-start" hint={preview ? startNote(preview) : 'Due dates count from here'}>
              <Input id="add-fees-start" type="date" value={startDate || preview?.startDate || ''} disabled={!planId} onChange={(event) => event.target.value && setStartDate(event.target.value)} />
            </Field>
          </div>
          {plans && !plans.suggested.length && !plans.others.length && (
            <p className="text-sm text-muted-foreground">No active fee plans yet. Create one under Fees → Fee plans, or use New invoice.</p>
          )}

          {preview && (
            <>
              {preview.alreadyFromPlan > 0 && (
                <Alert><AlertDescription>{student.name} already has {preview.alreadyFromPlan} invoice{preview.alreadyFromPlan === 1 ? '' : 's'} from this plan. Check you&apos;re not adding them twice.</AlertDescription></Alert>
              )}
              <p className="text-sm text-muted-foreground">
                Billed to {preview.billedTo || `${student.name} (no fee payer set)`}.
              </p>
              <ol className="space-y-3">
                {invoices.map((invoice, index) => (
                  // Proposed invoices have no id; rows are only removed.
                  <li key={index} className="space-y-2 rounded-lg border border-border p-3">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">Invoice {index + 1}</span>
                      <label htmlFor={`add-fees-due-${index}`} className="ml-auto text-xs text-muted-foreground">Due</label>
                      <Input id={`add-fees-due-${index}`} type="date" className="h-8 w-40 text-sm" value={invoice.dueDate} onChange={(event) => setInvoice(index, { dueDate: event.target.value })} />
                      <Button type="button" variant="ghost" size="icon" className="h-8 w-8" aria-label={`Remove invoice ${index + 1}`} disabled={invoices.length === 1} onClick={() => setInvoices((current) => current.filter((_, at) => at !== index))}>
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </div>
                    <LinesEditor
                      idPrefix={`add-fees-${index}`}
                      compact
                      lines={invoice.lines}
                      onChange={(lines) => setInvoice(index, { lines })}
                      errors={touched ? lineErrors(parsed, `invoices.${index}.lines`) : {}}
                    />
                  </li>
                ))}
              </ol>
              {touched && fieldErrors(parsed).invoices && <p className="text-xs text-destructive">{fieldErrors(parsed).invoices}</p>}
              <div className="flex items-baseline justify-between rounded-lg bg-muted px-3 py-2">
                <span className="text-sm text-muted-foreground">{invoices.length} invoice{invoices.length === 1 ? '' : 's'}</span>
                <span className="text-lg font-semibold tabular-nums">{total === null ? '—' : formatMoney(total)}</span>
              </div>
            </>
          )}
          <ErrorAlert error={submit.error} />
          <FormFooter busy={submit.busy} onCancel={() => onOpenChange(false)} disabled={!preview} submitLabel={`Issue ${invoices.length || ''} invoice${invoices.length === 1 ? '' : 's'}`.replace('  ', ' ')} />
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** New invoice for one-off charges, or (with `invoice`) Correct invoice: void it and issue this instead. */
export function InvoiceDialog({ open, onOpenChange, student, invoice, today, onSaved }) {
  const correcting = Boolean(invoice);
  const [dueDate, setDueDate] = useState('');
  const [lines, setLines] = useState([]);
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const submit = useSubmit(onSaved, open);

  useEffect(() => {
    if (!open) return;
    setDueDate(invoice?.dueDate || today);
    setLines(invoice ? toEditableLines(invoice.lines) : [{ label: '', amount: '' }]);
    setReason('');
    setTouched(false);
    submit.setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, invoice, today]);

  const body = correcting
    ? { invoiceId: invoice.id, reason: reason.trim(), dueDate, lines: fromEditableLines(lines) }
    : { studentId: student.id, dueDate, lines: fromEditableLines(lines) };
  const parsed = (correcting ? correctInvoiceBody : manualInvoiceBody).safeParse(body);
  const errors = touched ? fieldErrors(parsed) : {};
  const total = useMemo(() => fromEditableLines(lines).reduce((sum, line) => sum + (Number.isNaN(line.amountPaise) ? 0 : line.amountPaise), 0), [lines]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{correcting ? `Correct ${invoice.number}` : 'New invoice'}</DialogTitle>
          <DialogDescription>
            {correcting
              ? 'Issued invoices are never edited. This voids the invoice and issues a corrected one with a new number.'
              : `A one-off charge for ${student.name}, such as a material kit or exam fee.`}
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" noValidate onSubmit={(event) => { event.preventDefault(); setTouched(true); if (parsed.success) submit.run(correcting ? 'fees/invoices/correct' : 'fees/invoices', parsed.data); }}>
          <Field label="Due date" htmlFor="invoice-due" error={errors.dueDate}>
            <Input id="invoice-due" type="date" className="w-44" value={dueDate} onChange={(event) => setDueDate(event.target.value)} />
          </Field>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Charges</legend>
            <LinesEditor idPrefix="invoice" lines={lines} onChange={setLines} errors={touched ? lineErrors(parsed, 'lines') : {}} />
          </fieldset>
          <div className="flex items-baseline justify-between rounded-lg bg-muted px-3 py-2">
            <span className="text-sm text-muted-foreground">Total</span>
            <span className="text-lg font-semibold tabular-nums">{formatMoney(total)}</span>
          </div>
          {correcting && (
            <Field label="Reason for the correction" htmlFor="invoice-reason" error={errors.reason} hint="Kept in the audit log. Don't include personal details.">
              <Input id="invoice-reason" maxLength={280} value={reason} onChange={(event) => setReason(event.target.value)} />
            </Field>
          )}
          <ErrorAlert error={submit.error} />
          <FormFooter busy={submit.busy} onCancel={() => onOpenChange(false)} submitLabel={correcting ? 'Void and re-issue' : 'Issue invoice'} />
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ReasonDialog({ open, onOpenChange, title, description, children, reasonLabel, submitLabel, onSubmit, busy, error, extraValid = true }) {
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  useEffect(() => { if (open) { setReason(''); setTouched(false); } }, [open]);
  const parsed = voidInvoiceBody.shape.reason.safeParse(reason);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" noValidate onSubmit={(event) => { event.preventDefault(); setTouched(true); if (parsed.success && extraValid) onSubmit(parsed.data); }}>
          {children}
          <Field label={reasonLabel} htmlFor="fees-reason" error={touched && !parsed.success ? parsed.error.issues[0].message : undefined} hint="Kept in the audit log. Don't include personal details.">
            <Textarea id="fees-reason" maxLength={280} value={reason} onChange={(event) => setReason(event.target.value)} />
          </Field>
          <ErrorAlert error={error} />
          <FormFooter busy={busy} onCancel={() => onOpenChange(false)} submitLabel={submitLabel} />
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function VoidInvoiceDialog({ open, onOpenChange, invoice, onSaved }) {
  const submit = useSubmit(onSaved, open);
  useEffect(() => { if (open) submit.setError(null); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!invoice) return null;
  return (
    <ReasonDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Void ${invoice.number}?`}
      description={`${formatMoney(invoice.totalPaise)} due ${formatDay(invoice.dueDate)}. The invoice keeps its number and stays in the history, marked void.`}
      reasonLabel="Reason"
      submitLabel="Void invoice"
      busy={submit.busy}
      error={submit.error}
      onSubmit={(reason) => submit.run('fees/invoices/void', { invoiceId: invoice.id, reason })}
    />
  );
}

/** Voids unpaid invoices due on or after a date (D4/D9). */
export function StopFutureDialog({ open, onOpenChange, student, invoices, today, onSaved }) {
  const [fromDate, setFromDate] = useState(today);
  const submit = useSubmit(onSaved, open);
  useEffect(() => { if (open) { setFromDate(today); submit.setError(null); } }, [open, today]); // eslint-disable-line react-hooks/exhaustive-deps
  const affected = invoices.filter((invoice) => invoice.status === 'issued' && invoice.paidPaise === 0 && invoice.dueDate >= fromDate);
  const valid = stopFutureBody.shape.fromDate.safeParse(fromDate).success && affected.length > 0;
  return (
    <ReasonDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Stop future fees"
      description={`Voids ${student.name}'s unpaid invoices due on or after the date you choose. Earlier invoices and anything already paid stay.`}
      reasonLabel="Reason"
      submitLabel={affected.length ? `Void ${affected.length} invoice${affected.length === 1 ? '' : 's'}` : 'Nothing to void'}
      busy={submit.busy}
      error={submit.error}
      extraValid={valid}
      onSubmit={(reason) => submit.run('fees/invoices/stop-future', { studentId: student.id, fromDate, reason })}
    >
      <Field label="From" htmlFor="stop-from" hint={affected.length ? `${affected.length} invoice${affected.length === 1 ? '' : 's'}, ${formatMoney(affected.reduce((sum, invoice) => sum + invoice.totalPaise, 0))}` : 'No unpaid invoices are due from this date'}>
        <Input id="stop-from" type="date" className="w-44" value={fromDate} onChange={(event) => setFromDate(event.target.value)} />
      </Field>
    </ReasonDialog>
  );
}
