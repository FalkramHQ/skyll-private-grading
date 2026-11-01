// Student profile (CRM-007/008, FLKRM-326 S4, D13): the canonical student with
// batches, enrollments and progress read from Skyll's own tables, plus the
// CRM's guardians, owner, tags, notes, tasks and activity. Each section is
// shown only with its capability; the server re-checks.
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { Alert, AlertDescription } from '../../ui/Alert';
import { Badge } from '../../ui/Badge';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/Card';
import { Select } from '../../ui/Select';
import { Skeleton } from '../../ui/Skeleton';
import { crmFetch, newIdempotencyKey } from '../../../lib/crm/api';
import { Field, formatDate } from '../leads/leadUi';
import ActivityTimeline from '../records/ActivityTimeline';
import NotesCard from '../records/NotesCard';
import RecordTasks from '../records/RecordTasks';
import TagPicker from '../records/TagPicker';
import { StudentAttendanceCard } from '../attendance/AttendanceSummary';
import StudentFeesCard from '../fees/StudentFeesCard';
import GuardiansCard from './GuardiansCard';
import { MessageButton } from '../comms/MessageDialog';
import { STATUS_LABELS } from './StudentsPage';
import { ReportViewPanel } from '../reports/ReportViewPanel';

const LIFECYCLE = { enrolled: 'Enrolled', inactive: 'Inactive', alumni: 'Alumni', archived: 'Archived' };

function BatchesCard({ student }) {
  const current = student.batches.filter((batch) => batch.status === 'active');
  const past = student.batches.filter((batch) => batch.status !== 'active');
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Batches and enrollment</CardTitle></CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div>
          <p className="mb-1 text-xs text-muted-foreground">Current batches</p>
          {current.length
            ? <ul className="space-y-1">{current.map((batch) => <li key={batch.membershipId}><span className="font-medium">{batch.name}</span> <span className="text-xs text-muted-foreground">since {formatDate(batch.joinedAt)}</span></li>)}</ul>
            : <p className="text-muted-foreground">Not in any batch.</p>}
        </div>
        {past.length > 0 && (
          <div>
            <p className="mb-1 text-xs text-muted-foreground">Past batches</p>
            <ul className="space-y-1 text-muted-foreground">
              {past.map((batch) => <li key={batch.membershipId}>{batch.name} <span className="text-xs">{formatDate(batch.joinedAt)} – {formatDate(batch.leftAt) || 'ended'}</span></li>)}
            </ul>
          </div>
        )}
        <div>
          <p className="mb-1 text-xs text-muted-foreground">Enrollment</p>
          {student.enrollments.length
            ? (
              <ul className="space-y-1">
                {student.enrollments.map((enrollment) => (
                  <li key={enrollment.id} className="flex items-center gap-2">
                    <span>{enrollment.academicYear} · Class {enrollment.standard}</span>
                    {enrollment.isCurrent && <Badge variant="secondary">Current year</Badge>}
                    {enrollment.status !== 'active' && <span className="text-xs text-muted-foreground">({enrollment.status})</span>}
                  </li>
                ))}
              </ul>
            )
            : <p className="text-muted-foreground">No enrollment recorded.</p>}
        </div>
      </CardContent>
    </Card>
  );
}

function ProgressCard({ student, me, progressSections, onOpenReport }) {
  const reportUrl = student.reportUsername && !me.crmOnly ? `/student/${encodeURIComponent(student.reportUsername)}` : null;
  const rows = progressSections.length ? progressSections : student.progress;
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">Assessments</CardTitle>
        {reportUrl && (
          <a href={reportUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-accent hover:underline">
            Open full report<ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        )}
      </CardHeader>
      <CardContent>
        {rows.length
          ? (
            <ul className="divide-y divide-border text-sm">
              {rows.map((item) => (
                <li
                  key={item.id || item.submissionId}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 hover:bg-paper-soft cursor-pointer"
                  onClick={() => onOpenReport(item)}
                >
                  <span className="min-w-0 flex-1 font-medium">{item.examName}</span>
                  {item.subject && <span className="text-xs text-muted-foreground">{item.subject}</span>}
                  <span className="text-xs text-muted-foreground">{formatDate(item.date)}</span>
                  <span className="tabular-nums">{item.score !== null && item.maxMarks ? `${item.score}/${item.maxMarks}` : '—'}</span>
                  <Badge variant={item.reportPublished ? 'success' : 'secondary'}>{item.reportPublished ? 'Report published' : 'In review'}</Badge>
                </li>
              ))}
            </ul>
          )
          : <p className="text-sm text-muted-foreground">No assessments yet.</p>}
      </CardContent>
    </Card>
  );
}

export default function StudentProfile({ me }) {
  const { studentId } = useParams();
  const has = (capability) => me.capabilities.includes(capability);
  const canWrite = has('crm.students.write');
  const [state, setState] = useState({ status: 'loading', student: null, owners: [], error: null });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [activityKey, setActivityKey] = useState(0);
  const [progressSections, setProgressSections] = useState([]);
  const [openReport, setOpenReport] = useState(null);
  const bumpActivity = () => setActivityKey((key) => key + 1);

  const load = useCallback(async () => {
    try {
      const [student, owners, progress] = await Promise.all([
        crmFetch(`students/detail?${new URLSearchParams({ studentId })}`),
        crmFetch('students/owners'),
        crmFetch(`students/progress?${new URLSearchParams({ studentId })}`),
      ]);
      setState({ status: 'ready', student, owners: owners.items, error: null });
      setProgressSections(progress.items || []);
    } catch (err) {
      setState({ status: 'error', student: null, owners: [], error: err });
      setProgressSections([]);
    }
  }, [studentId]);

  useEffect(() => { load(); }, [load]);

  const changeOwner = async (ownerUserId) => {
    if (!ownerUserId) return;
    setBusy(true);
    setError(null);
    try {
      await crmFetch('students/owner', { method: 'POST', body: { studentId, ownerUserId, expectedVersion: state.student.version }, idempotencyKey: newIdempotencyKey() });
      await load();
      bumpActivity();
    } catch (err) {
      setError(err);
      if (err.code === 'version_conflict') await load();
    } finally {
      setBusy(false);
    }
  };

  const handleOpenReport = useCallback(
    (item) => {
      setOpenReport({
        submissionId: item.submissionId || item.id,
        examId: item.examId || '',
        publishedAt: item.date,
        reviewPending: item.reviewPending,
        student: {
          name: state.student?.name,
          reportUsername: state.student?.reportUsername,
          rosterKey: state.student?.rosterKey,
        },
        exam: {
          id: item.examId || '',
          name: item.examName,
          date: item.date,
          subject: item.subject,
        },
        score: item.score,
        maxMarks: item.maxMarks,
        sections: item.sections,
        payload: item.payloadJson || null,
        summary: {
          overallScore: item.score,
          overallMax: item.maxMarks,
          caveat: null,
        },
      });
    },
    [state.student]
  );
  const closeReport = useCallback(() => {
    setOpenReport(null);
  }, []);

  if (state.status === 'loading') return <Skeleton className="h-96 w-full" />;
  if (state.status === 'error') {
    return (
      <div className="space-y-4">
        <BackLink />
        <Alert variant="destructive"><AlertDescription>{state.error.status === 404 ? 'This student was not found.' : state.error.message}</AlertDescription></Alert>
      </div>
    );
  }

  const { student, owners } = state;
  const ownerOptions = student.owner && !owners.some((owner) => owner.userId === student.owner.userId)
    ? [{ userId: student.owner.userId, name: student.owner.name }, ...owners]
    : owners;
  return (
    <div className="space-y-6">
      <BackLink />
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1 space-y-2">
          <h2 className="font-headline text-2xl">{student.name}</h2>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant={student.status === 'active' ? 'success' : 'secondary'}>{LIFECYCLE[student.lifecycle] || STATUS_LABELS[student.status]}</Badge>
            {student.standard && <span className="text-muted-foreground">Class {student.standard}</span>}
            <Badge variant="outline">{student.hasLogin ? 'Has a Skyll login' : 'Roster only (no login)'}</Badge>
            {student.convertedFromLead && (
              <Link to={`/crm/leads/${student.convertedFromLead.id}`} className="text-sm text-accent hover:underline">Admissions history →</Link>
            )}
          </div>
          <TagPicker
            entityType="student"
            entityId={student.id}
            tags={student.tags}
            canWrite={canWrite}
            onChange={(tags) => { setState((current) => ({ ...current, student: { ...current.student, tags } })); bumpActivity(); }}
            onError={setError}
          />
        </div>
        <div className="w-full space-y-3 sm:w-64">
          <MessageButton me={me} target={{ entityType: 'student', entityId: student.id, label: student.name }} onSent={bumpActivity} />
          <Field label="CRM owner" htmlFor="student-owner-select">
            <Select id="student-owner-select" value={student.owner?.userId || ''} disabled={!canWrite || busy} onChange={(event) => changeOwner(event.target.value)}>
              {!student.owner && <option value="">No owner</option>}
              {ownerOptions.map((owner) => <option key={owner.userId} value={owner.userId}>{owner.name}</option>)}
            </Select>
          </Field>
        </div>
      </div>

      {error && <Alert variant="destructive"><AlertDescription>{error.code === 'version_conflict' ? 'Someone else changed this student. The latest version is shown; try again.' : error.message}</AlertDescription></Alert>}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <BatchesCard student={student} />
          {has('crm.finance.read') && <StudentFeesCard student={student} me={me} />}
          {has('crm.attendance.read') && <StudentAttendanceCard studentId={student.id} />}
          {has('crm.progress.read') && <ProgressCard student={student} me={me} progressSections={progressSections} onOpenReport={handleOpenReport} />}
          {has('crm.tasks.read') && <RecordTasks entityType="student" entityId={student.id} label={student.name} me={me} />}
          {/* Anyone who can see a student can add notes (D14a); tags and owner still need write. */}
          <NotesCard entityType="student" entityId={student.id} canWrite onChanged={bumpActivity} />
        </div>
        <div className="space-y-6">
          {has('crm.contacts.read') && <GuardiansCard studentId={student.id} me={me} onChanged={bumpActivity} />}
          <ActivityTimeline entityType="student" entityId={student.id} refreshKey={activityKey} me={me} label={student.name} />
        </div>
      </div>
      {openReport && <ReportViewPanel report={openReport} onClose={closeReport} />}
    </div>
  );
}

function BackLink() {
  return (
    <Link to="/crm/students" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft className="h-4 w-4" aria-hidden="true" />All students
    </Link>
  );
}
