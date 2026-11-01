// New or edit fee plan (CRM-017, CRM M2 phase 1 S1, D3). Amounts are typed in
// rupees and sent as paise; the total and a sample schedule update as you type.
import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Alert, AlertDescription } from '../../ui/Alert';
import { Button } from '../../ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../ui/Dialog';
import { Input } from '../../ui/Input';
import { Select } from '../../ui/Select';
import { classesWrite, formatDay } from '../../../lib/crm/classes';
import {
  MAX_MONTHS, PLAN_KINDS, PLAN_KIND_LABELS, formatMoney, paiseToRupees, planBody, rupeesToPaise, schedulePreview, updatePlanBody,
} from '../../../../shared/crm/fees.js';
import { fieldErrors } from '../../../../shared/crm/leads.js';
import { Field, Textarea } from '../leads/leadUi';
import { Segmented } from '../tasks/TasksPage';
import { FormFooter } from '../classes/ClassDialogs';

const blankItem = (label = '') => ({ label, amount: '', dueOffsetValue: '0', dueOffsetUnit: 'months' });

function planForm(plan) {
  return {
    name: plan?.name || '',
    courseId: plan?.course?.id || '',
    kind: plan?.kind || 'instalments',
    items: plan?.items.length
      ? plan.items.map((item) => ({ label: item.label, amount: paiseToRupees(item.amountPaise), dueOffsetValue: String(item.dueOffsetValue), dueOffsetUnit: item.dueOffsetUnit }))
      : (plan ? [] : [blankItem('Admission fee')]),
    monthlyAmount: plan?.monthly ? paiseToRupees(plan.monthly.amountPaise) : '',
    monthlyCount: plan?.monthly ? String(plan.monthly.count) : '12',
    monthlyDueDay: plan?.monthly ? String(plan.monthly.dueDay) : '5',
    description: plan?.description || '',
  };
}

function toBody(form, plan) {
  const items = form.items.map((item) => ({
    label: item.label.trim(),
    amountPaise: rupeesToPaise(item.amount) ?? Number.NaN,
    dueOffsetValue: Number(item.dueOffsetValue || 0),
    dueOffsetUnit: item.dueOffsetUnit,
  }));
  return {
    name: form.name.trim(),
    courseId: form.courseId || null,
    kind: form.kind,
    items,
    monthly: form.kind === 'monthly'
      ? { amountPaise: rupeesToPaise(form.monthlyAmount) ?? Number.NaN, count: Number(form.monthlyCount), dueDay: Number(form.monthlyDueDay) }
      : null,
    description: form.description.trim() || undefined,
    ...(plan ? { planId: plan.id, expectedVersion: plan.version } : {}),
  };
}

function offsetLabel(value, unit) {
  if (Number(value) === 0) return 'at start';
  return `${value} ${Number(value) === 1 ? unit.replace(/s$/, '') : unit} after start`;
}

export function SampleSchedule({ schedule, startDate, limit = 6 }) {
  if (!schedule.length) return null;
  const shown = schedule.slice(0, limit);
  return (
    <div className="rounded-lg border border-border">
      <p className="border-b border-border px-3 py-2 text-xs text-muted-foreground">If the fees started on {formatDay(startDate)}:</p>
      <ul className="divide-y divide-border text-sm">
        {shown.map((invoice) => (
          <li key={invoice.dueDate} className="flex items-start gap-3 px-3 py-2">
            <span className="w-28 shrink-0 text-muted-foreground">{formatDay(invoice.dueDate)}</span>
            <span className="min-w-0 flex-1">{invoice.lines.map((line) => line.label).join(' + ')}</span>
            <span className="tabular-nums">{formatMoney(invoice.totalPaise)}</span>
          </li>
        ))}
        {schedule.length > shown.length && <li className="px-3 py-2 text-xs text-muted-foreground">…and {schedule.length - shown.length} more</li>}
      </ul>
    </div>
  );
}

function errorMessage(error) {
  if (!error) return null;
  if (error.code === 'version_conflict') return 'Someone else changed this plan meanwhile. Close and reopen to see the latest version.';
  return error.message;
}

/** `plan` set = edit. `courses` is null when the user can't see courses. */
export function FeePlanDialog({ open, onOpenChange, plan, courses, today, onSaved }) {
  const [form, setForm] = useState(() => planForm(plan));
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    setForm(planForm(plan));
    setTouched(false);
    setError(null);
  }, [open, plan]);

  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const setItem = (index, key) => (event) => setForm((current) => ({
    ...current,
    items: current.items.map((item, at) => (at === index ? { ...item, [key]: event.target.value } : item)),
  }));
  const removeItem = (index) => setForm((current) => ({ ...current, items: current.items.filter((_, at) => at !== index) }));
  const addItem = () => setForm((current) => ({ ...current, items: [...current.items, blankItem(current.kind === 'instalments' ? `Instalment ${current.items.length}` : '')] }));

  const body = toBody(form, plan);
  const parsed = (plan ? updatePlanBody : planBody).safeParse(body);
  const errors = touched ? fieldErrors(parsed) : {};
  const itemError = (index, key) => (touched ? errors[`items.${index}.${key}`] : undefined);
  const schedule = parsed.success ? schedulePreview(parsed.data, today) : [];
  const total = schedule.reduce((sum, invoice) => sum + invoice.totalPaise, 0);
  const keptCourse = plan?.course && courses && !courses.some((course) => course.id === plan.course.id) ? plan.course : null;

  const submit = async (event) => {
    event.preventDefault();
    setTouched(true);
    if (!parsed.success) return;
    setBusy(true);
    setError(null);
    try {
      onSaved(await classesWrite(plan ? 'fees/plans/update' : 'fees/plans', parsed.data));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{plan ? 'Edit fee plan' : 'New fee plan'}</DialogTitle>
          <DialogDescription>
            A template for what a student pays. Changes apply to fees added later; invoices already made keep their amounts.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit} noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Plan name" htmlFor="plan-name" error={errors.name}>
              <Input id="plan-name" maxLength={120} value={form.name} onChange={set('name')} autoFocus />
            </Field>
            {courses
              ? (
                <Field label="Course (optional)" htmlFor="plan-course" hint="Suggested when adding fees for this course's students">
                  <Select id="plan-course" value={form.courseId} onChange={set('courseId')}>
                    <option value="">Any course</option>
                    {keptCourse && <option value={keptCourse.id}>{keptCourse.name} (archived)</option>}
                    {courses.map((course) => <option key={course.id} value={course.id}>{course.name}</option>)}
                  </Select>
                </Field>
              )
              : plan?.course && <Field label="Course"><p className="pt-2 text-sm">{plan.course.name}</p></Field>}
          </div>

          <div className="space-y-1.5">
            <p className="text-sm font-medium">How it&apos;s paid</p>
            <Segmented label="How it's paid" options={PLAN_KINDS.map((kind) => [kind, PLAN_KIND_LABELS[kind]])} value={form.kind} onChange={(kind) => setForm((current) => ({ ...current, kind }))} />
          </div>

          {form.kind === 'monthly' && (
            <fieldset className="grid gap-4 rounded-lg border border-border p-3 sm:grid-cols-3">
              <legend className="px-1 text-sm font-medium">Monthly fee</legend>
              <Field label="Amount each month (₹)" htmlFor="plan-monthly-amount" error={errors['monthly.amountPaise']}>
                <Input id="plan-monthly-amount" inputMode="decimal" value={form.monthlyAmount} onChange={set('monthlyAmount')} />
              </Field>
              <Field label="Number of months" htmlFor="plan-monthly-count" error={errors['monthly.count']} hint={`Up to ${MAX_MONTHS}`}>
                <Input id="plan-monthly-count" type="number" min={1} max={MAX_MONTHS} inputMode="numeric" value={form.monthlyCount} onChange={set('monthlyCount')} />
              </Field>
              <Field label="Due on day" htmlFor="plan-monthly-day" error={errors['monthly.dueDay']} hint="Of each month, 1–28">
                <Input id="plan-monthly-day" type="number" min={1} max={28} inputMode="numeric" value={form.monthlyDueDay} onChange={set('monthlyDueDay')} />
              </Field>
            </fieldset>
          )}

          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">{form.kind === 'monthly' ? 'One-time charges (optional)' : 'Charges'}</legend>
            {form.items.map((item, index) => (
              // Charges have no stable id until saved; rows are only appended or removed.
              <div key={index} className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-[1fr_8rem_auto] sm:items-start">
                <Field label="Charge" htmlFor={`plan-item-${index}-label`} error={itemError(index, 'label')}>
                  <Input id={`plan-item-${index}-label`} maxLength={80} placeholder="Admission fee" value={item.label} onChange={setItem(index, 'label')} />
                </Field>
                <Field label="Amount (₹)" htmlFor={`plan-item-${index}-amount`} error={itemError(index, 'amountPaise') && 'Enter an amount above zero'}>
                  <Input id={`plan-item-${index}-amount`} inputMode="decimal" value={item.amount} onChange={setItem(index, 'amount')} />
                </Field>
                <Field label="Due" htmlFor={`plan-item-${index}-due`} error={itemError(index, 'dueOffsetValue')}>
                  <div className="flex gap-2">
                    <Input id={`plan-item-${index}-due`} type="number" min={0} inputMode="numeric" className="w-20" value={item.dueOffsetValue} onChange={setItem(index, 'dueOffsetValue')} />
                    <Select aria-label="Due unit" value={item.dueOffsetUnit} onChange={setItem(index, 'dueOffsetUnit')}>
                      <option value="months">months after start</option>
                      <option value="days">days after start</option>
                    </Select>
                    <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${item.label || 'charge'}`} onClick={() => removeItem(index)}>
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </div>
                </Field>
              </div>
            ))}
            {errors.items && <p className="text-xs text-destructive">{errors.items}</p>}
            <Button type="button" variant="outline" size="sm" onClick={addItem} disabled={form.items.length >= 24}>
              <Plus className="mr-1 h-4 w-4" aria-hidden="true" />Add a charge
            </Button>
          </fieldset>

          <Field label="Description (optional)" htmlFor="plan-description">
            <Textarea id="plan-description" maxLength={300} value={form.description} onChange={set('description')} />
          </Field>

          <div className="flex items-baseline justify-between rounded-lg bg-muted px-3 py-2">
            <span className="text-sm text-muted-foreground">Total{schedule.length ? ` · ${schedule.length} invoice${schedule.length === 1 ? '' : 's'}` : ''}</span>
            <span className="text-lg font-semibold tabular-nums" aria-live="polite">{parsed.success ? formatMoney(total) : '—'}</span>
          </div>
          <SampleSchedule schedule={schedule} startDate={today} />

          {error && <Alert variant="destructive"><AlertDescription>{errorMessage(error)}</AlertDescription></Alert>}
          <FormFooter busy={busy} onCancel={() => onOpenChange(false)} submitLabel={plan ? 'Save plan' : 'Create plan'} />
        </form>
      </DialogContent>
    </Dialog>
  );
}

export { offsetLabel };
