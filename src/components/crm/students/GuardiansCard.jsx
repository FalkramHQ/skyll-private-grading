// Guardians for one student (CRM-008, FLKRM-326 S4, D15). Shown only with
// contact access; changes need contact write access. The server enforces the
// rules (one primary, at most one fee payer, primary can't be removed while
// others remain); the UI explains them.
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Mail, Phone, Plus } from 'lucide-react';
import { Alert, AlertDescription } from '../../ui/Alert';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/Card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../ui/Dialog';
import { Input } from '../../ui/Input';
import { Select } from '../../ui/Select';
import { Skeleton } from '../../ui/Skeleton';
import { crmFetch, newIdempotencyKey } from '../../../lib/crm/api';
import { CHANNELS, CONSENT_SOURCES, RELATIONSHIPS, addGuardianBody, relationshipLabel } from '../../../../shared/crm/guardians.js';
import { fieldErrors } from '../../../../shared/crm/leads.js';
import { normalizePhone } from '../../../../shared/phone.js';
import { Field, formatDate } from '../leads/leadUi';
import { formatPhone } from '../leads/NewLeadDialog';

function Checkbox({ label, checked, onChange, hint }) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" className="mt-0.5 h-4 w-4" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>
        {label}
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
    </label>
  );
}

function consentLine(contact) {
  if (!contact.whatsappOptIn) return contact.consentSource === 'whatsapp_stop' ? `Opted out by replying STOP${contact.consentAt ? ` · ${formatDate(contact.consentAt)}` : ''}` : 'No WhatsApp consent';
  const source = CONSENT_SOURCES[contact.consentSource];
  return ['WhatsApp consent', contact.consentAt && formatDate(contact.consentAt), source].filter(Boolean).join(' · ');
}

async function post(path, body) {
  return crmFetch(path, { method: 'POST', body, idempotencyKey: newIdempotencyKey() });
}

function AddGuardianDialog({ open, studentId, first, onClose, onSaved }) {
  const blank = { phone: '', name: '', email: '', relationship: 'mother', isEmergency: false, isFeePayer: first, whatsappOptIn: false };
  const [form, setForm] = useState(blank);
  const [touched, setTouched] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (key) => (value) => setForm((current) => ({ ...current, [key]: value }));
  const body = {
    studentId,
    contact: {
      phone: form.phone.trim(),
      ...(form.name.trim() ? { name: form.name.trim() } : {}),
      ...(form.email.trim() ? { email: form.email.trim() } : {}),
      whatsappOptIn: form.whatsappOptIn,
    },
    relationship: form.relationship,
    isEmergency: form.isEmergency,
    isFeePayer: form.isFeePayer,
  };
  const parsed = addGuardianBody.safeParse(body);
  const errors = fieldErrors(parsed);
  const phone = normalizePhone(form.phone);

  const submit = async (event) => {
    event.preventDefault();
    setTouched({ phone: true, email: true });
    if (!parsed.success) return;
    setBusy(true);
    setError(null);
    try {
      onSaved(await post('students/guardians', body));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add guardian</DialogTitle>
          <DialogDescription>
            {first ? 'The first guardian becomes the primary contact.' : 'If this phone already belongs to a parent in your school, that contact is reused.'}
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit} noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Phone" htmlFor="guardian-phone" error={touched.phone ? errors['contact.phone'] : undefined} hint={phone ? `Will be saved as ${formatPhone(phone)}` : undefined}>
              <Input id="guardian-phone" type="tel" inputMode="tel" maxLength={24} value={form.phone} onChange={(event) => set('phone')(event.target.value)} onBlur={() => setTouched((t) => ({ ...t, phone: true }))} autoFocus />
            </Field>
            <Field label="Name" htmlFor="guardian-name">
              <Input id="guardian-name" maxLength={120} value={form.name} onChange={(event) => set('name')(event.target.value)} />
            </Field>
            <Field label="Email (optional)" htmlFor="guardian-email" error={touched.email ? errors['contact.email'] : undefined}>
              <Input id="guardian-email" type="email" maxLength={160} value={form.email} onChange={(event) => set('email')(event.target.value)} onBlur={() => setTouched((t) => ({ ...t, email: true }))} />
            </Field>
            <Field label="Relationship" htmlFor="guardian-relationship">
              <Select id="guardian-relationship" value={form.relationship} onChange={(event) => set('relationship')(event.target.value)}>
                {RELATIONSHIPS.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
              </Select>
            </Field>
          </div>
          <div className="space-y-2">
            <Checkbox label="Emergency contact" checked={form.isEmergency} onChange={set('isEmergency')} />
            <Checkbox label="Pays the fees" hint="Only one guardian can be the fee payer." checked={form.isFeePayer} onChange={set('isFeePayer')} />
            <Checkbox label="Agreed to WhatsApp updates about the child’s classes, fees and progress" checked={form.whatsappOptIn} onChange={set('whatsappOptIn')} />
          </div>
          {error && <Alert variant="destructive"><AlertDescription>{error.message}</AlertDescription></Alert>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={busy || !parsed.success}>Add guardian</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditGuardianDialog({ guardian, onClose, onSaved }) {
  const { contact } = guardian;
  const [form, setForm] = useState({
    relationship: guardian.relationship,
    isEmergency: guardian.isEmergency,
    isFeePayer: guardian.isFeePayer,
    name: contact.name || '',
    phone: contact.phone || '',
    email: contact.email || '',
    preferredChannel: contact.preferredChannel,
    whatsappOptIn: contact.whatsappOptIn,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (key) => (value) => setForm((current) => ({ ...current, [key]: value }));
  const phoneValid = Boolean(normalizePhone(form.phone));

  const linkChanges = {};
  for (const key of ['relationship', 'isEmergency', 'isFeePayer']) if (form[key] !== guardian[key]) linkChanges[key] = form[key];
  const contactChanges = {};
  if (form.name.trim() !== (contact.name || '')) contactChanges.name = form.name.trim() || null;
  if (normalizePhone(form.phone) !== contact.phone) contactChanges.phone = form.phone.trim();
  if (form.email.trim() !== (contact.email || '')) contactChanges.email = form.email.trim() || null;
  if (form.preferredChannel !== contact.preferredChannel) contactChanges.preferredChannel = form.preferredChannel;
  if (form.whatsappOptIn !== contact.whatsappOptIn) contactChanges.whatsappOptIn = form.whatsappOptIn;
  const changed = Object.keys(linkChanges).length || Object.keys(contactChanges).length;

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (Object.keys(contactChanges).length) await post('contacts/update', { contactId: contact.id, expectedVersion: contact.version, ...contactChanges });
      if (Object.keys(linkChanges).length) await post('students/guardians/update', { linkId: guardian.linkId, expectedVersion: guardian.version, ...linkChanges });
      onSaved();
    } catch (err) {
      setError(err.code === 'version_conflict' ? new Error('Someone else changed this guardian. Close and try again.') : err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(value) => { if (!value) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit guardian</DialogTitle>
          <DialogDescription>{contact.name || contact.phone}</DialogDescription>
        </DialogHeader>
        {guardian.alsoGuardianOf.length > 0 && (
          <div role="note" className="rounded-lg border border-border border-l-4 border-l-warning-soft-foreground bg-background p-3 text-sm">
            Also guardian of {guardian.alsoGuardianOf.map((student) => student.name).join(', ')}. Name, phone, email and consent changes apply to them too.
          </div>
        )}
        <form className="space-y-4" onSubmit={submit}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" htmlFor="edit-guardian-name">
              <Input id="edit-guardian-name" maxLength={120} value={form.name} onChange={(event) => set('name')(event.target.value)} />
            </Field>
            <Field label="Phone" htmlFor="edit-guardian-phone" error={phoneValid ? undefined : 'Enter a valid mobile number, e.g. 98200 11122'}>
              <Input id="edit-guardian-phone" type="tel" maxLength={24} value={form.phone} onChange={(event) => set('phone')(event.target.value)} />
            </Field>
            <Field label="Email" htmlFor="edit-guardian-email">
              <Input id="edit-guardian-email" type="email" maxLength={160} value={form.email} onChange={(event) => set('email')(event.target.value)} />
            </Field>
            <Field label="Prefers" htmlFor="edit-guardian-channel">
              <Select id="edit-guardian-channel" value={form.preferredChannel} onChange={(event) => set('preferredChannel')(event.target.value)}>
                {CHANNELS.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
              </Select>
            </Field>
            <Field label="Relationship" htmlFor="edit-guardian-relationship">
              <Select id="edit-guardian-relationship" value={form.relationship} onChange={(event) => set('relationship')(event.target.value)}>
                {RELATIONSHIPS.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
              </Select>
            </Field>
          </div>
          <div className="space-y-2">
            <Checkbox label="Emergency contact" checked={form.isEmergency} onChange={set('isEmergency')} />
            <Checkbox label="Pays the fees" hint="Choosing this moves the fee payer from anyone else." checked={form.isFeePayer} onChange={set('isFeePayer')} />
            <Checkbox label="Agreed to WhatsApp updates about the child’s classes, fees and progress" hint="Unticking records that consent was withdrawn. Parents can also reply STOP." checked={form.whatsappOptIn} onChange={set('whatsappOptIn')} />
          </div>
          {error && <Alert variant="destructive"><AlertDescription>{error.message}</AlertDescription></Alert>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={busy || !changed || !phoneValid}>Save</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function GuardianRow({ guardian, canWrite, onlyOne, busy, onEdit, onPrimary, onRemove }) {
  const [confirming, setConfirming] = useState(false);
  const { contact } = guardian;
  const blockRemove = guardian.isPrimary && !onlyOne;
  return (
    <li className="space-y-2 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-foreground">{contact.name || 'Name not recorded'}</span>
        <span className="text-xs text-muted-foreground">{relationshipLabel(guardian.relationship)}</span>
        {guardian.isPrimary && <Badge>Primary</Badge>}
        {guardian.isEmergency && <Badge variant="warning">Emergency</Badge>}
        {guardian.isFeePayer && <Badge variant="secondary">Fee payer</Badge>}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        {contact.phone && (
          <a href={`tel:${contact.phone}`} className="inline-flex items-center gap-1 text-accent hover:underline"><Phone className="h-3.5 w-3.5" aria-hidden="true" />{contact.phone}</a>
        )}
        {contact.email && (
          <a href={`mailto:${contact.email}`} className="inline-flex items-center gap-1 text-accent hover:underline"><Mail className="h-3.5 w-3.5" aria-hidden="true" />{contact.email}</a>
        )}
        <span className="text-xs text-muted-foreground">Prefers {CHANNELS.find((item) => item.key === contact.preferredChannel)?.label || 'WhatsApp'}</span>
      </div>
      <p className="text-xs text-muted-foreground">{consentLine(contact)}</p>
      {guardian.alsoGuardianOf.length > 0 && (
        <p className="text-xs text-muted-foreground">Also guardian of {guardian.alsoGuardianOf.map((student) => student.name).join(', ')}</p>
      )}
      {canWrite && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy} onClick={() => onEdit(guardian)}>Edit</Button>
          {!guardian.isPrimary && <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy} onClick={() => onPrimary(guardian)}>Make primary</Button>}
          {!confirming && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs text-destructive"
              disabled={busy || blockRemove}
              title={blockRemove ? 'Make another guardian primary first' : undefined}
              onClick={() => setConfirming(true)}
            >
              Remove
            </Button>
          )}
          {confirming && (
            <span className="flex items-center gap-2 text-xs" role="group" aria-label="Confirm removal">
              Remove {contact.name || 'this guardian'} from this student? The contact is kept.
              <Button size="sm" variant="destructive" className="h-7 px-2 text-xs" disabled={busy} onClick={() => onRemove(guardian)}>Remove</Button>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={busy} onClick={() => setConfirming(false)}>Keep</Button>
            </span>
          )}
          {blockRemove && <span className="text-xs text-muted-foreground">Make another guardian primary before removing.</span>}
        </div>
      )}
    </li>
  );
}

/** `onChanged()` runs after any guardian write, e.g. to refresh the timeline. */
export default function GuardiansCard({ studentId, me, onChanged }) {
  const canWrite = me.capabilities.includes('crm.contacts.write');
  const [state, setState] = useState({ status: 'loading', items: [], error: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);

  const load = useCallback(async () => {
    try {
      const result = await crmFetch(`students/guardians?${new URLSearchParams({ studentId })}`);
      setState({ status: 'ready', items: result.items, error: null });
    } catch (err) {
      setState({ status: 'error', items: [], error: err });
    }
  }, [studentId]);

  useEffect(() => { load(); }, [load]);

  const changed = async () => { await load(); onChanged?.(); };
  const run = async (path, body) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await post(path, body);
      await changed();
    } catch (err) {
      setError(err);
      if (err.code === 'version_conflict') await load();
    } finally {
      setBusy(false);
    }
  };

  const guardians = state.items;
  const noEmergency = guardians.length > 0 && !guardians.some((g) => g.isEmergency);
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">Guardians</CardTitle>
        {canWrite && (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus className="mr-1 h-4 w-4" aria-hidden="true" />Add
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {state.status === 'loading' && <Skeleton className="h-20 w-full" />}
        {state.status === 'error' && <Alert variant="destructive"><AlertDescription>{state.error.message}</AlertDescription></Alert>}
        {error && <Alert variant="destructive"><AlertDescription>{error.message}</AlertDescription></Alert>}
        {notice && <Alert variant="success"><AlertDescription>{notice}</AlertDescription></Alert>}
        {state.status === 'ready' && !guardians.length && (
          <p className="flex items-center gap-2 text-sm text-warning-soft-foreground"><AlertTriangle className="h-4 w-4" aria-hidden="true" />No guardian on file.</p>
        )}
        {noEmergency && <p className="text-xs text-muted-foreground">No emergency contact is marked.</p>}
        {guardians.length > 0 && (
          <ul className="divide-y divide-border">
            {guardians.map((guardian) => (
              <GuardianRow
                key={`${guardian.linkId}:${guardian.version}`}
                guardian={guardian}
                canWrite={canWrite}
                onlyOne={guardians.length === 1}
                busy={busy}
                onEdit={setEditing}
                onPrimary={(g) => run('students/guardians/primary', { linkId: g.linkId, expectedVersion: g.version })}
                onRemove={(g) => run('students/guardians/remove', { linkId: g.linkId, expectedVersion: g.version })}
              />
            ))}
          </ul>
        )}
      </CardContent>
      {adding && (
        <AddGuardianDialog
          open
          studentId={studentId}
          first={!guardians.length}
          onClose={() => setAdding(false)}
          onSaved={async (result) => {
            setAdding(false);
            if (result.reusedContact) setNotice(`Linked the existing contact ${result.reusedContact.name || result.guardian.contact.phone}.`);
            await changed();
          }}
        />
      )}
      {editing && <EditGuardianDialog guardian={editing} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); setNotice(null); await changed(); }} />}
    </Card>
  );
}
