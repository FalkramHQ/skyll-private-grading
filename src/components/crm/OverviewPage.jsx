// CRM Overview (FLKRM-326 S2, FLKRM-327 S3): today's classes, the follow-up
// queue — overdue, due today and the next seven days — plus team counts for
// people who see every task.
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { Badge } from '../ui/Badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/Card';
import { Skeleton } from '../ui/Skeleton';
import { cn } from '../../lib/utils';
import { useNow, useTaskSummary } from '../../lib/crm/tasks';
import TodaysClasses from './classes/TodaysClasses';
import TaskList from './tasks/TaskList';
import { BUCKETS, groupByBucket } from './tasks/TasksPage';
import { useAssignees, useTasks } from './tasks/useTasks';

const PER_COLUMN = 5;
const UPCOMING_DAYS = 7;

function Stat({ label, value, tone }) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn('text-2xl font-semibold tabular-nums', tone === 'bad' && value > 0 && 'text-destructive', tone === 'warn' && value > 0 && 'text-warning-soft-foreground')}>{value}</p>
    </div>
  );
}

function TeamStrip({ summary }) {
  if (!summary?.all) return null;
  const { overdue, today, upcoming, unassigned } = summary.all;
  return (
    <section aria-label="Team tasks" className="space-y-2">
      <h2 className="text-sm font-semibold text-foreground">Whole team</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Overdue" value={overdue} tone="bad" />
        <Stat label="Due today" value={today} />
        <Stat label="Upcoming" value={upcoming} />
        <Stat label="Unassigned" value={unassigned} tone="warn" />
      </div>
    </section>
  );
}

function MyQueue({ me }) {
  const now = useNow();
  const list = useTasks({ view: 'mine', status: 'open' });
  const assignees = useAssignees(me.capabilities.includes('crm.tasks.write'));
  if (list.status === 'loading') return <Skeleton className="h-48 w-full" />;
  const groups = groupByBucket(list.tasks, me.school.timezone, now);
  const horizon = now + UPCOMING_DAYS * 86_400_000;
  groups.upcoming = groups.upcoming.filter((task) => Date.parse(task.dueAt) < horizon);
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {BUCKETS.map((bucket) => {
        const tasks = groups[bucket.key];
        return (
          <Card key={bucket.key}>
            <CardHeader className="flex-row items-center gap-2 space-y-0 pb-1">
              <CardTitle className={cn('text-base', bucket.key === 'overdue' && tasks.length && 'text-destructive')}>
                {bucket.key === 'upcoming' ? `Next ${UPCOMING_DAYS} days` : bucket.label}
              </CardTitle>
              <Badge variant={bucket.key === 'overdue' && tasks.length ? 'destructive' : 'secondary'}>{tasks.length}</Badge>
            </CardHeader>
            <CardContent>
              <TaskList tasks={tasks.slice(0, PER_COLUMN)} me={me} assignees={assignees} emptyText={bucket.empty} />
              {tasks.length > PER_COLUMN && (
                <Link to="/crm/tasks" className="text-xs text-accent hover:underline">{tasks.length - PER_COLUMN} more</Link>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

export default function OverviewPage({ me }) {
  const hasTasks = me.capabilities.includes('crm.tasks.read');
  const hasClasses = me.capabilities.includes('crm.classes.read');
  const summary = useTaskSummary(hasTasks);
  if (!hasTasks) {
    return (
      <div className="space-y-6">
        {hasClasses && <TodaysClasses me={me} />}
        {!hasClasses && (
          <Card className="max-w-2xl">
            <CardHeader>
              <CardTitle>Welcome</CardTitle>
              <CardDescription>Use the sections on the left. Admissions, fees and attendance summaries will appear here.</CardDescription>
            </CardHeader>
          </Card>
        )}
      </div>
    );
  }
  return (
    <div className="space-y-6">
      {hasClasses && <TodaysClasses me={me} />}
      <section aria-label="My follow-ups" className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-foreground">My follow-ups</h2>
          <Link to="/crm/tasks" className="inline-flex items-center gap-1 text-sm text-accent hover:underline">
            All tasks<ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </div>
        <MyQueue me={me} />
      </section>
      <TeamStrip summary={summary} />
    </div>
  );
}
