// Tasks section (CRM-012, FLKRM-326 S2): open tasks grouped Overdue / Today /
// Upcoming in school time, plus Done and Cancelled. "Everyone" appears only for
// people who see the whole school's tasks (D11).
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Alert, AlertDescription } from '../../ui/Alert';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/Card';
import { Skeleton } from '../../ui/Skeleton';
import { cn } from '../../../lib/utils';
import { useNow } from '../../../lib/crm/tasks';
import { taskBucket } from '../../../../shared/crm/time.js';
import { NewTaskDialog } from './TaskDialogs';
import TaskList from './TaskList';
import { useAssignees, useTasks } from './useTasks';

export const BUCKETS = [
  { key: 'overdue', label: 'Overdue', empty: 'Nothing overdue.' },
  { key: 'today', label: 'Today', empty: 'Nothing else due today.' },
  { key: 'upcoming', label: 'Upcoming', empty: 'Nothing coming up.' },
];

export function groupByBucket(tasks, timezone, now) {
  const groups = { overdue: [], today: [], upcoming: [] };
  for (const task of tasks) groups[taskBucket(task.dueAt, now, timezone)].push(task);
  return groups;
}

/** A small segmented control; the selected option uses the primary style. */
export function Segmented({ label, options, value, onChange }) {
  return (
    <div className="flex rounded-lg border border-border p-0.5" role="group" aria-label={label}>
      {options.map(([key, text]) => (
        <Button
          key={key}
          size="sm"
          variant={value === key ? 'default' : 'ghost'}
          className={value === key ? 'shadow-sm' : 'text-muted-foreground'}
          aria-pressed={value === key}
          onClick={() => onChange(key)}
        >
          {text}
        </Button>
      ))}
    </div>
  );
}

export default function TasksPage({ me }) {
  const canWrite = me.capabilities.includes('crm.tasks.write');
  const schoolWide = me.taskScope === 'school';
  const now = useNow();
  const [view, setView] = useState('mine');
  const [status, setStatus] = useState('open');
  const [creating, setCreating] = useState(false);
  const list = useTasks({ view, status });
  const assignees = useAssignees(canWrite);
  const listProps = { me, assignees, showOwner: view === 'all' };

  let body;
  if (list.status === 'loading') body = <Skeleton className="h-64 w-full" />;
  else if (list.status === 'error' && !list.tasks.length) body = <Alert variant="destructive"><AlertDescription>{list.error.message}</AlertDescription></Alert>;
  else if (status === 'open') {
    const groups = groupByBucket(list.tasks, me.school.timezone, now);
    body = (
      <div className="space-y-4">
        {BUCKETS.map((bucket) => (
          <Card key={bucket.key}>
            <CardHeader className="flex-row items-center gap-2 space-y-0 pb-2">
              <CardTitle className={cn('text-base', bucket.key === 'overdue' && groups.overdue.length && 'text-destructive')}>{bucket.label}</CardTitle>
              <Badge variant={bucket.key === 'overdue' && groups.overdue.length ? 'destructive' : 'secondary'}>{groups[bucket.key].length}</Badge>
            </CardHeader>
            <CardContent><TaskList tasks={groups[bucket.key]} emptyText={bucket.empty} {...listProps} /></CardContent>
          </Card>
        ))}
      </div>
    );
  } else {
    body = (
      <Card>
        <CardContent className="pt-4">
          <TaskList tasks={list.tasks} emptyText={status === 'done' ? 'No completed tasks.' : 'No cancelled tasks.'} {...listProps} />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {schoolWide && <Segmented label="Whose tasks" options={[['mine', 'Mine'], ['all', 'Everyone']]} value={view} onChange={setView} />}
        <Segmented label="Status" options={[['open', 'Open'], ['done', 'Done'], ['cancelled', 'Cancelled']]} value={status} onChange={setStatus} />
        {canWrite && (
          <Button className="ml-auto" onClick={() => setCreating(true)}>
            <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" />New task
          </Button>
        )}
      </div>
      {list.truncated && <p className="text-xs text-muted-foreground">Showing the first 200 tasks.</p>}
      {body}
      {canWrite && <NewTaskDialog open={creating} onOpenChange={setCreating} me={me} assignees={assignees} onCreated={() => setCreating(false)} />}
    </div>
  );
}
