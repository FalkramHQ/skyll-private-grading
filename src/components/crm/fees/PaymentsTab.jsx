// Fees → Payments (CRM-018, CRM M2 phase 1 S3, D8): payments by date received
// and method, with today's collection split by method. Reversed payments are
// struck through and left out of the totals.
import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Alert, AlertDescription } from '../../ui/Alert';
import { Card, CardContent } from '../../ui/Card';
import { Input } from '../../ui/Input';
import { Select } from '../../ui/Select';
import { Skeleton } from '../../ui/Skeleton';
import { crmFetch } from '../../../lib/crm/api';
import { formatDay } from '../../../lib/crm/classes';
import { PAYMENT_METHODS, PAYMENT_METHOD_LABELS, formatMoney } from '../../../../shared/crm/fees.js';
import { DownloadButton, pdfName, receiptPdfPath } from './feeUi';

function TodayCard({ totals }) {
  const methods = PAYMENT_METHODS.filter((method) => totals.byMethod[method] > 0);
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-baseline gap-2">
          <p className="text-xs text-muted-foreground">Collected today</p>
          <p className="ml-auto text-xs text-muted-foreground">{totals.count} payment{totals.count === 1 ? '' : 's'}</p>
        </div>
        <p className="text-2xl font-semibold tabular-nums">{formatMoney(totals.totalPaise)}</p>
        {methods.length > 0 && (
          <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
            {methods.map((method) => (
              <div key={method} className="flex gap-2">
                <dt className="text-muted-foreground">{PAYMENT_METHOD_LABELS[method]}</dt>
                <dd className="tabular-nums">{formatMoney(totals.byMethod[method])}</dd>
              </div>
            ))}
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

export default function PaymentsTab() {
  const [params, setParams] = useSearchParams();
  const from = params.get('from') || '';
  const to = params.get('to') || '';
  const method = PAYMENT_METHODS.includes(params.get('method')) ? params.get('method') : '';
  const [state, setState] = useState({ status: 'loading', data: null, error: null });

  const setParam = (key, value) => setParams((current) => {
    const next = new URLSearchParams(current);
    if (value) next.set(key, value); else next.delete(key);
    return next;
  }, { replace: true });

  const load = useCallback(async () => {
    try {
      const query = new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}), ...(method ? { method } : {}) });
      setState({ status: 'ready', data: await crmFetch(`fees/payments?${query}`), error: null });
    } catch (error) {
      setState({ status: 'error', data: null, error });
    }
  }, [from, to, method]);

  useEffect(() => { load(); }, [load]);

  const data = state.data;
  return (
    <div className="space-y-4">
      {data && (
        <div className="grid gap-4 sm:grid-cols-2">
          <TodayCard totals={data.todayTotals} />
          <Card>
            <CardContent className="space-y-1 p-4">
              <p className="text-xs text-muted-foreground">{formatDay(data.from)} – {formatDay(data.to)}{method ? ` · ${PAYMENT_METHOD_LABELS[method]}` : ''}</p>
              <p className="text-2xl font-semibold tabular-nums">{formatMoney(data.totals.totalPaise)}</p>
              <p className="text-xs text-muted-foreground">{data.totals.count} payment{data.totals.count === 1 ? '' : 's'}, not counting reversed ones</p>
            </CardContent>
          </Card>
        </div>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <label className="space-y-1 text-xs text-muted-foreground" htmlFor="payments-from">
          <span className="block">From</span>
          <Input id="payments-from" type="date" className="h-9 w-40" value={from || data?.from || ''} onChange={(event) => setParam('from', event.target.value)} />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground" htmlFor="payments-to">
          <span className="block">To</span>
          <Input id="payments-to" type="date" className="h-9 w-40" value={to || data?.to || ''} onChange={(event) => setParam('to', event.target.value)} />
        </label>
        <Select aria-label="Method" className="h-9 w-auto" value={method} onChange={(event) => setParam('method', event.target.value)}>
          <option value="">All methods</option>
          {PAYMENT_METHODS.map((key) => <option key={key} value={key}>{PAYMENT_METHOD_LABELS[key]}</option>)}
        </Select>
      </div>
      {state.status === 'loading' && <Skeleton className="h-48 w-full" />}
      {state.status === 'error' && <Alert variant="destructive"><AlertDescription>{state.error.message}</AlertDescription></Alert>}
      {data && !data.items.length && <p className="text-sm text-muted-foreground">No payments in this period.</p>}
      {data?.items.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="border-b border-border text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Received</th>
                <th className="px-4 py-2 font-medium">Receipt</th>
                <th className="px-4 py-2 font-medium">Student</th>
                <th className="px-4 py-2 font-medium">Method</th>
                <th className="px-4 py-2 font-medium">Reference</th>
                <th className="px-4 py-2 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.items.map((payment) => {
                const struck = payment.reversal ? 'text-muted-foreground line-through' : '';
                return (
                  <tr key={payment.id} title={payment.reversal ? `Reversed: ${payment.reversal.reason}` : undefined}>
                    <td className={`whitespace-nowrap px-4 py-2 ${struck}`}>{formatDay(payment.receivedOn)}</td>
                    <td className="px-4 py-2">
                      <span className="inline-flex items-center gap-1">
                        <span className={struck}>{payment.receiptNumber}</span>
                        <DownloadButton path={receiptPdfPath(payment)} filename={pdfName(payment.receiptNumber)} className="h-7 w-7 p-0" iconOnly>Download receipt</DownloadButton>
                      </span>
                      {payment.reversal && <span className="block text-xs text-destructive">Reversed</span>}
                    </td>
                    <td className="px-4 py-2"><Link to={`/crm/students/${payment.student.id}`} className="hover:underline">{payment.student.name}</Link></td>
                    <td className={`px-4 py-2 ${struck}`}>{PAYMENT_METHOD_LABELS[payment.method]}</td>
                    <td className={`px-4 py-2 text-muted-foreground ${struck}`}>{payment.reference || '—'}</td>
                    <td className={`px-4 py-2 text-right tabular-nums ${struck}`}>{formatMoney(payment.amountPaise)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {data?.truncated && <p className="text-xs text-muted-foreground">Showing the latest 500. Narrow the dates to see the rest.</p>}
    </div>
  );
}
