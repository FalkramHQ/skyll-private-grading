// Fees → Fee plans (CRM-017, CRM M2 phase 1 S1, D3): the school's reusable
// fee templates. Archiving hides a plan from new students only.
import { useCallback, useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { Alert, AlertDescription } from '../../ui/Alert';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/Card';
import { Skeleton } from '../../ui/Skeleton';
import { crmFetch } from '../../../lib/crm/api';
import { classesWrite } from '../../../lib/crm/classes';
import { PLAN_KIND_LABELS, formatMoney } from '../../../../shared/crm/fees.js';
import { Segmented } from '../tasks/TasksPage';
import { FeePlanDialog, offsetLabel } from './FeePlanDialog';

function PlanCard({ plan, canWrite, onEdit, onChanged, onError }) {
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    setBusy(true);
    onError(null);
    try {
      await classesWrite(plan.status === 'active' ? 'fees/plans/archive' : 'fees/plans/restore', { planId: plan.id, expectedVersion: plan.version });
      onChanged();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader className="space-y-2">
        <div className="flex flex-wrap items-start gap-2">
          <CardTitle className="min-w-0 flex-1 text-base">{plan.name}</CardTitle>
          <Badge variant="secondary">{PLAN_KIND_LABELS[plan.kind]}</Badge>
          {plan.status === 'archived' && <Badge variant="warning">Archived</Badge>}
        </div>
        <p className="text-sm text-muted-foreground">
          {[plan.course && `Course: ${plan.course.name}`, `${formatMoney(plan.totalPaise)} in total`].filter(Boolean).join(' · ')}
        </p>
        {plan.description && <p className="text-sm">{plan.description}</p>}
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <ul className="space-y-1">
          {plan.items.map((item) => (
            <li key={item.id} className="flex gap-2">
              <span className="min-w-0 flex-1">{item.label}</span>
              <span className="text-muted-foreground">{offsetLabel(item.dueOffsetValue, item.dueOffsetUnit)}</span>
              <span className="w-24 text-right tabular-nums">{formatMoney(item.amountPaise)}</span>
            </li>
          ))}
          {plan.monthly && (
            <li className="flex gap-2">
              <span className="min-w-0 flex-1">Tuition × {plan.monthly.count} months</span>
              <span className="text-muted-foreground">due on day {plan.monthly.dueDay}</span>
              <span className="w-24 text-right tabular-nums">{formatMoney(plan.monthly.amountPaise)}/mo</span>
            </li>
          )}
        </ul>
        {canWrite && (
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={onEdit} disabled={busy}>Edit</Button>
            <Button size="sm" variant="ghost" className="ml-auto text-muted-foreground" disabled={busy} onClick={toggle}>
              {plan.status === 'active' ? 'Archive' : 'Restore'}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function FeePlansTab({ me, today }) {
  const canWrite = me.capabilities.includes('crm.finance.write');
  const canSeeCourses = me.capabilities.includes('crm.classes.read');
  const [status, setStatus] = useState('active');
  const [state, setState] = useState({ status: 'loading', items: [], error: null });
  const [courses, setCourses] = useState(null);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const plans = await crmFetch(`fees/plans?${new URLSearchParams({ status })}`);
      setState({ status: 'ready', items: plans.items, error: null });
    } catch (err) {
      setState({ status: 'error', items: [], error: err });
    }
  }, [status]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!canWrite || !canSeeCourses) return;
    crmFetch('classes/courses?status=active').then((result) => setCourses(result.items)).catch(() => setCourses(null));
  }, [canWrite, canSeeCourses]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented label="Plan status" options={[['active', 'Active'], ['archived', 'Archived']]} value={status} onChange={setStatus} />
        {canWrite && (
          <Button className="ml-auto" onClick={() => setEditing('new')}>
            <Plus className="mr-1 h-4 w-4" aria-hidden="true" />New fee plan
          </Button>
        )}
      </div>
      {error && <Alert variant="destructive"><AlertDescription>{error.code === 'version_conflict' ? 'Someone else changed this meanwhile. The latest version is shown; try again.' : error.message}</AlertDescription></Alert>}
      {state.status === 'loading' && <Skeleton className="h-48 w-full" />}
      {state.status === 'error' && <Alert variant="destructive"><AlertDescription>{state.error.message}</AlertDescription></Alert>}
      {state.status === 'ready' && !state.items.length && (
        <p className="text-sm text-muted-foreground">
          {status === 'active'
            ? 'No fee plans yet. A plan lists what a student pays and when, for example an admission fee plus three instalments.'
            : 'No archived plans.'}
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        {state.items.map((plan) => (
          <PlanCard
            key={plan.id}
            plan={plan}
            canWrite={canWrite}
            onEdit={() => setEditing(plan)}
            onChanged={load}
            onError={(err) => { setError(err); if (err) load(); }}
          />
        ))}
      </div>
      <FeePlanDialog
        open={Boolean(editing)}
        onOpenChange={(open) => !open && setEditing(null)}
        plan={editing === 'new' ? null : editing}
        courses={courses}
        today={today}
        onSaved={() => { setEditing(null); load(); }}
      />
    </div>
  );
}
