// Classes → Rooms (FLKRM-327 S1, D7/D12): the room list the timetable uses for
// clash checks. Archived rooms stay on past sessions but can't be chosen again.
import { useCallback, useEffect, useState } from 'react';
import { Alert, AlertDescription } from '../../ui/Alert';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/Card';
import { Input } from '../../ui/Input';
import { Skeleton } from '../../ui/Skeleton';
import { crmFetch } from '../../../lib/crm/api';
import { classesWrite, numberOrNull } from '../../../lib/crm/classes';
import { roomBody } from '../../../../shared/crm/classes.js';
import { fieldErrors } from '../../../../shared/crm/leads.js';

function RoomForm({ initial, submitLabel, onSubmit, onCancel }) {
  const [name, setName] = useState(initial?.name || '');
  const [seats, setSeats] = useState(initial?.seats ? String(initial.seats) : '');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const body = { name: name.trim(), seats: numberOrNull(seats) };
  const parsed = roomBody.safeParse(body);
  const errors = touched ? fieldErrors(parsed) : {};

  const submit = async (event) => {
    event.preventDefault();
    setTouched(true);
    if (!parsed.success) return;
    setBusy(true);
    try {
      if (await onSubmit(body)) { setName(''); setSeats(''); setTouched(false); }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="flex flex-wrap items-start gap-2" onSubmit={submit} noValidate>
      <div className="min-w-[10rem] flex-1">
        <Input aria-label="Room name" placeholder="Room name" maxLength={60} value={name} onChange={(event) => setName(event.target.value)} aria-invalid={errors.name ? true : undefined} />
        {errors.name && <p className="mt-1 text-xs text-destructive">{errors.name}</p>}
      </div>
      <div className="w-28">
        <Input aria-label="Seats" placeholder="Seats" type="number" min={1} max={1000} inputMode="numeric" value={seats} onChange={(event) => setSeats(event.target.value)} aria-invalid={errors.seats ? true : undefined} />
        {errors.seats && <p className="mt-1 text-xs text-destructive">{errors.seats}</p>}
      </div>
      <Button type="submit" disabled={busy}>{submitLabel}</Button>
      {onCancel && <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>}
    </form>
  );
}

export default function RoomsTab({ me, onOptionsChanged }) {
  const canWrite = me.capabilities.includes('crm.classes.write');
  const [state, setState] = useState({ status: 'loading', items: [], error: null });
  const [editingId, setEditingId] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      setState({ status: 'ready', items: (await crmFetch('classes/rooms?status=all')).items, error: null });
    } catch (err) {
      setState({ status: 'error', items: [], error: err });
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const write = async (path, body) => {
    setError(null);
    try {
      await classesWrite(path, body);
      await load();
      onOptionsChanged?.();
      return true;
    } catch (err) {
      setError(err);
      if (err.code === 'version_conflict') await load();
      return false;
    }
  };

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle className="text-base">Rooms</CardTitle>
        <CardDescription>Rooms used on the timetable. Two classes can&apos;t share a room at the same time without a warning.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <Alert variant="destructive"><AlertDescription>{error.message}</AlertDescription></Alert>}
        {state.status === 'loading' && <Skeleton className="h-24 w-full" />}
        {state.status === 'error' && <Alert variant="destructive"><AlertDescription>{state.error.message}</AlertDescription></Alert>}
        {state.status === 'ready' && !state.items.length && <p className="text-sm text-muted-foreground">No rooms yet.</p>}
        {state.items.length > 0 && (
          <ul className="divide-y divide-border">
            {state.items.map((room) => (
              <li key={room.id} className="py-2">
                {editingId === room.id
                  ? (
                    <RoomForm
                      initial={room}
                      submitLabel="Save"
                      onCancel={() => setEditingId(null)}
                      onSubmit={async (body) => {
                        const ok = await write('classes/rooms/update', { roomId: room.id, expectedVersion: room.version, ...body });
                        if (ok) setEditingId(null);
                        return ok;
                      }}
                    />
                  )
                  : (
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className={room.status === 'active' ? 'font-medium' : 'text-muted-foreground'}>{room.name}</span>
                      <span className="text-xs text-muted-foreground">{room.seats ? `${room.seats} seats` : 'Seats not set'}</span>
                      {room.status !== 'active' && <Badge variant="secondary">Archived</Badge>}
                      {canWrite && (
                        <span className="ml-auto flex gap-1">
                          {room.status === 'active' && <Button size="sm" variant="ghost" onClick={() => setEditingId(room.id)}>Edit</Button>}
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-muted-foreground"
                            onClick={() => write(room.status === 'active' ? 'classes/rooms/archive' : 'classes/rooms/restore', { roomId: room.id, expectedVersion: room.version })}
                          >
                            {room.status === 'active' ? 'Archive' : 'Restore'}
                          </Button>
                        </span>
                      )}
                    </div>
                  )}
              </li>
            ))}
          </ul>
        )}
        {canWrite && <RoomForm submitLabel="Add room" onSubmit={(body) => write('classes/rooms', body)} />}
      </CardContent>
    </Card>
  );
}
