// New lead form (CRM-009, D10). While staff type, it checks for families the
// CRM may already know and shows them; creating anyway is allowed and audited.
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ExternalLink } from 'lucide-react';
import { Alert, AlertDescription } from '../../ui/Alert';
import { Button } from '../../ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../ui/Dialog';
import { Input } from '../../ui/Input';
import { Select } from '../../ui/Select';
import { crmFetch, newIdempotencyKey } from '../../../lib/crm/api';
import { notifyTasksChanged } from '../../../lib/crm/tasks';
import { createLeadBody, fieldErrors } from '../../../../shared/crm/leads.js';
import { DEFAULT_LEAD_SOURCES } from '../../../../shared/crm/pipeline.js';
import { normalizePhone } from '../../../../shared/phone.js';
import { Badge } from '../../ui/Badge';
import { Field, StageBadge, Textarea } from './leadUi';

const EMPTY = {
  learnerName: '', learnerGrade: '', parentName: '', phone: '', whatsappOptIn: false,
  sourceKey: '', course: '', schedule: '', ownerUserId: '', note: '',
};

const REASON = { phone: 'Same parent phone', name: 'Same student name' };
const STUDENT_STATUS = { active: 'Active', inactive: 'Inactive', alumni: 'Alumni' };

function Fact({ label, children }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-muted-foreground">{label}:</span>
      <span className="text-foreground">{children}</span>
    </span>
  );
}

function MatchRow({ match }) {
  const isLead = match.kind === 'lead';
  return (
    <li className="space-y-2 rounded-lg border border-border bg-card p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-foreground">{match.name}</span>
        {isLead && (
          <Link
            to={`/crm/leads/${match.id}`}
            target="_blank"
            rel="noreferrer"
            className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-accent underline-offset-4 hover:underline"
          >
            Open lead<ExternalLink className="h-3 w-3" aria-hidden="true" />
          </Link>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-muted-foreground">Matched on:</span>
        {match.reasons.map((reason) => <Badge key={reason} variant="outline">{REASON[reason]}</Badge>)}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <Fact label="Type">{isLead ? 'Lead' : 'Student'}</Fact>
        {isLead && match.convertedStudentId && <span className="text-foreground">Already enrolled as a student</span>}
        {isLead && !match.convertedStudentId && (
          <>
            <Fact label="Stage"><StageBadge category={match.stage.category}>{match.stage.name}</StageBadge></Fact>
            <Fact label="Owner">{match.ownerName || 'Unowned'}</Fact>
          </>
        )}
        {!isLead && <Fact label="Status">{STUDENT_STATUS[match.status] || match.status}</Fact>}
      </div>
    </li>
  );
}

export function DuplicatePanel({ matches }) {
  if (!matches?.length) return null;
  return (
    <div role="status" className="space-y-3 rounded-lg border border-border border-l-4 border-l-warning-soft-foreground bg-background p-3">
      <p className="flex items-center gap-2 text-sm font-medium text-foreground">
        <AlertTriangle className="h-4 w-4 text-warning-soft-foreground" aria-hidden="true" />
        Possible match: this family may already be in the CRM
      </p>
      <ul className="space-y-2">
        {matches.map((match) => <MatchRow key={`${match.kind}:${match.id}`} match={match} />)}
      </ul>
      <p className="text-xs text-muted-foreground">
        Open the existing record instead, or choose &ldquo;Create anyway&rdquo;. Records are never merged automatically.
      </p>
    </div>
  );
}

/** "+91 98200 11122" for Indian mobiles, E.164 otherwise. */
export function formatPhone(e164) {
  if (/^\+91\d{10}$/.test(e164)) return `+91 ${e164.slice(3, 8)} ${e164.slice(8)}`;
  return e164;
}

function buildBody(form, canContact) {
  const interest = {};
  if (form.course.trim()) interest.course = form.course.trim();
  if (form.schedule.trim()) interest.schedule = form.schedule.trim();
  return {
    learnerName: form.learnerName.trim(),
    ...(form.learnerGrade.trim() ? { learnerGrade: form.learnerGrade.trim() } : {}),
    ...(form.sourceKey ? { sourceKey: form.sourceKey } : {}),
    ...(canContact && form.phone.trim() ? {
      contact: { phone: form.phone.trim(), ...(form.parentName.trim() ? { name: form.parentName.trim() } : {}), whatsappOptIn: form.whatsappOptIn },
    } : {}),
    ...(Object.keys(interest).length ? { interest } : {}),
    ...(form.ownerUserId ? { ownerUserId: form.ownerUserId } : {}),
    ...(form.note.trim() ? { note: form.note.trim() } : {}),
  };
}

// Form field → schema path, for showing zod errors next to the right input.
const FIELD_PATHS = { learnerName: 'learnerName', phone: 'contact.phone', note: 'note' };

export default function NewLeadDialog({ open, onOpenChange, me, owners, onCreated }) {
  const [form, setForm] = useState(EMPTY);
  const [touched, setTouched] = useState({});
  const [matches, setMatches] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const checkSeq = useRef(0);
  const canContact = me.capabilities.includes('crm.contacts.write');

  useEffect(() => {
    if (!open) return;
    const mine = owners.find((owner) => owner.userId === me.user.id);
    setForm({ ...EMPTY, ownerUserId: mine ? mine.userId : '' });
    setTouched({});
    setMatches([]);
    setError(null);
  }, [open, owners, me.user.id]);

  const set = (key) => (event) => {
    const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
    setForm((current) => ({ ...current, [key]: value }));
  };
  const touch = (key) => () => setTouched((current) => ({ ...current, [key]: true }));

  // The same zod schema the server uses (shared/crm/leads.js).
  const body = buildBody(form, canContact);
  const parsed = createLeadBody.safeParse(body);
  const errors = fieldErrors(parsed);
  const errorFor = (key) => (touched[key] ? errors[FIELD_PATHS[key]] : undefined);
  const phoneE164 = canContact ? normalizePhone(form.phone) : null;
  const needsFollowUp = !body.contact && !body.note;

  // Debounced duplicate check; the phone joins only once it is valid.
  useEffect(() => {
    if (!open) return undefined;
    const learnerName = form.learnerName.trim();
    if (learnerName.length < 2 && !phoneE164) { setMatches([]); return undefined; }
    const seq = ++checkSeq.current;
    const timer = setTimeout(async () => {
      const params = new URLSearchParams();
      if (learnerName) params.set('learnerName', learnerName);
      if (phoneE164) params.set('phone', phoneE164);
      try {
        const result = await crmFetch(`leads/duplicates?${params}`);
        if (seq === checkSeq.current) setMatches(result.matches || []);
      } catch {
        // The server re-checks on create; a failed preview is not fatal.
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [open, form.learnerName, phoneE164]);

  const submit = async (event) => {
    event.preventDefault();
    setTouched({ learnerName: true, phone: true, note: true });
    if (!parsed.success) return;
    setBusy(true);
    setError(null);
    try {
      // Visible matches mean staff chose to create anyway.
      const payload = matches.length ? { ...body, acknowledgeDuplicates: true } : body;
      const lead = await crmFetch('leads', { method: 'POST', body: payload, idempotencyKey: newIdempotencyKey() });
      // The server also created the owner's follow-up task.
      notifyTasksChanged();
      onCreated(lead);
    } catch (err) {
      if (err.code === 'duplicate_warning') setMatches(err.details?.matches || []);
      else setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New lead</DialogTitle>
          <DialogDescription>Record an inquiry. It starts in the first stage of your pipeline.</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit} noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Student name" htmlFor="lead-name" error={errorFor('learnerName')}>
              <Input id="lead-name" maxLength={120} value={form.learnerName} onChange={set('learnerName')} onBlur={touch('learnerName')} autoFocus />
            </Field>
            <Field label="Grade / class" htmlFor="lead-grade">
              <Input id="lead-grade" maxLength={32} value={form.learnerGrade} onChange={set('learnerGrade')} placeholder="e.g. 9" />
            </Field>
            {canContact && (
              <>
                <Field label="Parent name" htmlFor="lead-parent">
                  <Input id="lead-parent" maxLength={120} value={form.parentName} onChange={set('parentName')} />
                </Field>
                <Field
                  label="Parent phone"
                  htmlFor="lead-phone"
                  error={errorFor('phone')}
                  hint={phoneE164 ? `Will be saved as ${formatPhone(phoneE164)}` : undefined}
                >
                  <Input id="lead-phone" type="tel" inputMode="tel" maxLength={24} value={form.phone} onChange={set('phone')} onBlur={touch('phone')} placeholder="98200 11122" />
                </Field>
                <label className="flex items-center gap-2 text-sm sm:col-span-2">
                  <input type="checkbox" checked={form.whatsappOptIn} onChange={set('whatsappOptIn')} className="h-4 w-4" />
                  Parent agreed to WhatsApp updates about the child’s classes, fees and progress
                </label>
              </>
            )}
            <Field label="Course interest" htmlFor="lead-course">
              <Input id="lead-course" maxLength={120} value={form.course} onChange={set('course')} placeholder="e.g. Grade 10 Maths" />
            </Field>
            <Field label="Preferred schedule" htmlFor="lead-schedule">
              <Input id="lead-schedule" maxLength={120} value={form.schedule} onChange={set('schedule')} placeholder="e.g. Weekday evenings" />
            </Field>
            <Field label="Source" htmlFor="lead-source">
              <Select id="lead-source" value={form.sourceKey} onChange={set('sourceKey')}>
                <option value="">Not recorded</option>
                {DEFAULT_LEAD_SOURCES.map((source) => <option key={source.key} value={source.key}>{source.label}</option>)}
              </Select>
            </Field>
            <Field label="Owner" htmlFor="lead-owner">
              <Select id="lead-owner" value={form.ownerUserId} onChange={set('ownerUserId')}>
                {!owners.some((owner) => owner.userId === me.user.id) && <option value="">{me.support ? 'Unowned' : 'Me'}</option>}
                {owners.map((owner) => <option key={owner.userId} value={owner.userId}>{owner.userId === me.user.id ? `${owner.name} (me)` : owner.name}</option>)}
              </Select>
            </Field>
          </div>
          <Field
            label="Note"
            htmlFor="lead-note"
            error={errorFor('note')}
            hint={needsFollowUp ? (canContact ? 'Add a parent phone or a note so the lead can be followed up.' : 'Without contact access, add a note so the lead can be followed up.') : undefined}
          >
            <Textarea id="lead-note" maxLength={2000} value={form.note} onChange={set('note')} onBlur={touch('note')} />
          </Field>
          <DuplicatePanel matches={matches} />
          {error && <Alert variant="destructive"><AlertDescription>{error.message}</AlertDescription></Alert>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={busy || !parsed.success}>
              {matches.length ? 'Create anyway' : 'Create lead'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
