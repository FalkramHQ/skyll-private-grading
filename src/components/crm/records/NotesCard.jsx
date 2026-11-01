// Notes on a lead or student (FLKRM-326 S3, D14). The author can edit; the
// author or an admin can remove (after a confirm). Validation uses the same zod
// rule as the server.
import { useCallback, useEffect, useState } from 'react';
import { Alert, AlertDescription } from '../../ui/Alert';
import { Button } from '../../ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/Card';
import { Skeleton } from '../../ui/Skeleton';
import { crmFetch, newIdempotencyKey } from '../../../lib/crm/api';
import { NOTE_MAX, noteBodyField } from '../../../../shared/crm/notes.js';
import { Textarea, formatDateTime } from '../leads/leadUi';

function NoteItem({ note, busy, onEdit, onRemove }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.body);
  const [confirming, setConfirming] = useState(false);
  const valid = noteBodyField.safeParse(draft).success && draft.trim() !== note.body;

  return (
    <li className="space-y-1.5 py-3">
      {editing ? (
        <form
          className="space-y-2"
          onSubmit={async (event) => {
            event.preventDefault();
            if (valid && await onEdit(note, draft.trim())) setEditing(false);
          }}
        >
          <Textarea aria-label="Edit note" maxLength={NOTE_MAX} value={draft} onChange={(event) => setDraft(event.target.value)} autoFocus />
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => { setDraft(note.body); setEditing(false); }}>Cancel</Button>
            <Button type="submit" size="sm" disabled={busy || !valid}>Save</Button>
          </div>
        </form>
      ) : (
        <p className="whitespace-pre-wrap text-sm text-foreground">{note.body}</p>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>{[note.author?.name, formatDateTime(note.createdAt)].filter(Boolean).join(' · ')}</span>
        {note.edited && <span>(edited)</span>}
        {!editing && !confirming && note.canEdit && (
          <button type="button" className="text-accent hover:underline" onClick={() => setEditing(true)}>Edit</button>
        )}
        {!editing && !confirming && note.canRemove && (
          <button type="button" className="text-destructive hover:underline" onClick={() => setConfirming(true)}>Remove</button>
        )}
        {confirming && (
          <span className="flex items-center gap-2" role="group" aria-label="Confirm removal">
            <span className="text-foreground">Remove this note?</span>
            <Button size="sm" variant="destructive" className="h-6 px-2 text-xs" disabled={busy} onClick={() => onRemove(note)}>Remove</Button>
            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" disabled={busy} onClick={() => setConfirming(false)}>Keep</Button>
          </span>
        )}
      </div>
    </li>
  );
}

/** `onChanged()` runs after any note write, e.g. to refresh the timeline. */
export default function NotesCard({ entityType, entityId, canWrite, onChanged }) {
  const [state, setState] = useState({ status: 'loading', notes: [], error: null });
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const result = await crmFetch(`notes?${new URLSearchParams({ entityType, entityId })}`);
      setState({ status: 'ready', notes: result.items, error: null });
    } catch (err) {
      setState({ status: 'error', notes: [], error: err });
    }
  }, [entityType, entityId]);

  useEffect(() => { load(); }, [load]);

  const write = async (path, body) => {
    setBusy(true);
    setError(null);
    try {
      await crmFetch(path, { method: 'POST', body, idempotencyKey: newIdempotencyKey() });
      await load();
      onChanged?.();
      return true;
    } catch (err) {
      setError(err.code === 'version_conflict' ? new Error('This note was changed by someone else. The latest version is shown.') : err);
      if (err.code === 'version_conflict' || err.status === 404) await load();
      return false;
    } finally {
      setBusy(false);
    }
  };

  const valid = noteBodyField.safeParse(draft).success;
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Notes</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {canWrite && (
          <form
            className="space-y-2"
            onSubmit={async (event) => {
              event.preventDefault();
              if (valid && await write('notes', { entityType, entityId, body: draft.trim() })) setDraft('');
            }}
          >
            <Textarea aria-label="New note" placeholder="Add a note for the team…" maxLength={NOTE_MAX} value={draft} onChange={(event) => setDraft(event.target.value)} />
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">Visible to everyone who can open this record. Don&apos;t include phone numbers or addresses.</span>
              <Button type="submit" size="sm" disabled={busy || !valid}>Add note</Button>
            </div>
          </form>
        )}
        {error && <Alert variant="destructive"><AlertDescription>{error.message}</AlertDescription></Alert>}
        {state.status === 'loading' && <Skeleton className="h-16 w-full" />}
        {state.status === 'error' && <Alert variant="destructive"><AlertDescription>{state.error.message}</AlertDescription></Alert>}
        {state.status === 'ready' && (state.notes.length
          ? (
            <ul className="divide-y divide-border">
              {state.notes.map((note) => (
                <NoteItem
                  key={`${note.id}:${note.version}`}
                  note={note}
                  busy={busy}
                  onEdit={(item, body) => write('notes/update', { noteId: item.id, body, expectedVersion: item.version })}
                  onRemove={(item) => write('notes/remove', { noteId: item.id, expectedVersion: item.version })}
                />
              ))}
            </ul>
          )
          : <p className="text-sm text-muted-foreground">No notes yet.</p>)}
      </CardContent>
    </Card>
  );
}
