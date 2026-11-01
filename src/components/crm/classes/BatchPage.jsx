// One batch in the CRM (FLKRM-327, D12): overview and students now; the
// instructors, timetable, sessions and attendance tabs join in later slices.
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { Alert, AlertDescription } from '../../ui/Alert';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { MessageButton } from '../comms/MessageDialog';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/Card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../ui/Dialog';
import { Skeleton } from '../../ui/Skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../ui/Tabs';
import { crmFetch } from '../../../lib/crm/api';
import { classesWrite, dateRange, useClassesOptions } from '../../../lib/crm/classes';
import { BatchAttendance } from '../attendance/AttendanceSummary';
import BatchInstructors from './BatchInstructors';
import BatchStudents from './BatchStudents';
import { BatchRules, BatchSessions } from './BatchTimetable';
import SessionDialog from './SessionDialog';
import { StudentCount } from './BatchesTab';
import { BatchDialog } from './ClassDialogs';

function Detail({ label, children }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5">{children || <span className="text-muted-foreground">—</span>}</dd>
    </div>
  );
}

function ArchiveDialog({ open, onOpenChange, batch, onArchived }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // Set when the server says archiving would cancel future classes (D12).
  const [futureCount, setFutureCount] = useState(0);
  useEffect(() => { if (open) { setError(null); setFutureCount(0); } }, [open]);
  const archive = async () => {
    setBusy(true);
    setError(null);
    try {
      onArchived(await classesWrite('classes/batches/archive', { batchId: batch.id, ...(futureCount ? { cancelFutureSessions: true } : {}) }));
    } catch (err) {
      if (err.code === 'has_future_sessions') setFutureCount(err.details.sessionCount);
      else setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Archive {batch.name}?</DialogTitle>
          <DialogDescription>Archived batches can&apos;t get new students or tests. Past tests and history stay.</DialogDescription>
        </DialogHeader>
        {batch.studentCount > 0 && (
          <Alert><AlertDescription>This batch still has {batch.studentCount} student{batch.studentCount === 1 ? '' : 's'}. Remove or move them first.</AlertDescription></Alert>
        )}
        {futureCount > 0 && (
          <Alert><AlertDescription>This cancels {futureCount} future class{futureCount === 1 ? '' : 'es'} (reason &quot;Batch archived&quot;) and ends its timetables.</AlertDescription></Alert>
        )}
        {error && <Alert variant="destructive"><AlertDescription>{error.message}</AlertDescription></Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button variant="destructive" onClick={archive} disabled={busy || batch.studentCount > 0}>
            {futureCount ? `Archive and cancel ${futureCount} class${futureCount === 1 ? '' : 'es'}` : 'Archive batch'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Overview({ batch, canWrite, onEdit, onArchive }) {
  return (
    <Card className="max-w-3xl">
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">Details</CardTitle>
        {canWrite && (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={onEdit}>Edit</Button>
            <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={onArchive}>Archive</Button>
          </div>
        )}
      </CardHeader>
      <CardContent>
        <dl className="grid gap-4 text-sm sm:grid-cols-3">
          <Detail label="Course">{batch.course && `${batch.course.name}${batch.course.status === 'archived' ? ' (archived)' : ''}`}</Detail>
          <Detail label="Academic year">{batch.academicYear?.label}</Detail>
          <Detail label="Class">{batch.grade}</Detail>
          <Detail label="Subject">{batch.subject?.name}</Detail>
          <Detail label="Lead instructor">{batch.lead?.name}</Detail>
          <Detail label="Runs">{dateRange(batch.startsOn, batch.endsOn)}</Detail>
          <Detail label="Students"><StudentCount batch={batch} />{batch.capacity ? ' (capacity)' : ''}</Detail>
          <Detail label="Usual room">{batch.defaultRoom && `${batch.defaultRoom.name}${batch.defaultRoom.seats ? ` · ${batch.defaultRoom.seats} seats` : ''}`}</Detail>
          <Detail label="Online link">
            {batch.defaultOnlineUrl && (
              <a href={batch.defaultOnlineUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
                Open link<ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
            )}
          </Detail>
        </dl>
      </CardContent>
    </Card>
  );
}

export default function BatchPage({ me }) {
  const { batchId } = useParams();
  const canWrite = me.capabilities.includes('crm.classes.write');
  const { options, reload: reloadOptions } = useClassesOptions();
  const [state, setState] = useState({ status: 'loading', batch: null, error: null });
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [openSession, setOpenSession] = useState(null);
  const [sessionsKey, setSessionsKey] = useState(0);

  const load = useCallback(async () => {
    try {
      setState({ status: 'ready', batch: await crmFetch(`classes/batches/detail?${new URLSearchParams({ batchId })}`), error: null });
    } catch (error) {
      setState({ status: 'error', batch: null, error });
    }
  }, [batchId]);

  useEffect(() => { load(); }, [load]);

  if (state.status === 'loading') return <Skeleton className="h-96 w-full" />;
  if (state.status === 'error') {
    return (
      <div className="space-y-4">
        <BackLink />
        <Alert variant="destructive"><AlertDescription>{state.error.status === 404 ? 'This batch was not found.' : state.error.message}</AlertDescription></Alert>
      </div>
    );
  }

  const { batch } = state;
  const editable = canWrite && batch.status === 'active';
  return (
    <div className="space-y-6">
      <BackLink />
      <div className="space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h2 className="font-headline text-2xl">{batch.name}</h2>
          {batch.status === 'active' && <MessageButton me={me} target={{ entityType: 'batch', entityId: batch.id, label: batch.name }} label="Message batch" />}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge variant={batch.status === 'active' ? 'success' : 'secondary'}>{batch.status === 'active' ? 'Active' : 'Archived'}</Badge>
          {batch.course && <Badge variant="outline">{batch.course.name}</Badge>}
          {batch.academicYear && <span className="text-muted-foreground">{batch.academicYear.label}</span>}
          {batch.grade && <span className="text-muted-foreground">Class {batch.grade}</span>}
        </div>
      </div>

      <Tabs defaultValue="overview" className="space-y-6">
        <TabsList className="overflow-x-auto rounded-t-xl">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="instructors">Instructors</TabsTrigger>
          <TabsTrigger value="timetable">Timetable</TabsTrigger>
          <TabsTrigger value="sessions">Sessions</TabsTrigger>
          <TabsTrigger value="students">Students ({batch.studentCount})</TabsTrigger>
          {me.capabilities.includes('crm.attendance.read') && <TabsTrigger value="attendance">Attendance</TabsTrigger>}
        </TabsList>
        <TabsContent value="overview">
          <Overview batch={batch} canWrite={editable} onEdit={() => setEditing(true)} onArchive={() => setArchiving(true)} />
        </TabsContent>
        <TabsContent value="instructors">
          <BatchInstructors me={me} batch={batch} options={options} onChanged={load} />
        </TabsContent>
        <TabsContent value="timetable">
          <BatchRules me={me} batch={batch} options={options} />
        </TabsContent>
        <TabsContent value="sessions">
          <BatchSessions me={me} batch={batch} options={options} onOpenSession={setOpenSession} refreshKey={sessionsKey} />
        </TabsContent>
        <TabsContent value="attendance">
          {me.capabilities.includes('crm.attendance.read') && <BatchAttendance me={me} batch={batch} />}
        </TabsContent>
        <TabsContent value="students">
          <BatchStudents me={me} batch={batch} onChanged={(updated) => updated && setState((current) => ({ ...current, batch: updated }))} />
        </TabsContent>
      </Tabs>

      <BatchDialog
        open={editing}
        onOpenChange={setEditing}
        batch={batch}
        options={options}
        onSaved={(updated) => { setEditing(false); setState((current) => ({ ...current, batch: updated })); reloadOptions(); }}
      />
      <SessionDialog session={openSession} me={me} options={options} onOpenChange={(open) => !open && setOpenSession(null)} onChanged={() => setSessionsKey((key) => key + 1)} />
      <ArchiveDialog
        open={archiving}
        onOpenChange={setArchiving}
        batch={batch}
        onArchived={(updated) => { setArchiving(false); setState((current) => ({ ...current, batch: updated })); }}
      />
    </div>
  );
}

function BackLink() {
  return (
    <Link to="/crm/classes" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft className="h-4 w-4" aria-hidden="true" />All batches
    </Link>
  );
}
