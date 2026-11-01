// Classes → Batches (FLKRM-327 S1): every canonical batch of the school, with
// its course, year, class, student count and dates.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { Alert, AlertDescription } from '../../ui/Alert';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Select } from '../../ui/Select';
import { Skeleton } from '../../ui/Skeleton';
import { crmFetch } from '../../../lib/crm/api';
import { dateRange } from '../../../lib/crm/classes';
import { Segmented } from '../tasks/TasksPage';
import { BatchDialog } from './ClassDialogs';

export function StudentCount({ batch }) {
  const over = batch.capacity && batch.studentCount > batch.capacity;
  return (
    <span className={over ? 'font-medium text-warning-soft-foreground' : undefined}>
      {batch.studentCount}{batch.capacity ? ` / ${batch.capacity}` : ''}
      {over && <span className="sr-only"> (over capacity)</span>}
    </span>
  );
}

export default function BatchesTab({ me, options, onOptionsChanged }) {
  const canWrite = me.capabilities.includes('crm.classes.write');
  const [status, setStatus] = useState('active');
  const [courseId, setCourseId] = useState('');
  const [state, setState] = useState({ status: 'loading', items: [], error: null });
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ status });
    if (courseId) params.set('courseId', courseId);
    try {
      const page = await crmFetch(`classes/batches?${params}`);
      setState({ status: 'ready', items: page.items, error: null });
    } catch (error) {
      setState({ status: 'error', items: [], error });
    }
  }, [status, courseId]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented label="Batch status" options={[['active', 'Active'], ['archived', 'Archived']]} value={status} onChange={setStatus} />
        <Select aria-label="Filter by course" className="w-auto min-w-[12rem]" value={courseId} onChange={(event) => setCourseId(event.target.value)}>
          <option value="">All courses</option>
          {(options?.courses || []).map((course) => <option key={course.id} value={course.id}>{course.name}</option>)}
        </Select>
        {canWrite && (
          <Button className="ml-auto" onClick={() => setCreating(true)}>
            <Plus className="mr-1 h-4 w-4" aria-hidden="true" />New batch
          </Button>
        )}
      </div>

      {state.status === 'loading' && <Skeleton className="h-48 w-full" />}
      {state.status === 'error' && <Alert variant="destructive"><AlertDescription>{state.error.message}</AlertDescription></Alert>}
      {state.status === 'ready' && !state.items.length && (
        <p className="text-sm text-muted-foreground">{status === 'active' ? 'No active batches yet.' : 'No archived batches.'}</p>
      )}
      {state.status === 'ready' && state.items.length > 0 && (
        <Card className="sm:hidden">
          <ul className="divide-y divide-border text-sm">
            {state.items.map((batch) => (
              <li key={batch.id} className="space-y-1 p-3">
                <Link to={`/crm/classes/batches/${batch.id}`} className="font-medium hover:underline">{batch.name}</Link>
                <p className="text-xs text-muted-foreground">
                  {[batch.course?.name, batch.academicYear?.label, batch.grade && `Class ${batch.grade}`, batch.lead && `Lead: ${batch.lead.name}`].filter(Boolean).join(' · ') || 'No course'}
                </p>
                <p className="text-xs">
                  <StudentCount batch={batch} /> {batch.studentCount === 1 && !batch.capacity ? 'student' : 'students'}
                  {dateRange(batch.startsOn, batch.endsOn) && <span className="text-muted-foreground"> · {dateRange(batch.startsOn, batch.endsOn)}</span>}
                </p>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {state.status === 'ready' && state.items.length > 0 && (
        <Card className="hidden overflow-x-auto sm:block">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="p-3 font-medium">Batch</th>
                <th className="p-3 font-medium">Course</th>
                <th className="p-3 font-medium">Lead</th>
                <th className="p-3 font-medium">Year</th>
                <th className="p-3 font-medium">Class</th>
                <th className="p-3 font-medium">Students</th>
                <th className="p-3 font-medium">Runs</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {state.items.map((batch) => (
                <tr key={batch.id}>
                  <td className="p-3">
                    <Link to={`/crm/classes/batches/${batch.id}`} className="font-medium hover:underline">{batch.name}</Link>
                    {batch.subject && <div className="text-xs text-muted-foreground">{batch.subject.name}</div>}
                  </td>
                  <td className="p-3">{batch.course ? batch.course.name : <span className="text-muted-foreground">—</span>}</td>
                  <td className="p-3">{batch.lead ? batch.lead.name : <span className="text-muted-foreground">—</span>}</td>
                  <td className="p-3 text-muted-foreground">{batch.academicYear?.label || '—'}</td>
                  <td className="p-3 text-muted-foreground">{batch.grade || '—'}</td>
                  <td className="p-3 tabular-nums"><StudentCount batch={batch} /></td>
                  <td className="p-3 text-muted-foreground">
                    {dateRange(batch.startsOn, batch.endsOn) || '—'}
                    {batch.status !== 'active' && <Badge variant="secondary" className="ml-2">Archived</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <BatchDialog
        open={creating}
        onOpenChange={setCreating}
        options={options}
        onSaved={() => { setCreating(false); load(); onOptionsChanged?.(); }}
      />
    </div>
  );
}
