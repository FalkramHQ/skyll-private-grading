// Classes → Timetable (FLKRM-327 S3): one week of classes, Monday to Sunday,
// in the school's timezone. Filter by batch, instructor or room, or show only
// your own classes. Seven columns on wide screens, a day list on phones.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Alert, AlertDescription } from '../../ui/Alert';
import { Button } from '../../ui/Button';
import { Select } from '../../ui/Select';
import { Skeleton } from '../../ui/Skeleton';
import { cn } from '../../../lib/utils';
import { crmFetch } from '../../../lib/crm/api';
import { formatDay, formatWeekday, mondayOf } from '../../../lib/crm/classes';
import { addDays, localDate } from '../../../../shared/crm/time.js';
import { Segmented } from '../tasks/TasksPage';
import SessionCard from './SessionCard';

export default function TimetableTab({ me, options, onOpenSession, refreshKey }) {
  const timezone = me.school.timezone;
  const [today] = useState(() => localDate(Date.now(), timezone));
  const [weekStart, setWeekStart] = useState(() => mondayOf(today));
  // Teachers without classes write start on their own classes.
  const [scope, setScope] = useState(me.capabilities.includes('crm.classes.write') ? 'all' : 'mine');
  const [filters, setFilters] = useState({ batchId: '', instructorId: '', roomId: '' });
  const [lists, setLists] = useState({ batches: [], instructors: [] });
  const [state, setState] = useState({ status: 'loading', items: [], error: null });

  useEffect(() => {
    Promise.all([crmFetch('classes/batches'), crmFetch('classes/instructors')])
      .then(([batches, instructors]) => setLists({ batches: batches.items, instructors: instructors.items }))
      .catch(() => setLists({ batches: [], instructors: [] }));
  }, []);

  const days = useMemo(() => Array.from({ length: 7 }, (_, index) => addDays(weekStart, index)), [weekStart]);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ from: days[0], to: days[6] });
    if (scope === 'mine') params.set('mine', '1');
    for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
    setState((current) => ({ ...current, status: current.items.length ? 'refreshing' : 'loading' }));
    try {
      setState({ status: 'ready', items: (await crmFetch(`classes/sessions?${params}`)).items, error: null });
    } catch (error) {
      setState({ status: 'error', items: [], error });
    }
  }, [days, scope, filters]);

  useEffect(() => { load(); }, [load, refreshKey]);

  const byDay = Object.fromEntries(days.map((day) => [day, state.items.filter((session) => session.localDate === day)]));
  const setFilter = (key) => (event) => setFilters((current) => ({ ...current, [key]: event.target.value }));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Button size="icon" variant="outline" aria-label="Previous week" onClick={() => setWeekStart(addDays(weekStart, -7))}><ChevronLeft className="h-4 w-4" aria-hidden="true" /></Button>
          <Button size="sm" variant="outline" onClick={() => setWeekStart(mondayOf(today))}>This week</Button>
          <Button size="icon" variant="outline" aria-label="Next week" onClick={() => setWeekStart(addDays(weekStart, 7))}><ChevronRight className="h-4 w-4" aria-hidden="true" /></Button>
        </div>
        <p className="text-sm font-medium" aria-live="polite">{formatDay(days[0])} – {formatDay(days[6])}</p>
        <Segmented label="Whose classes" options={[['all', 'All classes'], ['mine', 'Mine']]} value={scope} onChange={setScope} />
      </div>
      <div className="flex flex-wrap gap-2">
        <Select aria-label="Filter by batch" className="w-auto min-w-[10rem]" value={filters.batchId} onChange={setFilter('batchId')}>
          <option value="">All batches</option>
          {lists.batches.map((batch) => <option key={batch.id} value={batch.id}>{batch.name}</option>)}
        </Select>
        {scope === 'all' && (
          <Select aria-label="Filter by instructor" className="w-auto min-w-[10rem]" value={filters.instructorId} onChange={setFilter('instructorId')}>
            <option value="">All instructors</option>
            {lists.instructors.map((person) => <option key={person.userId} value={person.userId}>{person.name}</option>)}
          </Select>
        )}
        <Select aria-label="Filter by room" className="w-auto min-w-[10rem]" value={filters.roomId} onChange={setFilter('roomId')}>
          <option value="">All rooms</option>
          {(options?.rooms || []).map((room) => <option key={room.id} value={room.id}>{room.name}</option>)}
        </Select>
      </div>

      {state.status === 'loading' && <Skeleton className="h-64 w-full" />}
      {state.status === 'error' && <Alert variant="destructive"><AlertDescription>{state.error.message}</AlertDescription></Alert>}
      {(state.status === 'ready' || state.status === 'refreshing') && (
        <>
          {!state.items.length && <p className="text-sm text-muted-foreground">No classes this week{scope === 'mine' ? ' for you' : ''}.</p>}
          <div className={cn('grid gap-3 lg:grid-cols-7', state.status === 'refreshing' && 'opacity-60')}>
            {days.map((day) => (
              <section key={day} aria-label={formatWeekday(day)} className={cn('space-y-2 rounded-xl border border-border bg-card/50 p-2', !byDay[day].length && 'hidden lg:block', day === today && 'border-accent')}>
                <h3 className={cn('text-xs font-semibold uppercase tracking-wide text-muted-foreground', day === today && 'text-accent')}>
                  {formatWeekday(day)}{day === today ? ' · Today' : ''}
                </h3>
                {byDay[day].map((session) => <SessionCard key={session.id} session={session} timezone={timezone} onOpen={onOpenSession} />)}
              </section>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
