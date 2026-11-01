// Student profile → Fees (CRM-018, CRM M2 phase 1 S2, D8): balance, overdue,
// invoices, and the actions that issue or void them. Needs crm.finance.read;
// the actions need crm.finance.write (the server re-checks both).
import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Alert, AlertDescription } from '../../ui/Alert';
import { Button } from '../../ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/Card';
import { Skeleton } from '../../ui/Skeleton';
import { crmFetch } from '../../../lib/crm/api';
import { formatDay } from '../../../lib/crm/classes';
import { PAYMENT_METHOD_LABELS, formatMoney } from '../../../../shared/crm/fees.js';
import { DownloadButton, InvoiceStatusBadge, invoicePdfPath, pdfName, receiptPdfPath } from './feeUi';
import { AddFeesDialog, InvoiceDialog, StopFutureDialog, VoidInvoiceDialog } from './InvoiceDialogs';
import { MoveAllocationDialog, RecordPaymentDialog, ReversePaymentDialog } from './PaymentDialogs';
import { ReminderStrip } from '../comms/FeeReminders';

function Stat({ label, value, tone }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-lg font-semibold tabular-nums ${tone || ''}`}>{value}</p>
    </div>
  );
}

function InvoiceRow({ invoice, corrects, replacedBy, canWrite, onCorrect, onVoid }) {
  const [open, setOpen] = useState(false);
  const isVoid = invoice.status === 'void';
  return (
    <li className="py-2">
      <button type="button" className="flex w-full items-center gap-2 text-left" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className={`min-w-0 flex-1 ${isVoid ? 'text-muted-foreground line-through' : ''}`}>
          <span className="block truncate text-sm font-medium">{invoice.number}</span>
          <span className="block text-xs text-muted-foreground">Due {formatDay(invoice.dueDate)}{invoice.plan ? ` · ${invoice.plan.name}` : ''}</span>
        </span>
        <span className={`text-right text-sm tabular-nums ${isVoid ? 'text-muted-foreground line-through' : ''}`}>
          {formatMoney(invoice.totalPaise)}
          {invoice.status === 'issued' && invoice.paidPaise > 0 && invoice.balancePaise > 0 && (
            <span className="block text-xs text-muted-foreground">{formatMoney(invoice.balancePaise)} left</span>
          )}
        </span>
        <InvoiceStatusBadge invoice={invoice} />
      </button>
      {open && (
        <div className="mt-2 space-y-2 rounded-lg bg-muted/50 p-3 text-sm">
          <ul className="space-y-1">
            {invoice.lines.map((line, index) => (
              <li key={index} className="flex gap-2"><span className="flex-1">{line.label}</span><span className="tabular-nums">{formatMoney(line.amountPaise)}</span></li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            Issued {formatDay(invoice.issueDate)}{invoice.billedTo ? ` · billed to ${invoice.billedTo}` : ''}
            {invoice.paidPaise > 0 && ` · ${formatMoney(invoice.paidPaise)} paid`}
          </p>
          {corrects && <p className="text-xs">Corrects {corrects}</p>}
          {isVoid && <p className="text-xs">Void: {invoice.voidReason}{replacedBy ? ` · replaced by ${replacedBy}` : ''}</p>}
          <div className="flex flex-wrap gap-2">
            <DownloadButton path={invoicePdfPath(invoice)} filename={pdfName(invoice.number)} variant="outline" />
            {canWrite && !isVoid && invoice.paidPaise === 0 && (
              <>
                <Button size="sm" variant="outline" onClick={onCorrect}>Correct</Button>
                <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={onVoid}>Void</Button>
              </>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

function PaymentRow({ payment, canWrite, onReverse, onMove }) {
  const [open, setOpen] = useState(false);
  const reversed = Boolean(payment.reversal);
  return (
    <li className="py-2">
      <button type="button" className="flex w-full items-center gap-2 text-left" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className={`min-w-0 flex-1 ${reversed ? 'text-muted-foreground line-through' : ''}`}>
          <span className="block truncate text-sm font-medium">{payment.receiptNumber}</span>
          <span className="block text-xs text-muted-foreground">{formatDay(payment.receivedOn)} · {PAYMENT_METHOD_LABELS[payment.method]}</span>
        </span>
        <span className={`text-sm tabular-nums ${reversed ? 'text-muted-foreground line-through' : ''}`}>{formatMoney(payment.amountPaise)}</span>
        {reversed && <span className="text-xs font-medium text-destructive">Reversed</span>}
      </button>
      {open && (
        <div className="mt-2 space-y-2 rounded-lg bg-muted/50 p-3 text-sm">
          {payment.allocations.length > 0 && (
            <ul className="space-y-1">
              {payment.allocations.map((item) => (
                <li key={item.invoiceId} className="flex gap-2"><span className="flex-1">{item.invoiceNumber}</span><span className="tabular-nums">{formatMoney(item.amountPaise)}</span></li>
              ))}
            </ul>
          )}
          {payment.unallocatedPaise > 0 && <p className="flex gap-2"><span className="flex-1">Credit</span><span className="tabular-nums">{formatMoney(payment.unallocatedPaise)}</span></p>}
          <p className="text-xs text-muted-foreground">
            {[payment.payerName && `Paid by ${payment.payerName}`, payment.reference && `Ref ${payment.reference}`].filter(Boolean).join(' · ') || 'No reference'}
          </p>
          {payment.note && <p className="text-xs">Note: {payment.note}</p>}
          {reversed && <p className="text-xs">Reversed: {payment.reversal.reason}</p>}
          <div className="flex flex-wrap gap-2">
            <DownloadButton path={receiptPdfPath(payment)} filename={pdfName(payment.receiptNumber)} variant="outline">Receipt PDF</DownloadButton>
            {canWrite && !reversed && (
              <>
                {(payment.allocations.length > 0 || payment.unallocatedPaise > 0) && <Button size="sm" variant="outline" onClick={onMove}>Move money</Button>}
                <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={onReverse}>Reverse</Button>
              </>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

export default function StudentFeesCard({ student, me }) {
  const canWrite = me.capabilities.includes('crm.finance.write');
  const [state, setState] = useState({ status: 'loading', data: null, error: null });
  const [dialog, setDialog] = useState(null);
  const [showVoid, setShowVoid] = useState(false);
  const [params, setParams] = useSearchParams();
  // D9: after conversion or joining a batch, offer (never force) fee set-up.
  const offerSetup = params.get('fees') === 'setup';
  const [setupBatchId] = useState(() => params.get('batch') || null);
  const dismissSetup = () => setParams((current) => { const next = new URLSearchParams(current); next.delete('fees'); next.delete('batch'); return next; }, { replace: true });

  const load = useCallback(async () => {
    try {
      setState({ status: 'ready', data: await crmFetch(`fees/student?${new URLSearchParams({ studentId: student.id })}`), error: null });
    } catch (error) {
      setState({ status: 'error', data: null, error });
    }
  }, [student.id]);

  useEffect(() => { load(); }, [load]);

  const done = () => { setDialog(null); load(); };
  const close = (open) => !open && setDialog(null);

  if (state.status === 'loading') return <Skeleton className="h-48 w-full" />;
  if (state.status === 'error') {
    return <Card><CardHeader><CardTitle className="text-base">Fees</CardTitle></CardHeader><CardContent><Alert variant="destructive"><AlertDescription>{state.error.message}</AlertDescription></Alert></CardContent></Card>;
  }

  const { data } = state;
  const numbers = Object.fromEntries(data.invoices.map((invoice) => [invoice.id, invoice.number]));
  const replacements = Object.fromEntries(data.invoices.filter((invoice) => invoice.replacesInvoiceId).map((invoice) => [invoice.replacesInvoiceId, invoice.number]));
  const voidCount = data.invoices.filter((invoice) => invoice.status === 'void').length;
  const shown = showVoid ? data.invoices : data.invoices.filter((invoice) => invoice.status !== 'void');
  const active = student.status === 'active';
  const futureUnpaid = data.invoices.some((invoice) => invoice.status === 'issued' && invoice.paidPaise === 0 && invoice.dueDate >= data.today);
  const futureCount = data.invoices.filter((invoice) => invoice.status === 'issued' && invoice.paidPaise === 0 && invoice.dueDate >= data.today).length;

  return (
    <Card>
      <CardHeader className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="flex-1 text-base">Fees</CardTitle>
          {canWrite && active && (
            <>
              <Button size="sm" variant="outline" onClick={() => setDialog({ kind: 'add' })}>Add fees</Button>
              <Button size="sm" variant="outline" onClick={() => setDialog({ kind: 'new' })}>New invoice</Button>
            </>
          )}
          {canWrite && <Button size="sm" onClick={() => setDialog({ kind: 'pay' })}>Record payment</Button>}
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Balance due" value={formatMoney(data.summary.balancePaise)} />
          <Stat label="Overdue" value={formatMoney(data.summary.overduePaise)} tone={data.summary.overduePaise ? 'text-destructive' : ''} />
          <Stat label="Credit" value={formatMoney(data.summary.creditPaise)} tone={data.summary.creditPaise ? 'text-success' : ''} />
          <Stat label="Next due" value={data.summary.nextDue ? formatDay(data.summary.nextDue.dueDate) : '—'} />
        </div>
        {data.billedTo && <p className="text-xs text-muted-foreground">Fee payer: {data.billedTo}</p>}
        {(me.capabilities.includes('crm.comms.send') || me.capabilities.includes('crm.comms.read')) && <ReminderStrip me={me} student={data.student} today={data.today} />}
        {canWrite && active && offerSetup && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm">
            <span className="min-w-0 flex-1">{data.invoices.length ? `${data.student.name} already has fees. Add more from a plan?` : `Set up fees for ${data.student.name}?`}</span>
            <Button size="sm" onClick={() => { dismissSetup(); setDialog({ kind: 'add', batchId: setupBatchId }); }}>Set up fees</Button>
            <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={dismissSetup}>Not now</Button>
          </div>
        )}
        {canWrite && !active && futureUnpaid && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-warning-soft bg-warning-soft px-3 py-2 text-sm text-warning-soft-foreground">
            <span className="min-w-0 flex-1">
              {data.student.name} is no longer active but has {futureCount} unpaid invoice{futureCount === 1 ? '' : 's'} due from today. Stop future fees?
            </span>
            <Button size="sm" variant="outline" onClick={() => setDialog({ kind: 'stop' })}>Stop future fees</Button>
          </div>
        )}
        {data.siblings?.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {data.siblings.map((sibling, index) => (
              <span key={sibling.studentId}>
                {index > 0 && ' · '}
                {sibling.guardianName ? `${sibling.guardianName} is also guardian of ` : 'Also guardian of '}
                <Link to={`/crm/students/${sibling.studentId}`} className="font-medium text-foreground hover:underline">{sibling.name}</Link>
                {` (${formatMoney(sibling.balancePaise)} due)`}
              </span>
            ))}
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-2">
        {!data.invoices.length && <p className="text-sm text-muted-foreground">No fees yet.{canWrite && active ? ' Use Add fees to bill this student from a fee plan.' : ''}</p>}
        <ul className="divide-y divide-border">
          {shown.map((invoice) => (
            <InvoiceRow
              key={invoice.id}
              invoice={invoice}
              corrects={invoice.replacesInvoiceId ? numbers[invoice.replacesInvoiceId] : null}
              replacedBy={replacements[invoice.id]}
              canWrite={canWrite}
              onCorrect={() => setDialog({ kind: 'correct', invoice })}
              onVoid={() => setDialog({ kind: 'void', invoice })}
            />
          ))}
        </ul>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {voidCount > 0 && (
            <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setShowVoid((value) => !value)}>
              {showVoid ? 'Hide void invoices' : `Show ${voidCount} void invoice${voidCount === 1 ? '' : 's'}`}
            </Button>
          )}
          {canWrite && futureUnpaid && (
            <Button size="sm" variant="ghost" className="ml-auto text-muted-foreground" onClick={() => setDialog({ kind: 'stop' })}>Stop future fees</Button>
          )}
        </div>
      </CardContent>

      {data.payments.length > 0 && (
        <CardContent className="space-y-1 border-t border-border pt-4">
          <p className="text-sm font-medium">Payments <span className="font-normal text-muted-foreground">· {formatMoney(data.summary.paidPaise)} on invoices</span></p>
          <ul className="divide-y divide-border">
            {data.payments.map((payment) => (
              <PaymentRow
                key={payment.id}
                payment={payment}
                canWrite={canWrite}
                onReverse={() => setDialog({ kind: 'reverse', payment })}
                onMove={() => setDialog({ kind: 'move', payment })}
              />
            ))}
          </ul>
        </CardContent>
      )}

      <RecordPaymentDialog open={dialog?.kind === 'pay'} onOpenChange={close} studentId={data.student.id} onSaved={done} />
      <ReversePaymentDialog open={dialog?.kind === 'reverse'} onOpenChange={close} payment={dialog?.payment} onSaved={done} />
      <MoveAllocationDialog open={dialog?.kind === 'move'} onOpenChange={close} payment={dialog?.payment} invoices={data.invoices} onSaved={done} />
      <AddFeesDialog open={dialog?.kind === 'add'} onOpenChange={close} student={data.student} courseIds={data.courseIds} batchId={dialog?.batchId} onSaved={done} />
      <InvoiceDialog
        open={dialog?.kind === 'new' || dialog?.kind === 'correct'}
        onOpenChange={close}
        student={data.student}
        invoice={dialog?.kind === 'correct' ? dialog.invoice : null}
        today={data.today}
        onSaved={done}
      />
      <VoidInvoiceDialog open={dialog?.kind === 'void'} onOpenChange={close} invoice={dialog?.invoice} onSaved={done} />
      <StopFutureDialog open={dialog?.kind === 'stop'} onOpenChange={close} student={data.student} invoices={data.invoices} today={data.today} onSaved={done} />
    </Card>
  );
}
