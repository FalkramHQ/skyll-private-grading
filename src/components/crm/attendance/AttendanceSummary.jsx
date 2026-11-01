// Attendance summaries (FLKRM-327 S6, D11): the student profile card and the
// batch Attendance tab (per-student % and a monthly register). The % is
// (present + late) ÷ (present + late + absent); excused, cancelled and
// unmarked classes are left out, and "not marked" is shown on its own.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Alert, AlertDescription } from '../../ui/Alert';
import { Button } from '../../ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/Card';
import { Skeleton } from '../../ui/Skeleton';
import { cn } from '../../../lib/utils';
import { crmFetch } from '../../../lib/crm/api';
import { formatDay, formatWeekday } from '../../../lib/crm/classes';
import { addDays, localDate } from '../../../../shared/crm/time.js';
import { Segmented } from '../tasks/TasksPage';

const CELL = {
  present: { text: 'P', className: 'bg-success-soft text-success-soft-foreground', label: 'Present' },
  absent: { text: 'A', className: 'bg-destructive text-destructive-foreground', label: 'Absent' },
  late: { text: 'L', className: 'bg-warning-soft text-warning-soft-foreground', label: 'Late' },
  excused: { text: 'E', className: 'bg-muted text-foreground', label: 'Excused' },
  cancelled: { text: '×', className: 'text-muted-foreground', label: 'Cancelled' },
  not_marked: { text: '?', className: 'border border-dashed border-warning-soft-foreground/60 text-warning-soft-foreground', label: 'Not marked' },
  upcoming: { text: '·', className: 'text-muted-foreground', label: 'Upcoming' },
};

export function Percent({ value }) {
  if (value === null || value === undefined) return <span className="text-muted-foreground">—</span>;
  return <span className="font-semibold tabular-nums">{value}%</span>;
}

function CountsLine({ counts }) {
  return (
    <span className="text-xs text-muted-foreground">
      {counts.present} P · {counts.late} L · {counts.absent} A · {counts.excused} E{counts.notMarked ? ` · ${counts.notMarked} not marked` : ''}
    </span>
  );
}

/** Student profile → Attendance. */
export function StudentAttendanceCard({ studentId }) {
  const [state, setState] = useState({ status: 'loading', data: null, error: null });
  useEffect(() => {
    crmFetch(`attendance/student-summary?${new URLSearchParams({ studentId })}`)
      .then((data) => setState({ status: 'ready', data, error: null }))
      .catch((error) => setState({ status: 'error', data: null, error }));
  }, [studentId]);
  const data = state.data;
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">Attendance</CardTitle>
        {data && <span className="text-xs text-muted-foreground">{data.range.label}</span>}
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {state.status === 'loading' && <Skeleton className="h-20 w-full" />}
        {state.status === 'error' && <p className="text-muted-foreground">{state.error.message}</p>}
        {data && !data.recent.length && <p className="text-muted-foreground">No classes yet this year.</p>}
        {data && data.recent.length > 0 && (
          <>
            <div className="flex flex-wrap items-baseline gap-3">
              <span className="text-3xl"><Percent value={data.overall.percent} /></span>
              <CountsLine counts={data.overall} />
            </div>
            {data.batches.length > 1 && (
              <ul className="space-y-1">
                {data.batches.map((batch) => (
                  <li key={batch.batchId} className="flex flex-wrap items-center gap-2">
                    <Link to={`/crm/classes/batches/${batch.batchId}`} className="min-w-0 flex-1 truncate hover:underline">{batch.name}</Link>
                    <Percent value={batch.counts.percent} />
                  </li>
                ))}
              </ul>
            )}
            <div>
              <p className="mb-1 text-xs text-muted-foreground">Last {data.recent.length} classes (newest first)</p>
              <ol className="flex flex-wrap gap-1.5">
                {data.recent.map((item) => {
                  const cell = CELL[item.status] || CELL.upcoming;
                  return (
                    <li key={item.sessionId}>
                      <Link
                        to={`/crm/attendance/${item.sessionId}`}
                        className={cn('flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold', cell.className)}
                        title={`${formatWeekday(item.localDate)} · ${item.batchName} · ${cell.label}`}
                        aria-label={`${formatWeekday(item.localDate)}, ${item.batchName}: ${cell.label}`}
                      >
                        {cell.text}
                      </Link>
                    </li>
                  );
                })}
              </ol>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function monthOf(date) {
  return date.slice(0, 7);
}

function shiftMonth(month, delta) {
  const [year, number] = month.split('-').map(Number);
  return new Date(Date.UTC(year, number - 1 + delta, 1)).toISOString().slice(0, 7);
}

const monthFormat = new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });

function Register({ batchId, month, onMonth, canOpenStudents }) {
  const [state, setState] = useState({ status: 'loading', data: null, error: null });
  useEffect(() => {
    setState((current) => ({ ...current, status: 'loading' }));
    crmFetch(`attendance/register?${new URLSearchParams({ batchId, month })}`)
      .then((data) => setState({ status: 'ready', data, error: null }))
      .catch((error) => setState({ status: 'error', data: null, error }));
  }, [batchId, month]);
  const [year, number] = month.split('-').map(Number);
  const data = state.data;
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center gap-2 space-y-0">
        <CardTitle className="text-base">Register</CardTitle>
        <div className="ml-auto flex items-center gap-1">
          <Button size="icon" variant="outline" aria-label="Previous month" onClick={() => onMonth(shiftMonth(month, -1))}><ChevronLeft className="h-4 w-4" aria-hidden="true" /></Button>
          <span className="w-36 text-center text-sm font-medium" aria-live="polite">{monthFormat.format(new Date(Date.UTC(year, number - 1, 1)))}</span>
          <Button size="icon" variant="outline" aria-label="Next month" onClick={() => onMonth(shiftMonth(month, 1))}><ChevronRight className="h-4 w-4" aria-hidden="true" /></Button>
        </div>
      </CardHeader>
      <CardContent>
        {state.status === 'loading' && <Skeleton className="h-32 w-full" />}
        {state.status === 'error' && <Alert variant="destructive"><AlertDescription>{state.error.message}</AlertDescription></Alert>}
        {data && !data.sessions.length && <p className="text-sm text-muted-foreground">No classes this month.</p>}
        {data && data.sessions.length > 0 && (
          <div className="overflow-x-auto">
            <table className="text-xs">
              <thead>
                <tr>
                  <th scope="col" className="sticky left-0 z-10 bg-card p-2 text-left font-medium text-muted-foreground">Student</th>
                  {data.sessions.map((session) => (
                    <th key={session.id} scope="col" className="p-1 text-center font-medium text-muted-foreground">
                      <Link to={`/crm/attendance/${session.id}`} className="hover:underline" title={formatWeekday(session.localDate)}>
                        {Number(session.localDate.slice(8))}
                      </Link>
                    </th>
                  ))}
                  <th scope="col" className="p-2 text-right font-medium text-muted-foreground">%</th>
                </tr>
              </thead>
              <tbody>
                {data.students.map((student) => (
                  <tr key={student.studentId} className="border-t border-border">
                    <th scope="row" className="sticky left-0 z-10 max-w-[10rem] truncate bg-card p-2 text-left font-medium">
                      {canOpenStudents ? <Link to={`/crm/students/${student.studentId}`} className="hover:underline">{student.name}</Link> : student.name}
                    </th>
                    {student.cells.map((value, index) => {
                      const cell = value ? CELL[value] : null;
                      return (
                        <td key={data.sessions[index].id} className="p-1 text-center">
                          {cell
                            ? <span className={cn('inline-flex h-6 w-6 items-center justify-center rounded text-[11px] font-semibold', cell.className)} title={cell.label} aria-label={cell.label}>{cell.text}</span>
                            : <span className="text-muted-foreground" aria-label="Not in the batch">–</span>}
                        </td>
                      );
                    })}
                    <td className="p-2 text-right"><Percent value={student.counts.percent} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-muted-foreground">
              {Object.entries(CELL).filter(([key]) => key !== 'upcoming').map(([, cell]) => `${cell.text} ${cell.label}`).join(' · ')} · – not in the batch then
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Batch → Attendance: lowest attendance first for a range, then the register. */
export function BatchAttendance({ me, batch }) {
  const timezone = me.school.timezone;
  const [today] = useState(() => localDate(Date.now(), timezone));
  const [range, setRange] = useState('month');
  const [month, setMonth] = useState(() => monthOf(today));
  const [state, setState] = useState({ status: 'loading', data: null, error: null });
  const canOpenStudents = me.capabilities.includes('crm.students.read');

  const bounds = useCallback(() => {
    if (range === 'month') return { from: `${monthOf(today)}-01`, to: today };
    const from = batch.academicYear?.startsOn && batch.academicYear.startsOn <= today ? batch.academicYear.startsOn : addDays(today, -365);
    return { from, to: today };
  }, [range, today, batch.academicYear]);

  useEffect(() => {
    const { from, to } = bounds();
    setState((current) => ({ ...current, status: 'loading' }));
    crmFetch(`attendance/batch-summary?${new URLSearchParams({ batchId: batch.id, from, to })}`)
      .then((data) => setState({ status: 'ready', data, error: null }))
      .catch((error) => setState({ status: 'error', data: null, error }));
  }, [batch.id, bounds]);

  const data = state.data;
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex-row flex-wrap items-center gap-3 space-y-0">
          <CardTitle className="text-base">Attendance by student</CardTitle>
          <Segmented label="Period" options={[['month', 'This month'], ['year', 'This year']]} value={range} onChange={setRange} />
          {data && <span className="text-xs text-muted-foreground">{formatDay(data.from)} – {formatDay(data.to)} · {data.classesHeld} classes taken{data.classesCancelled ? ` · ${data.classesCancelled} cancelled` : ''}</span>}
        </CardHeader>
        <CardContent>
          {state.status === 'loading' && <Skeleton className="h-32 w-full" />}
          {state.status === 'error' && <Alert variant="destructive"><AlertDescription>{state.error.message}</AlertDescription></Alert>}
          {data && !data.students.length && <p className="text-sm text-muted-foreground">No classes in this period.</p>}
          {data && data.students.length > 0 && (
            <>
              <p className="mb-3 text-sm">Batch average <Percent value={data.overall.percent} /> <span className="text-xs text-muted-foreground">(late counts as attended; excused, cancelled and unmarked classes are left out)</span></p>
              <ul className="divide-y divide-border text-sm">
                {data.students.map((student) => (
                  <li key={student.studentId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                    <span className="min-w-0 flex-1 font-medium">
                      {canOpenStudents ? <Link to={`/crm/students/${student.studentId}`} className="hover:underline">{student.name}</Link> : student.name}
                    </span>
                    <CountsLine counts={student.counts} />
                    <span className="w-12 text-right"><Percent value={student.counts.percent} /></span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </CardContent>
      </Card>
      <Register batchId={batch.id} month={month} onMonth={setMonth} canOpenStudents={canOpenStudents} />
    </div>
  );
}

