// Attendance section (FLKRM-327 S5, D10): today's classes with marking
// progress, and classes that ended with no attendance yet.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { Alert, AlertDescription } from '../../ui/Alert';
import { Badge } from '../../ui/Badge';
import { Card } from '../../ui/Card';
import { Skeleton } from '../../ui/Skeleton';
import { crmFetch } from '../../../lib/crm/api';
import { formatTime, formatWeekday } from '../../../lib/crm/classes';
import { Segmented } from '../tasks/TasksPage';

function SessionRow({ session, timezone, showDate }) {
  const done = session.status === 'held';
  return (
    <li>
      <Link to={`/crm/attendance/${session.id}`} className="flex items-center gap-3 p-3 text-sm hover:bg-muted">
        <div className="w-24 shrink-0 tabular-nums">
          {showDate && <p className="text-xs text-muted-foreground">{formatWeekday(session.localDate)}</p>}
          <p className="font-semibold">{formatTime(session.startsAt, timezone)}</p>
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{session.batch.name}</p>
          <p className="truncate text-xs text-muted-foreground">{[session.subject?.name, session.instructor.name, session.room?.name].filter(Boolean).join(' · ')}</p>
        </div>
        <div className="shrink-0 text-right">
          {session.status === 'cancelled' && <Badge variant="secondary">Cancelled</Badge>}
          {done && <Badge variant="success">{session.markedCount}/{session.rosterCount} marked</Badge>}
          {session.status === 'scheduled' && (session.notMarked ? <Badge variant="warning">Not marked</Badge> : <span className="text-xs text-muted-foreground">{session.rosterCount} students</span>)}
        </div>
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </Link>
    </li>
  );
}

export default function AttendancePage({ me }) {
  const timezone = me.school.timezone;
  const schoolWide = me.capabilities.includes('crm.attendance.write') && me.attendanceScope === 'school';
  // Teachers marking their own classes see only those; read-only viewers see the school.
  const ownOnly = me.attendanceScope === 'own';
  const [tab, setTab] = useState('today');
  const [view, setView] = useState('mine');
  const [state, setState] = useState({ status: 'loading', items: [], error: null });

  const load = useCallback(async () => {
    setState((current) => ({ ...current, status: 'loading' }));
    try {
      const page = tab === 'today'
        ? await crmFetch(`attendance/today?${new URLSearchParams({ view })}`)
        : await crmFetch('attendance/pending');
      setState({ status: 'ready', items: page.items, error: null });
    } catch (error) {
      setState({ status: 'error', items: [], error });
    }
  }, [tab, view]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented label="Attendance list" options={[['today', 'Today'], ['pending', 'Waiting for attendance']]} value={tab} onChange={setTab} />
        {tab === 'today' && schoolWide && <Segmented label="Whose classes" options={[['mine', 'Mine'], ['all', 'All classes']]} value={view} onChange={setView} />}
      </div>
      {tab === 'pending' && (
        <p className="text-sm text-muted-foreground">
          {ownOnly ? 'Your classes that ended without attendance. Sheets lock 7 days after the class.' : 'Classes in the last 30 days that ended without attendance.'}
        </p>
      )}
      {state.status === 'loading' && <Skeleton className="h-40 w-full" />}
      {state.status === 'error' && <Alert variant="destructive"><AlertDescription>{state.error.message}</AlertDescription></Alert>}
      {state.status === 'ready' && !state.items.length && (
        <p className="text-sm text-muted-foreground">{tab === 'today' ? 'No classes today.' : 'Nothing waiting. Every class has attendance.'}</p>
      )}
      {state.status === 'ready' && state.items.length > 0 && (
        <Card>
          <ul className="divide-y divide-border">
            {state.items.map((session) => <SessionRow key={session.id} session={session} timezone={timezone} showDate={tab === 'pending'} />)}
          </ul>
        </Card>
      )}
    </div>
  );
}
