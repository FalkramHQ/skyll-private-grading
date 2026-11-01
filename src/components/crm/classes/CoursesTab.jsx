// Classes → Courses (FLKRM-327 S1, D1/D13): the catalogue, each course with
// the batches that run it. Linking a batch here only sets its course.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { Alert, AlertDescription } from '../../ui/Alert';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/Card';
import { Select } from '../../ui/Select';
import { Skeleton } from '../../ui/Skeleton';
import { crmFetch } from '../../../lib/crm/api';
import { classesWrite } from '../../../lib/crm/classes';
import { DELIVERY_MODE_LABELS } from '../../../../shared/crm/classes.js';
import { Segmented } from '../tasks/TasksPage';
import { BatchDialog, CourseDialog } from './ClassDialogs';

function durationLabel(duration) {
  if (!duration) return null;
  const unit = duration.value === 1 ? duration.unit.replace(/s$/, '') : duration.unit;
  return `${duration.value} ${unit}`;
}

function CourseCard({ course, canWrite, unlinked, onEdit, onNewBatch, onChanged, onError }) {
  const [busy, setBusy] = useState(false);
  const meta = [course.subject?.name, course.level, durationLabel(course.duration), course.academicYear?.label].filter(Boolean);

  const run = async (path, body) => {
    setBusy(true);
    onError(null);
    try {
      await classesWrite(path, body);
      onChanged();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };

  const link = (event) => {
    const batch = unlinked.find((item) => item.id === event.target.value);
    if (batch) run('classes/batches/course', { batchId: batch.id, courseId: course.id, expectedVersion: batch.version });
  };

  return (
    <Card>
      <CardHeader className="space-y-2">
        <div className="flex flex-wrap items-start gap-2">
          <CardTitle className="min-w-0 flex-1 text-base">{course.name}</CardTitle>
          {course.program && <Badge variant="outline">{course.program}</Badge>}
          <Badge variant="secondary">{DELIVERY_MODE_LABELS[course.deliveryMode]}</Badge>
          {course.status === 'archived' && <Badge variant="warning">Archived</Badge>}
        </div>
        {meta.length > 0 && <p className="text-sm text-muted-foreground">{meta.join(' · ')}</p>}
        {course.description && <p className="text-sm">{course.description}</p>}
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div>
          <p className="mb-1 text-xs text-muted-foreground">Batches</p>
          {course.batches.length
            ? (
              <ul className="space-y-1">
                {course.batches.map((batch) => (
                  <li key={batch.id} className="flex items-center gap-2">
                    <Link to={`/crm/classes/batches/${batch.id}`} className="hover:underline">{batch.name}</Link>
                    <span className="text-xs text-muted-foreground">{batch.studentCount} student{batch.studentCount === 1 ? '' : 's'}</span>
                    {batch.status !== 'active' && <Badge variant="secondary">Archived</Badge>}
                  </li>
                ))}
              </ul>
            )
            : <p className="text-muted-foreground">No batches yet.</p>}
        </div>
        {canWrite && (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={onEdit} disabled={busy}>Edit</Button>
            {course.status === 'active' && <Button size="sm" variant="outline" onClick={onNewBatch} disabled={busy}>New batch</Button>}
            {course.status === 'active' && unlinked.length > 0 && (
              <Select aria-label={`Link a batch to ${course.name}`} className="h-8 w-auto text-xs" value="" onChange={link} disabled={busy}>
                <option value="">Link a batch…</option>
                {unlinked.map((batch) => <option key={batch.id} value={batch.id}>{batch.name}</option>)}
              </Select>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto text-muted-foreground"
              disabled={busy}
              onClick={() => run(course.status === 'active' ? 'classes/courses/archive' : 'classes/courses/restore', { courseId: course.id, expectedVersion: course.version })}
            >
              {course.status === 'active' ? 'Archive' : 'Restore'}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function CoursesTab({ me, options, onOptionsChanged }) {
  const canWrite = me.capabilities.includes('crm.classes.write');
  const [status, setStatus] = useState('active');
  const [state, setState] = useState({ status: 'loading', items: [], batches: [], error: null });
  const [editing, setEditing] = useState(null);
  const [newBatchFor, setNewBatchFor] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const [courses, batches] = await Promise.all([
        crmFetch(`classes/courses?${new URLSearchParams({ status })}`),
        crmFetch('classes/batches?status=active'),
      ]);
      setState({ status: 'ready', items: courses.items, batches: batches.items, error: null });
    } catch (err) {
      setState({ status: 'error', items: [], batches: [], error: err });
    }
  }, [status]);

  useEffect(() => { load(); }, [load]);

  const changed = () => { load(); onOptionsChanged?.(); };
  const unlinked = state.batches.filter((batch) => !batch.course);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented label="Course status" options={[['active', 'Active'], ['archived', 'Archived']]} value={status} onChange={setStatus} />
        {canWrite && (
          <Button className="ml-auto" onClick={() => setEditing('new')}>
            <Plus className="mr-1 h-4 w-4" aria-hidden="true" />New course
          </Button>
        )}
      </div>
      {error && <Alert variant="destructive"><AlertDescription>{error.code === 'version_conflict' ? 'Someone else changed this meanwhile. The latest version is shown; try again.' : error.message}</AlertDescription></Alert>}
      {state.status === 'loading' && <Skeleton className="h-48 w-full" />}
      {state.status === 'error' && <Alert variant="destructive"><AlertDescription>{state.error.message}</AlertDescription></Alert>}
      {state.status === 'ready' && !state.items.length && (
        <p className="text-sm text-muted-foreground">
          {status === 'active' ? 'No courses yet. A course describes what you offer; batches are the classes that run it.' : 'No archived courses.'}
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        {state.items.map((course) => (
          <CourseCard
            key={course.id}
            course={course}
            canWrite={canWrite}
            unlinked={unlinked}
            onEdit={() => setEditing(course)}
            onNewBatch={() => setNewBatchFor(course.id)}
            onChanged={changed}
            onError={(err) => { setError(err); if (err) load(); }}
          />
        ))}
      </div>

      <CourseDialog
        open={Boolean(editing)}
        onOpenChange={(open) => !open && setEditing(null)}
        course={editing === 'new' ? null : editing}
        options={options}
        onSaved={() => { setEditing(null); changed(); }}
      />
      <BatchDialog
        open={Boolean(newBatchFor)}
        onOpenChange={(open) => !open && setNewBatchFor(null)}
        presetCourseId={newBatchFor}
        options={options}
        onSaved={() => { setNewBatchFor(null); changed(); }}
      />
    </div>
  );
}
