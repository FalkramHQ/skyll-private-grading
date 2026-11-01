// Overview → Today's classes (FLKRM-327 D13): teachers see their own; people
// who manage classes see the whole school.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/Card';
import { Skeleton } from '../../ui/Skeleton';
import { crmFetch } from '../../../lib/crm/api';
import { localDate } from '../../../../shared/crm/time.js';
import SessionCard from './SessionCard';

const SHOWN = 6;

export default function TodaysClasses({ me }) {
  const mine = !me.capabilities.includes('crm.classes.write');
  const [state, setState] = useState({ status: 'loading', items: [] });
  const [waiting, setWaiting] = useState(null);
  const canSeeAttendance = me.capabilities.includes('crm.attendance.read');

  useEffect(() => {
    if (!canSeeAttendance) return;
    crmFetch('attendance/pending').then((page) => setWaiting(page.items.length)).catch(() => setWaiting(null));
  }, [canSeeAttendance]);

  useEffect(() => {
    const today = localDate(Date.now(), me.school.timezone);
    const params = new URLSearchParams({ from: today, to: today });
    if (mine) params.set('mine', '1');
    crmFetch(`classes/sessions?${params}`)
      .then((page) => setState({ status: 'ready', items: page.items }))
      .catch(() => setState({ status: 'error', items: [] }));
  }, [mine, me.school.timezone]);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
        <div className="flex flex-wrap items-center gap-3">
          <CardTitle className="text-base">{mine ? 'Your classes today' : "Today's classes"}</CardTitle>
          {waiting > 0 && (
            <Link to="/crm/attendance" className="rounded-full bg-warning-soft px-2.5 py-0.5 text-xs font-semibold text-warning-soft-foreground hover:underline">
              {waiting} waiting for attendance
            </Link>
          )}
        </div>
        <Link to="/crm/classes?tab=timetable" className="inline-flex items-center gap-1 text-sm text-accent hover:underline">
          Timetable<ArrowRight className="h-4 w-4" aria-hidden="true" />
        </Link>
      </CardHeader>
      <CardContent>
        {state.status === 'loading' && <Skeleton className="h-20 w-full" />}
        {state.status === 'error' && <p className="text-sm text-muted-foreground">Classes couldn&apos;t be loaded.</p>}
        {state.status === 'ready' && !state.items.length && <p className="text-sm text-muted-foreground">No classes today.</p>}
        {state.items.length > 0 && (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {state.items.slice(0, SHOWN).map((session) => (
              <SessionCard key={session.id} session={{ ...session, href: canSeeAttendance ? `/crm/attendance/${session.id}` : `/crm/classes/batches/${session.batch.id}` }} timezone={me.school.timezone} />
            ))}
          </div>
        )}
        {state.items.length > SHOWN && <p className="mt-2 text-xs text-muted-foreground">{state.items.length - SHOWN} more on the timetable.</p>}
      </CardContent>
    </Card>
  );
}
