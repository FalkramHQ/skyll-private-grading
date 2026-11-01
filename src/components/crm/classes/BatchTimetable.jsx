// Batch → Timetable and Sessions tabs (FLKRM-327 S3). Timetables are the
// weekly rules (current and past versions); sessions are the dated classes.
import { useCallback, useEffect, useState } from 'react';
import { CalendarPlus, Plus } from 'lucide-react';
import { Alert, AlertDescription } from '../../ui/Alert';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card, CardContent } from '../../ui/Card';
import { Skeleton } from '../../ui/Skeleton';
import { crmFetch } from '../../../lib/crm/api';
import { formatDay, formatWeekday } from '../../../lib/crm/classes';
import { WEEKDAY_SHORT } from '../../../../shared/crm/availability.js';
import { addDays, localDate } from '../../../../shared/crm/time.js';
import { Segmented } from '../tasks/TasksPage';
import SessionCard from './SessionCard';
import { CapacityNote, EndRuleDialog, OneOffDialog, RuleDialog } from './TimetableDialogs';

function daysLabel(weekdays) {
  return weekdays.map((day) => WEEKDAY_SHORT[day]).join(', ');
}

function savedMessage(result) {
  if (result.sessionsRemoved !== undefined && result.sessionsCreated === undefined) return `Timetable ended. ${result.sessionsRemoved} later class${result.sessionsRemoved === 1 ? '' : 'es'} removed.`;
  if (result.sessionsRemoved !== undefined) {
    const kept = result.sessionsKept ? ` ${result.sessionsKept} class${result.sessionsKept === 1 ? ' was' : 'es were'} kept because they were taken, cancelled or changed by hand.` : '';
    return `Timetable changed: ${result.sessionsCreated} new class${result.sessionsCreated === 1 ? '' : 'es'}, ${result.sessionsRemoved} replaced.${kept}`;
  }
  return `Timetable created with ${result.sessionsCreated} class${result.sessionsCreated === 1 ? '' : 'es'}.`;
}

export function BatchRules({ me, batch, options, onChanged }) {
  const canWrite = me.capabilities.includes('crm.classes.write') && batch.status === 'active';
  const [state, setState] = useState({ status: 'loading', items: [], error: null });
  const [editing, setEditing] = useState(null);
  const [ending, setEnding] = useState(null);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    try {
      setState({ status: 'ready', items: (await crmFetch(`classes/rules?${new URLSearchParams({ batchId: batch.id })}`)).items, error: null });
    } catch (error) {
      setState({ status: 'error', items: [], error });
    }
  }, [batch.id]);

  useEffect(() => { load(); }, [load]);

  const saved = (result) => {
    setEditing(null);
    setEnding(null);
    setNotice(result);
    load();
    onChanged?.();
  };

  const active = state.items.filter((rule) => rule.status === 'active');
  const past = state.items.filter((rule) => rule.status !== 'active');
  return (
    <div className="space-y-4">
      {canWrite && (
        <div className="flex justify-end">
          <Button onClick={() => setEditing('new')}><Plus className="mr-1 h-4 w-4" aria-hidden="true" />New timetable</Button>
        </div>
      )}
      {notice && (
        <Alert variant="success">
          <AlertDescription>
            {savedMessage(notice)}
            <CapacityNote capacity={notice.capacity} />
          </AlertDescription>
        </Alert>
      )}
      {state.status === 'loading' && <Skeleton className="h-32 w-full" />}
      {state.status === 'error' && <Alert variant="destructive"><AlertDescription>{state.error.message}</AlertDescription></Alert>}
      {state.status === 'ready' && !state.items.length && <p className="text-sm text-muted-foreground">No timetable yet. Add the weekly slots this batch meets.</p>}
      {active.map((rule) => (
        <Card key={rule.id}>
          <CardContent className="flex flex-wrap items-start gap-3 p-4 text-sm">
            <div className="min-w-0 flex-1 space-y-1">
              <p className="font-semibold">{daysLabel(rule.weekdays)} · {rule.startTime}–{rule.endTime}</p>
              <p className="text-muted-foreground">
                {[rule.subject?.name, rule.instructor.name, rule.room?.name || (rule.onlineUrl ? 'Online' : null)].filter(Boolean).join(' · ')}
              </p>
              <p className="text-xs text-muted-foreground">
                {formatDay(rule.validFrom)} – {formatDay(rule.validUntil)} · {rule.upcomingCount} upcoming of {rule.sessionCount} classes
              </p>
            </div>
            {canWrite && (
              <div className="flex gap-1">
                <Button size="sm" variant="outline" onClick={() => setEditing(rule)}>Change</Button>
                <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setEnding(rule)}>End</Button>
              </div>
            )}
          </CardContent>
        </Card>
      ))}
      {past.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">Earlier versions ({past.length})</summary>
          <ul className="mt-2 space-y-1 text-muted-foreground">
            {past.map((rule) => (
              <li key={rule.id}>
                {daysLabel(rule.weekdays)} · {rule.startTime}–{rule.endTime} · {rule.instructor.name} · {formatDay(rule.validFrom)} – {formatDay(rule.validUntil)}
                <Badge variant="secondary" className="ml-2">Ended</Badge>
              </li>
            ))}
          </ul>
        </details>
      )}
      <RuleDialog
        open={Boolean(editing)}
        onOpenChange={(open) => !open && setEditing(null)}
        batch={batch}
        rule={editing === 'new' ? null : editing}
        options={options}
        me={me}
        onSaved={saved}
      />
      <EndRuleDialog open={Boolean(ending)} onOpenChange={(open) => !open && setEnding(null)} rule={ending} me={me} onEnded={saved} />
    </div>
  );
}

const WINDOWS = { upcoming: [0, 27], past: [-28, -1] };

export function BatchSessions({ me, batch, options, onOpenSession, refreshKey }) {
  const canWrite = me.capabilities.includes('crm.classes.write') && batch.status === 'active';
  const timezone = me.school.timezone;
  const [view, setView] = useState('upcoming');
  const [state, setState] = useState({ status: 'loading', items: [], error: null });
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    const today = localDate(Date.now(), timezone);
    const [from, to] = WINDOWS[view].map((offset) => addDays(today, offset));
    try {
      const page = await crmFetch(`classes/sessions?${new URLSearchParams({ batchId: batch.id, from, to })}`);
      setState({ status: 'ready', items: view === 'past' ? [...page.items].reverse() : page.items, error: null });
    } catch (error) {
      setState({ status: 'error', items: [], error });
    }
  }, [batch.id, view, timezone]);

  useEffect(() => { load(); }, [load, refreshKey]);

  const byDate = state.items.reduce((groups, session) => {
    (groups[session.localDate] ||= []).push(session);
    return groups;
  }, {});
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented label="Sessions shown" options={[['upcoming', 'Next 4 weeks'], ['past', 'Last 4 weeks']]} value={view} onChange={setView} />
        {canWrite && (
          <Button className="ml-auto" variant="outline" onClick={() => setAdding(true)}>
            <CalendarPlus className="mr-1 h-4 w-4" aria-hidden="true" />One-off class
          </Button>
        )}
      </div>
      {state.status === 'loading' && <Skeleton className="h-32 w-full" />}
      {state.status === 'error' && <Alert variant="destructive"><AlertDescription>{state.error.message}</AlertDescription></Alert>}
      {state.status === 'ready' && !state.items.length && <p className="text-sm text-muted-foreground">No classes in this period.</p>}
      <div className="space-y-3">
        {Object.entries(byDate).map(([date, sessions]) => (
          <div key={date} className="grid gap-2 sm:grid-cols-[8rem_1fr]">
            <p className="pt-2 text-sm font-medium">{formatWeekday(date)}</p>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {sessions.map((session) => <SessionCard key={session.id} session={session} timezone={timezone} showBatch={false} onOpen={onOpenSession} />)}
            </div>
          </div>
        ))}
      </div>
      <OneOffDialog open={adding} onOpenChange={setAdding} batch={batch} options={options} me={me} onSaved={() => { setAdding(false); load(); }} />
    </div>
  );
}
