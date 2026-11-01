// Lead profile (CRM-007, FLKRM-326 S1): details, contact, owner, stage and
// history. Notes editing, tags and the merged timeline arrive in S3.
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Phone, Plus } from 'lucide-react';
import { Alert, AlertDescription } from '../../ui/Alert';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/Card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../ui/Dialog';
import { Input } from '../../ui/Input';
import { Select } from '../../ui/Select';
import { Skeleton } from '../../ui/Skeleton';
import { crmFetch, newIdempotencyKey } from '../../../lib/crm/api';
import { notifyTasksChanged, useTasksChanged } from '../../../lib/crm/tasks';
import { DEFAULT_LEAD_SOURCES } from '../../../../shared/crm/pipeline.js';
import { Field, MoveToSelect, StageBadge, formatDate, lostLabel } from './leadUi';
import { useLeadMove } from './useLeadMove';
import ActivityTimeline from '../records/ActivityTimeline';
import { MessageButton } from '../comms/MessageDialog';
import ConvertDialog from './ConvertDialog';
import NotesCard from '../records/NotesCard';
import RecordTasks from '../records/RecordTasks';
import TagPicker from '../records/TagPicker';

const LIFECYCLE = { lead: 'Lead', applicant: 'Applicant', lost: 'Lost', converted: 'Converted' };

function Detail({ label, children }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm text-foreground">{children || '—'}</dd>
    </div>
  );
}

function DetailsCard({ lead, canWrite, onSave, busy }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(null);
  const start = () => {
    setForm({
      learnerName: lead.learnerName,
      learnerGrade: lead.learnerGrade || '',
      sourceKey: lead.source?.key || '',
      course: lead.interest.course || '',
      schedule: lead.interest.schedule || '',
    });
    setEditing(true);
  };
  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const save = async (event) => {
    event.preventDefault();
    const interest = {};
    if (form.course.trim()) interest.course = form.course.trim();
    if (form.schedule.trim()) interest.schedule = form.schedule.trim();
    const ok = await onSave({
      learnerName: form.learnerName.trim(),
      learnerGrade: form.learnerGrade.trim() || null,
      sourceKey: form.sourceKey || null,
      interest,
    });
    if (ok) setEditing(false);
  };

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">Details</CardTitle>
        {canWrite && !editing && <Button size="sm" variant="outline" onClick={start}>Edit</Button>}
      </CardHeader>
      <CardContent>
        {editing ? (
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={save}>
            <Field label="Student name" htmlFor="edit-name"><Input id="edit-name" required maxLength={120} value={form.learnerName} onChange={set('learnerName')} /></Field>
            <Field label="Grade / class" htmlFor="edit-grade"><Input id="edit-grade" maxLength={32} value={form.learnerGrade} onChange={set('learnerGrade')} /></Field>
            <Field label="Course interest" htmlFor="edit-course"><Input id="edit-course" maxLength={120} value={form.course} onChange={set('course')} /></Field>
            <Field label="Preferred schedule" htmlFor="edit-schedule"><Input id="edit-schedule" maxLength={120} value={form.schedule} onChange={set('schedule')} /></Field>
            <Field label="Source" htmlFor="edit-source">
              <Select id="edit-source" value={form.sourceKey} onChange={set('sourceKey')}>
                <option value="">Not recorded</option>
                {DEFAULT_LEAD_SOURCES.map((source) => <option key={source.key} value={source.key}>{source.label}</option>)}
              </Select>
            </Field>
            <div className="flex items-end justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setEditing(false)} disabled={busy}>Cancel</Button>
              <Button type="submit" disabled={busy || !form.learnerName.trim()}>Save</Button>
            </div>
          </form>
        ) : (
          <dl className="grid gap-4 sm:grid-cols-2">
            <Detail label="Grade / class">{lead.learnerGrade}</Detail>
            <Detail label="Source">{lead.source?.label}</Detail>
            <Detail label="Course interest">{lead.interest.course}</Detail>
            <Detail label="Preferred schedule">{lead.interest.schedule}</Detail>
            <Detail label="Created">{formatDate(lead.createdAt)}</Detail>
            <Detail label="Last activity">{formatDate(lead.lastActivityAt)}</Detail>
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

function ContactCard({ lead }) {
  if (!lead.hasContact) {
    return <Card><CardContent className="pt-6 text-sm text-muted-foreground">No parent contact recorded yet.</CardContent></Card>;
  }
  // Without contact access the server returns no contact details at all.
  if (!lead.contact) {
    return <Card><CardContent className="pt-6 text-sm text-muted-foreground">A parent contact is recorded. You don&apos;t have access to contact details.</CardContent></Card>;
  }
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Parent contact</CardTitle></CardHeader>
      <CardContent className="space-y-2 text-sm">
        <p className="font-medium">{lead.contact.name || 'Name not recorded'}</p>
        {lead.contact.phone && (
          <a href={`tel:${lead.contact.phone}`} className="flex items-center gap-2 text-accent hover:underline">
            <Phone className="h-4 w-4" aria-hidden="true" />{lead.contact.phone}
          </a>
        )}
        <Badge variant={lead.contact.whatsappOptIn ? 'success' : 'secondary'}>
          {lead.contact.whatsappOptIn ? 'WhatsApp opted in' : 'No WhatsApp consent'}
        </Badge>
      </CardContent>
    </Card>
  );
}

/** Asks whether a lead's open tasks should follow it to the new owner (D12). */
function OwnerChangeDialog({ change, busy, onCancel, onConfirm }) {
  const count = change?.count || 0;
  return (
    <Dialog open={Boolean(change)} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Give this lead to {change?.toName}?</DialogTitle>
          <DialogDescription>
            {change?.fromName || 'The current owner'} has {count} open task{count === 1 ? '' : 's'} for this lead.
            Move {count === 1 ? 'it' : 'them'} to {change?.toName} as well?
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button variant="secondary" onClick={() => onConfirm(false)} disabled={busy}>Only the lead</Button>
          <Button onClick={() => onConfirm(true)} disabled={busy}>Move lead and tasks</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function LeadProfile({ me }) {
  const { leadId } = useParams();
  const canWrite = me.capabilities.includes('crm.leads.write');
  const [state, setState] = useState({ status: 'loading', lead: null, stages: [], owners: [], error: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [ownerChange, setOwnerChange] = useState(null);
  const [converting, setConverting] = useState(false);
  const canConvert = me.capabilities.includes('crm.leads.convert') && me.capabilities.includes('crm.students.read');
  // Bumped after any change on this lead so the activity timeline reloads.
  const [activityKey, setActivityKey] = useState(0);
  const bumpActivity = () => setActivityKey((key) => key + 1);
  const canMoveTasks = me.taskScope === 'school' && me.capabilities.includes('crm.tasks.write');

  const load = useCallback(async () => {
    try {
      const [lead, pipeline, owners] = await Promise.all([
        crmFetch(`leads/detail?${new URLSearchParams({ leadId })}`),
        crmFetch('settings/pipeline'),
        crmFetch('leads/owners'),
      ]);
      setState({ status: 'ready', lead, stages: pipeline.stages, owners: owners.items, error: null });
    } catch (err) {
      setState({ status: 'error', lead: null, stages: [], owners: [], error: err });
    }
  }, [leadId]);

  useEffect(() => { load(); }, [load]);
  // Task writes change the "move N open tasks" count shown on owner change.
  useTasksChanged(load);

  const mover = useLeadMove(() => { load(); bumpActivity(); });

  const write = async (path, body) => {
    setBusy(true);
    setError(null);
    try {
      await crmFetch(path, { method: 'POST', body: { leadId, expectedVersion: state.lead.version, ...body }, idempotencyKey: newIdempotencyKey() });
      if (body.moveOpenTasks) notifyTasksChanged();
      await load();
      bumpActivity();
      return true;
    } catch (err) {
      setError(err);
      if (err.code === 'version_conflict') await load();
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (state.status === 'loading') return <Skeleton className="h-96 w-full" />;
  if (state.status === 'error') {
    return (
      <div className="space-y-4">
        <BackLink />
        <Alert variant="destructive"><AlertDescription>{state.error.status === 404 ? 'This lead was not found.' : state.error.message}</AlertDescription></Alert>
      </div>
    );
  }

  const { lead, stages, owners } = state;
  const changeOwner = (ownerUserId) => {
    if (!ownerUserId) return;
    if (canMoveTasks && lead.ownerOpenTaskCount > 0) {
      setOwnerChange({
        ownerUserId,
        count: lead.ownerOpenTaskCount,
        fromName: lead.owner?.name || null,
        toName: owners.find((owner) => owner.userId === ownerUserId)?.name || 'the new owner',
      });
    } else {
      write('leads/owner', { ownerUserId });
    }
  };
  const confirmOwnerChange = async (moveOpenTasks) => {
    await write('leads/owner', { ownerUserId: ownerChange.ownerUserId, ...(moveOpenTasks ? { moveOpenTasks: true } : {}) });
    setOwnerChange(null);
  };
  const shownError = error || mover.error;
  const lost = lead.stage.category === 'lost' ? lostLabel(lead) : null;
  const ownerOptions = lead.owner && !owners.some((owner) => owner.userId === lead.owner.userId)
    ? [{ userId: lead.owner.userId, name: lead.owner.name }, ...owners]
    : owners;
  return (
    <div className="space-y-6">
      <BackLink />
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1 space-y-2">
          <h2 className="font-headline text-2xl">{lead.learnerName}</h2>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant="outline">{LIFECYCLE[lead.lifecycle] || lead.lifecycle}</Badge>
            <StageBadge category={lead.stage.category}>{lead.stage.name}</StageBadge>
            {lost && <span className="text-destructive">{lost}</span>}
            {lead.convertedStudentId && (
              <Link to={`/crm/students/${lead.convertedStudentId}`} className="text-sm text-accent hover:underline">Now a student: open profile →</Link>
            )}
          </div>
          <TagPicker
            entityType="lead"
            entityId={lead.id}
            tags={lead.tags || []}
            canWrite={canWrite}
            onChange={(tags) => { setState((current) => ({ ...current, lead: { ...current.lead, tags } })); bumpActivity(); }}
            onError={setError}
          />
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-64">
          <Field label="Owner" htmlFor="lead-owner-select">
            <Select
              id="lead-owner-select"
              value={lead.owner?.userId || ''}
              disabled={!canWrite || busy}
              onChange={(event) => changeOwner(event.target.value)}
            >
              {!lead.owner && <option value="">Unowned</option>}
              {ownerOptions.map((owner) => <option key={owner.userId} value={owner.userId}>{owner.name}</option>)}
            </Select>
          </Field>
          {canWrite && <MoveToSelect lead={lead} stages={stages} disabled={mover.busy} onMove={mover.move} className="h-10 text-sm" />}
          {canConvert && !lead.convertedStudentId && ['open', 'applicant'].includes(lead.stage.category) && (
            <Button onClick={() => setConverting(true)}>Convert to student</Button>
          )}
          <MessageButton me={me} target={{ entityType: 'lead', entityId: lead.id, label: lead.contact?.name || lead.learnerName }} onSent={bumpActivity} />
        </div>
      </div>

      {shownError && (
        <Alert variant="destructive">
          <AlertDescription>
            {shownError.code === 'version_conflict' ? 'Someone else updated this lead. The latest version is shown; try again.' : shownError.message}
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <DetailsCard lead={lead} canWrite={canWrite} busy={busy} onSave={(changes) => write('leads/update', changes)} />
          {me.capabilities.includes('crm.tasks.read') && <RecordTasks entityType="lead" entityId={lead.id} label={lead.learnerName} me={me} />}
          <NotesCard entityType="lead" entityId={lead.id} canWrite={canWrite} onChanged={bumpActivity} />
        </div>
        <div className="space-y-6">
          <ContactCard lead={lead} />
          <ActivityTimeline entityType="lead" entityId={lead.id} refreshKey={activityKey} me={me} label={lead.learnerName} />
        </div>
      </div>
      {mover.dialog}
      {converting && <ConvertDialog leadId={lead.id} open onClose={() => setConverting(false)} />}
      <OwnerChangeDialog change={ownerChange} busy={busy} onCancel={() => setOwnerChange(null)} onConfirm={confirmOwnerChange} />
    </div>
  );
}

function BackLink() {
  return (
    <Link to="/crm/leads" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft className="h-4 w-4" aria-hidden="true" />All leads
    </Link>
  );
}
