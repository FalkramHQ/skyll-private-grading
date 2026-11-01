// Convert a lead into a student (CRM-011, FLKRM-326 S5, D1–D5). Staff choose:
// link an existing student (exact matches only, listed with the reason) or
// create a new roster-only student — never automatic. Batches set the
// enrollment; the lead's parent becomes a guardian.
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Check, X } from 'lucide-react';
import { Alert, AlertDescription } from '../../ui/Alert';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../ui/Dialog';
import { Select } from '../../ui/Select';
import { Skeleton } from '../../ui/Skeleton';
import { cn } from '../../../lib/utils';
import { crmFetch, newIdempotencyKey } from '../../../lib/crm/api';
import { notifyTasksChanged } from '../../../lib/crm/tasks';
import { RELATIONSHIPS } from '../../../../shared/crm/guardians.js';

const REASON = { phone: 'Same parent phone', name: 'Same name' };
const STATUS = { active: 'Active', inactive: 'Inactive', alumni: 'Alumni' };

function Section({ title, children }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {children}
    </section>
  );
}

function Choice({ checked, onChange, children, name = 'convert-target', value }) {
  return (
    <label className={cn('flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm', checked ? 'border-primary bg-primary/5' : 'border-border')}>
      <input type="radio" name={name} value={value} className="mt-1 h-4 w-4" checked={checked} onChange={onChange} />
      <span className="min-w-0 flex-1 space-y-1">{children}</span>
    </label>
  );
}

export default function ConvertDialog({ leadId, open, onClose, onConverted }) {
  const navigate = useNavigate();
  const [preview, setPreview] = useState(null);
  const [status, setStatus] = useState('loading');
  const [target, setTarget] = useState(null);
  const [confirmNoMatch, setConfirmNoMatch] = useState(false);
  const [batchIds, setBatchIds] = useState([]);
  const [relationship, setRelationship] = useState('guardian');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setStatus('loading');
    try {
      const data = await crmFetch(`leads/conversion?${new URLSearchParams({ leadId })}`);
      setPreview(data);
      setTarget(data.candidates.length ? null : 'create');
      setBatchIds(data.suggestedBatchIds);
      setConfirmNoMatch(false);
      setStatus('ready');
    } catch (err) {
      setError(err);
      setStatus('error');
    }
  }, [leadId]);

  useEffect(() => { if (open) { setError(null); load(); } }, [open, load]);

  if (!open) return null;
  const unmet = preview?.requirements.filter((item) => !item.met) || [];
  const creating = target === 'create';
  const needsConfirm = creating && preview?.candidates.length > 0;
  const hasYear = preview?.batches.some((batch) => batchIds.includes(batch.id) && batch.hasAcademicYear);
  const ready = preview && target && batchIds.length > 0 && hasYear && !unmet.length && (!needsConfirm || confirmNoMatch);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await crmFetch('leads/convert', {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
        body: {
          leadId,
          expectedVersion: preview.version,
          mode: creating ? 'create' : 'link',
          ...(creating ? {} : { studentId: target }),
          batchIds,
          relationship,
          ...(needsConfirm ? { confirmNoMatch: true } : {}),
        },
      });
      notifyTasksChanged();
      onConverted?.(result);
      navigate(`/crm/students/${result.studentId}?fees=setup`);
    } catch (err) {
      setError(err);
      // The lead or the candidates changed underneath the dialog: refresh it.
      if (['version_conflict', 'possible_match'].includes(err.code)) await load();
    } finally {
      setBusy(false);
    }
  };

  const toggleBatch = (id) => setBatchIds((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));

  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Convert {preview?.learnerName || 'lead'} to a student</DialogTitle>
          <DialogDescription>
            Adds them to the school&apos;s roster (no login is created) and moves the lead to Enrolled. The lead&apos;s history is kept.
          </DialogDescription>
        </DialogHeader>

        {status === 'loading' && <Skeleton className="h-48 w-full" />}
        {status === 'error' && <Alert variant="destructive"><AlertDescription>{error.message}</AlertDescription></Alert>}

        {status === 'ready' && preview.convertedStudentId && (
          <Alert variant="success">
            <AlertDescription>
              Already converted. <Link to={`/crm/students/${preview.convertedStudentId}`} className="underline">Open the student</Link>
            </AlertDescription>
          </Alert>
        )}

        {status === 'ready' && !preview.convertedStudentId && (
          <div className="space-y-5">
            {!preview.canConvert && (
              <Alert variant="destructive"><AlertDescription>Lost leads can&apos;t be converted. Reopen the lead first.</AlertDescription></Alert>
            )}

            {preview.requirements.length > 0 && (
              <Section title="Required before enrollment">
                <ul className="space-y-1 text-sm">
                  {preview.requirements.map((item) => (
                    <li key={item.key} className={cn('flex items-center gap-2', item.met ? 'text-foreground' : 'text-destructive')}>
                      {item.met ? <Check className="h-4 w-4 text-success-soft-foreground" aria-hidden="true" /> : <X className="h-4 w-4" aria-hidden="true" />}
                      {item.label}
                      <span className="sr-only">{item.met ? '(done)' : '(missing)'}</span>
                    </li>
                  ))}
                </ul>
                {unmet.length > 0 && <p className="text-xs text-muted-foreground">Update the lead first, then convert.</p>}
              </Section>
            )}

            <Section title="Is this learner already a student?">
              {preview.candidates.length > 0
                ? <p className="text-xs text-muted-foreground">These students match exactly on the parent&apos;s phone or the name. Nothing is linked unless you choose it.</p>
                : <p className="text-xs text-muted-foreground">No existing student matches this learner&apos;s parent phone or name.</p>}
              <div className="space-y-2" role="radiogroup" aria-label="Student to use">
                {preview.candidates.map((candidate) => (
                  <Choice key={candidate.studentId} value={candidate.studentId} checked={target === candidate.studentId} onChange={() => setTarget(candidate.studentId)}>
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">Link to {candidate.name}</span>
                      {candidate.reasons.map((reason) => <Badge key={reason} variant="outline">{REASON[reason]}</Badge>)}
                      {candidate.status !== 'active' && <Badge variant="secondary">{STATUS[candidate.status] || candidate.status}: will be re-admitted</Badge>}
                    </span>
                    <span className="block text-xs text-muted-foreground">{candidate.batches.join(', ') || 'Not in a batch'}</span>
                  </Choice>
                ))}
                <Choice value="create" checked={creating} onChange={() => setTarget('create')}>
                  <span className="font-medium">Create a new student</span>
                  <span className="block text-xs text-muted-foreground">Roster only; a login can be added later from the roster.</span>
                </Choice>
              </div>
              {needsConfirm && (
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-0.5 h-4 w-4" checked={confirmNoMatch} onChange={(event) => setConfirmNoMatch(event.target.checked)} />
                  I&apos;ve checked: none of the students above is this learner.
                </label>
              )}
            </Section>

            <Section title="Batches">
              <div className="grid gap-2 sm:grid-cols-2">
                {preview.batches.map((batch) => (
                  <label key={batch.id} className="flex items-start gap-2 text-sm">
                    <input type="checkbox" className="mt-0.5 h-4 w-4" checked={batchIds.includes(batch.id)} onChange={() => toggleBatch(batch.id)} />
                    <span>
                      {batch.name}
                      {!batch.hasAcademicYear && <span className="block text-xs text-muted-foreground">No academic year set</span>}
                    </span>
                  </label>
                ))}
              </div>
              {batchIds.length > 0 && !hasYear && (
                <p className="text-xs text-destructive">Choose at least one batch with an academic year: the enrollment year comes from it.</p>
              )}
            </Section>

            {preview.hasContact && (
              <Section title="Parent">
                <label htmlFor="convert-relationship" className="text-xs text-muted-foreground">
                  The lead&apos;s contact becomes a guardian (primary if the student has none yet). How are they related?
                </label>
                <Select id="convert-relationship" value={relationship} onChange={(event) => setRelationship(event.target.value)} className="sm:w-56">
                  {RELATIONSHIPS.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
                </Select>
              </Section>
            )}

            {error && <Alert variant="destructive"><AlertDescription>{error.message}</AlertDescription></Alert>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
              <Button onClick={submit} disabled={busy || !ready || !preview.canConvert}>
                {creating ? 'Create student and enroll' : 'Link and enroll'}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
