// Open tasks for one lead or student, with "Add task" pinned to it (D13).
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '../../ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/Card';
import { Skeleton } from '../../ui/Skeleton';
import { NewTaskDialog } from '../tasks/TaskDialogs';
import TaskList from '../tasks/TaskList';
import { useAssignees, useTasks } from '../tasks/useTasks';

export default function RecordTasks({ entityType, entityId, label, me }) {
  const canWrite = me.capabilities.includes('crm.tasks.write');
  const [creating, setCreating] = useState(false);
  const list = useTasks({ view: 'all', status: 'open', relatedType: entityType, relatedId: entityId });
  const assignees = useAssignees(canWrite);
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">Open tasks</CardTitle>
        {canWrite && (
          <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
            <Plus className="mr-1 h-4 w-4" aria-hidden="true" />Add task
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {list.status === 'loading'
          ? <Skeleton className="h-16 w-full" />
          : <TaskList tasks={list.tasks} me={me} assignees={assignees} showOwner={me.taskScope === 'school'} showRelated={false} emptyText={`No open tasks for this ${entityType}.`} />}
      </CardContent>
      {canWrite && (
        <NewTaskDialog
          open={creating}
          onOpenChange={setCreating}
          me={me}
          assignees={assignees}
          related={{ type: entityType, id: entityId }}
          relatedLabel={label}
          onCreated={() => setCreating(false)}
        />
      )}
    </Card>
  );
}
