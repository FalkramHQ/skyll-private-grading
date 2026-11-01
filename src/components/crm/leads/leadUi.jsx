// Small pieces shared by the leads board, list and profile (FLKRM-326 S1).
import * as React from 'react';
import { useState } from 'react';
import { Alert, AlertDescription } from '../../ui/Alert';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../ui/Dialog';
import { Select } from '../../ui/Select';
import { cn } from '../../../lib/utils';
import { LOST_REASONS, lostReasonLabel } from '../../../../shared/crm/leads.js';
import { nextStates } from '../../../../shared/crm/lifecycles.js';
import { STAGE_CATEGORY } from '../stageCategories';

export const Textarea = React.forwardRef(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      'flex min-h-[80px] w-full rounded-lg border border-input bg-card px-3 py-2 text-sm text-foreground ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
      className,
    )}
    {...props}
  />
));
Textarea.displayName = 'Textarea';

/** Label + control + hint or error. The error is linked to the control for screen readers. */
export function Field({ label, htmlFor, hint, error, children }) {
  const messageId = htmlFor ? `${htmlFor}-message` : undefined;
  const control = React.isValidElement(children) && (error || hint)
    ? React.cloneElement(children, { 'aria-invalid': error ? true : undefined, 'aria-describedby': messageId })
    : children;
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium text-foreground">{label}</label>
      {control}
      {error
        ? <p id={messageId} className="text-xs text-destructive">{error}</p>
        : hint && <p id={messageId} className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function StageBadge({ category, children }) {
  const meta = STAGE_CATEGORY[category] || STAGE_CATEGORY.open;
  return <Badge variant={meta.variant}>{children ?? meta.label}</Badge>;
}

const dateFormat = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
const dateTimeFormat = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

export function formatDate(iso) {
  return iso ? dateFormat.format(new Date(iso)) : '';
}

export function formatDateTime(iso) {
  return iso ? dateTimeFormat.format(new Date(iso)) : '';
}

/** "today", "3d ago" — how long a lead has been quiet. */
export function sinceLabel(iso, now = Date.now()) {
  if (!iso) return '';
  const days = Math.floor((now - Date.parse(iso)) / 86_400_000);
  if (days <= 0) return 'today';
  return `${days}d ago`;
}

export function lostLabel(lead) {
  if (!lead.lostReasonKey) return lead.lostReason || null;
  return [lostReasonLabel(lead.lostReasonKey), lead.lostReason].filter(Boolean).join(': ');
}

/** Stages a lead may move to. Enrolled is reachable only through conversion. */
export function moveTargets(lead, stages) {
  const categories = new Set(nextStates('leadStage', lead.stage.category).filter((category) => category !== 'won'));
  return stages.filter((stage) => stage.id !== lead.stage.id && !stage.archivedAt && categories.has(stage.category));
}

export function MoveToSelect({ lead, stages, disabled, onMove, className }) {
  const targets = moveTargets(lead, stages);
  if (!targets.length) return null;
  return (
    <Select
      aria-label={`Move ${lead.learnerName} to stage`}
      className={cn('h-8 text-xs', className)}
      value=""
      disabled={disabled}
      // Keep board drag gestures from starting on the menu.
      onPointerDown={(event) => event.stopPropagation()}
      onChange={(event) => {
        const stage = targets.find((item) => item.id === event.target.value);
        if (stage) onMove(lead, stage);
      }}
    >
      <option value="">Move to…</option>
      {targets.map((stage) => <option key={stage.id} value={stage.id}>{stage.name}</option>)}
    </Select>
  );
}

/** Asks why a lead was lost: a reason from the list, plus an optional note. */
export function LostDialog({ lead, stage, busy, error, onCancel, onConfirm }) {
  const [reasonKey, setReasonKey] = useState('');
  const [note, setNote] = useState('');
  const needsNote = reasonKey === 'other' && !note.trim();
  return (
    <Dialog open={Boolean(lead)} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mark {lead?.learnerName} as {stage?.name || 'lost'}</DialogTitle>
          <DialogDescription>The reason is used in admissions reports. Don&apos;t include personal details in the note.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (reasonKey && !needsNote) onConfirm({ lostReasonKey: reasonKey, reason: note.trim() || undefined });
          }}
        >
          <Field label="Reason" htmlFor="lost-reason">
            <Select id="lost-reason" value={reasonKey} onChange={(event) => setReasonKey(event.target.value)} required>
              <option value="">Choose a reason</option>
              {LOST_REASONS.map((reason) => <option key={reason.key} value={reason.key}>{reason.label}</option>)}
            </Select>
          </Field>
          <Field label={reasonKey === 'other' ? 'Note (required)' : 'Note (optional)'} htmlFor="lost-note">
            <Textarea id="lost-note" maxLength={280} value={note} onChange={(event) => setNote(event.target.value)} />
          </Field>
          {error && <Alert variant="destructive"><AlertDescription>{error.message}</AlertDescription></Alert>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
            <Button type="submit" variant="destructive" disabled={busy || !reasonKey || needsNote}>Mark as lost</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
