// Fees → Dues (CRM-018, CRM M2 phase 1 S2, D8): every unpaid or partly paid
// invoice in the school, overdue first, with outstanding and overdue totals.
import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Alert, AlertDescription } from '../../ui/Alert';
import { Card, CardContent } from '../../ui/Card';
import { Select } from '../../ui/Select';
import { Skeleton } from '../../ui/Skeleton';
import { crmFetch } from '../../../lib/crm/api';
import { formatDay } from '../../../lib/crm/classes';
import { DUES_FILTERS, DUES_FILTER_LABELS, formatMoney } from '../../../../shared/crm/fees.js';
import { Segmented } from '../tasks/TasksPage';
import { DownloadButton, InvoiceStatusBadge, invoicePdfPath, pdfName } from './feeUi';

function Total({ label, value, note, tone }) {
  return (
    <Card>
      <CardContent className="space-y-1 p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className={`text-2xl font-semibold tabular-nums ${tone || ''}`}>{value}</p>
        {note && <p className="text-xs text-muted-foreground">{note}</p>}
      </CardContent>
    </Card>
  );
}

export default function DuesTab({ me, renderAction }) {
  const canSeeClasses = me.capabilities.includes('crm.classes.read');
  const [params, setParams] = useSearchParams();
  const filter = DUES_FILTERS.includes(params.get('due')) ? params.get('due') : 'all';
  const batchId = params.get('batch') || '';
  const courseId = params.get('course') || '';
  const [state, setState] = useState({ status: 'loading', data: null, error: null });
  const [options, setOptions] = useState({ batches: [], courses: [] });

  const setParam = (key, value, fallback = '') => setParams((current) => {
    const next = new URLSearchParams(current);
    if (value && value !== fallback) next.set(key, value); else next.delete(key);
    return next;
  }, { replace: true });

  const load = useCallback(async () => {
    try {
      const query = new URLSearchParams({ filter, ...(batchId ? { batchId } : {}), ...(courseId ? { courseId } : {}) });
      setState({ status: 'ready', data: await crmFetch(`fees/dues?${query}`), error: null });
    } catch (error) {
      setState({ status: 'error', data: null, error });
    }
  }, [filter, batchId, courseId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!canSeeClasses) return;
    Promise.all([crmFetch('classes/batches?status=active'), crmFetch('classes/courses?status=active')])
      .then(([batches, courses]) => setOptions({ batches: batches.items, courses: courses.items }))
      .catch(() => undefined);
  }, [canSeeClasses]);

  const data = state.data;
  return (
    <div className="space-y-4">
      {data && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Total label="Outstanding" value={formatMoney(data.totals.outstandingPaise)} note={batchId || courseId ? 'For this batch or course' : 'Across the school'} />
          <Total
            label="Overdue"
            value={formatMoney(data.totals.overduePaise)}
            tone={data.totals.overduePaise ? 'text-destructive' : ''}
            note={`${data.totals.overdueStudents} student${data.totals.overdueStudents === 1 ? '' : 's'}`}
          />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Segmented label="Which dues" options={DUES_FILTERS.map((key) => [key, DUES_FILTER_LABELS[key]])} value={filter} onChange={(value) => setParam('due', value, 'all')} />
        {canSeeClasses && (
          <>
            <Select aria-label="Batch" className="h-9 w-auto" value={batchId} onChange={(event) => setParam('batch', event.target.value)}>
              <option value="">All batches</option>
              {options.batches.map((batch) => <option key={batch.id} value={batch.id}>{batch.name}</option>)}
            </Select>
            <Select aria-label="Course" className="h-9 w-auto" value={courseId} onChange={(event) => setParam('course', event.target.value)}>
              <option value="">All courses</option>
              {options.courses.map((course) => <option key={course.id} value={course.id}>{course.name}</option>)}
            </Select>
          </>
        )}
      </div>
      {state.status === 'loading' && <Skeleton className="h-48 w-full" />}
      {state.status === 'error' && <Alert variant="destructive"><AlertDescription>{state.error.message}</AlertDescription></Alert>}
      {data && !data.items.length && (
        <p className="text-sm text-muted-foreground">
          {filter === 'overdue' ? 'Nothing is overdue.' : filter === 'week' ? 'Nothing falls due in the next 7 days.' : 'No unpaid fees. Fees appear here once they are added to students.'}
        </p>
      )}
      {data?.items.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="border-b border-border text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Student</th>
                <th className="px-4 py-2 font-medium">Invoice</th>
                <th className="px-4 py-2 font-medium">Due</th>
                <th className="px-4 py-2 text-right font-medium">Balance</th>
                <th className="px-4 py-2 font-medium">Status</th>
                {renderAction && <th className="px-4 py-2"><span className="sr-only">Actions</span></th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.items.map((invoice) => (
                <tr key={invoice.id}>
                  <td className="px-4 py-2">
                    <Link to={`/crm/students/${invoice.student.id}`} className="font-medium hover:underline">{invoice.student.name}</Link>
                    {invoice.billedTo && <span className="block text-xs text-muted-foreground">{invoice.billedTo}</span>}
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      {invoice.number}
                      <DownloadButton path={invoicePdfPath(invoice)} filename={pdfName(invoice.number)} className="h-7 w-7 p-0" iconOnly>Download PDF</DownloadButton>
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-2">{formatDay(invoice.dueDate)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {formatMoney(invoice.balancePaise)}
                    {invoice.paidPaise > 0 && <span className="block text-xs text-muted-foreground">of {formatMoney(invoice.totalPaise)}</span>}
                  </td>
                  <td className="px-4 py-2"><InvoiceStatusBadge invoice={invoice} /></td>
                  {renderAction && <td className="px-4 py-2 text-right">{renderAction(invoice, load)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data?.truncated && <p className="text-xs text-muted-foreground">Showing the first 500. Narrow by batch or course to see the rest.</p>}
    </div>
  );
}
