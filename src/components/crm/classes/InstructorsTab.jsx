// Classes → Instructors (FLKRM-327 S2): everyone who can teach, the batches
// they're assigned to, and their weekly hours and next leave.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarClock } from 'lucide-react';
import { Alert, AlertDescription } from '../../ui/Alert';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Skeleton } from '../../ui/Skeleton';
import { crmFetch } from '../../../lib/crm/api';
import { formatDay } from '../../../lib/crm/classes';
import AvailabilityDialog from './AvailabilityDialog';

const ROLE_LABELS = { admin: 'Admin', teacher: 'Teacher' };

function nextLeaveLabel(leave) {
  if (!leave) return null;
  return leave.startsOn === leave.endsOn ? `${leave.reason} · ${formatDay(leave.startsOn)}` : `${leave.reason} · ${formatDay(leave.startsOn)} – ${formatDay(leave.endsOn)}`;
}

export default function InstructorsTab({ me }) {
  const [state, setState] = useState({ status: 'loading', items: [], error: null });
  const [editing, setEditing] = useState(null);

  const load = useCallback(async () => {
    try {
      setState({ status: 'ready', items: (await crmFetch('classes/instructors')).items, error: null });
    } catch (error) {
      setState({ status: 'error', items: [], error });
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const mine = state.items.find((person) => person.userId === me.user.id);
  return (
    <div className="space-y-4">
      {mine && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4 text-sm">
          <CalendarClock className="h-5 w-5 text-accent" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">Your availability</p>
            <p className="text-muted-foreground">{mine.availability.summary}{mine.availability.nextLeave ? ` · Next: ${nextLeaveLabel(mine.availability.nextLeave)}` : ''}</p>
          </div>
          <Button variant="outline" onClick={() => setEditing(me.user.id)}>Edit my availability</Button>
        </div>
      )}
      {state.status === 'loading' && <Skeleton className="h-48 w-full" />}
      {state.status === 'error' && <Alert variant="destructive"><AlertDescription>{state.error.message}</AlertDescription></Alert>}
      {state.status === 'ready' && !state.items.length && <p className="text-sm text-muted-foreground">No teachers or admins yet.</p>}
      {state.status === 'ready' && state.items.length > 0 && (
        <Card>
          <ul className="divide-y divide-border text-sm">
            {state.items.map((person) => (
              <li key={person.userId} className="flex flex-wrap items-start gap-x-4 gap-y-2 p-4">
                <div className="w-full min-w-0 sm:w-48">
                  <p className="font-medium">{person.name || 'Unnamed'}</p>
                  <p className="text-xs text-muted-foreground">{ROLE_LABELS[person.role] || person.role}</p>
                </div>
                <div className="min-w-0 flex-1 space-y-1">
                  {person.assignments.length
                    ? (
                      <ul className="flex flex-wrap gap-1.5">
                        {person.assignments.map((assignment) => (
                          <li key={assignment.id}>
                            <Link to={`/crm/classes/batches/${assignment.batchId}`} className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-0.5 text-xs hover:bg-muted">
                              {assignment.batchName}{assignment.subject ? ` · ${assignment.subject.name}` : ''}
                              {assignment.isLead && <span className="font-semibold text-accent">Lead</span>}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    )
                    : <p className="text-xs text-muted-foreground">Not assigned to a batch</p>}
                  <p className="text-xs text-muted-foreground">{person.availability.summary}</p>
                  {person.availability.nextLeave && <Badge variant="warning">{nextLeaveLabel(person.availability.nextLeave)}</Badge>}
                </div>
                <Button size="sm" variant="ghost" onClick={() => setEditing(person.userId)}>
                  {person.canEditAvailability ? 'Availability' : 'View availability'}
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <AvailabilityDialog open={Boolean(editing)} onOpenChange={(open) => !open && setEditing(null)} userId={editing} me={me} onChanged={load} />
    </div>
  );
}
