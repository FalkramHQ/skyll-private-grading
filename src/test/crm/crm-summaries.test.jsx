// Attendance summaries UI (FLKRM-327 S6): the student card, the batch table
// (lowest first) and the monthly register.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { BatchAttendance, StudentAttendanceCard } from '../../components/crm/attendance/AttendanceSummary';
import ActivityTimeline from '../../components/crm/records/ActivityTimeline';

let calls;
let handlers;

function mockApi() {
  calls = [];
  globalThis.fetch = vi.fn(async (url, options = {}) => {
    const path = String(url).replace('/api/auth/crm/', '');
    calls.push({ method: options.method || 'GET', path });
    const handler = handlers.find(([match]) => path.startsWith(match));
    const [status, payload] = handler ? handler[1](path) : [200, { items: [], nextCursor: null }];
    return { ok: status < 400, status, json: async () => payload };
  });
}

const ME = { user: { id: 'usr_admin', role: 'admin' }, school: { id: 'sch_a', name: 'A', timezone: 'Asia/Kolkata' }, capabilities: ['crm.access', 'crm.attendance.read', 'crm.students.read'], sections: [], support: false };
const counts = (overrides) => ({ present: 0, absent: 0, late: 0, excused: 0, notMarked: 0, percent: null, ...overrides });

beforeEach(() => {
  handlers = [
    ['attendance/student-summary', () => [200, {
      range: { from: '2026-06-01', to: '2027-03-31', label: '2026-27' },
      overall: counts({ present: 7, late: 1, absent: 2, notMarked: 1, percent: 80 }),
      batches: [{ batchId: 'b1', name: 'Grade 10 Maths', counts: counts({ percent: 75 }) }, { batchId: 'b2', name: 'Grade 10 Evening', counts: counts({ percent: 100 }) }],
      recent: [{ sessionId: 'cs_9', localDate: '2026-10-07', batchName: 'Grade 10 Maths', status: 'absent' }, { sessionId: 'cs_8', localDate: '2026-10-05', batchName: 'Grade 10 Maths', status: 'present' }],
    }]],
    ['attendance/batch-summary', () => [200, {
      batch: { id: 'b1', name: 'Grade 10 Maths' }, from: '2026-10-01', to: '2026-10-08', classesHeld: 4, classesCancelled: 1,
      overall: counts({ percent: 72 }),
      students: [{ studentId: 'stu_2', name: 'Arjun Sharma', counts: counts({ present: 1, absent: 1, percent: 50 }) }, { studentId: 'stu_1', name: 'Anaya Iyer', counts: counts({ present: 3, percent: 100 }) }],
    }]],
    ['attendance/register', (path) => [200, {
      month: new URLSearchParams(path.split('?')[1]).get('month'),
      sessions: [{ id: 'cs_1', localDate: '2026-10-05', status: 'held' }, { id: 'cs_2', localDate: '2026-10-07', status: 'cancelled' }],
      students: [{ studentId: 'stu_1', name: 'Anaya Iyer', counts: counts({ percent: 100 }), cells: ['present', 'cancelled'] }, { studentId: 'stu_3', name: 'Diya Rao', counts: counts({}), cells: [null, 'cancelled'] }],
    }]],
    ['timeline', () => [200, { items: [{ id: 'audit:1', kind: 'attendance', at: '2026-10-08T10:00:00.000Z', actorName: 'Teacher A', from: 'absent', to: 'late', reason: 'Arrived late', batchName: 'Grade 10 Maths', localDate: '2026-10-07' }], nextCursor: null }]],
  ];
  mockApi();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Attendance summaries', () => {
  it('shows a student\'s year, per batch, and the last classes as dots linking to the sheets', async () => {
    render(<MemoryRouter><StudentAttendanceCard studentId="stu_1" /></MemoryRouter>);
    expect(await screen.findByText('80%')).toBeInTheDocument();
    expect(screen.getByText(/7 P · 1 L · 2 A · 0 E · 1 not marked/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Grade 10 Evening' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Grade 10 Maths: Absent/ })).toHaveAttribute('href', '/crm/attendance/cs_9');
  });

  it('lists a batch\'s students lowest first and switches to the year', async () => {
    render(<MemoryRouter><BatchAttendance me={ME} batch={{ id: 'b1', name: 'Grade 10 Maths', academicYear: { startsOn: '2026-06-01' } }} /></MemoryRouter>);
    const names = await screen.findAllByRole('link', { name: /Arjun Sharma|Anaya Iyer/ });
    expect(names[0]).toHaveTextContent('Arjun Sharma');
    expect(screen.getByText(/4 classes taken · 1 cancelled/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'This year' }));
    await waitFor(() => expect(calls.filter((call) => call.path.startsWith('attendance/batch-summary')).at(-1).path).toContain('from=2026-06-01'));
  });

  it('draws the register with a mark per class, dashes before a student joined, and month navigation', async () => {
    render(<MemoryRouter><BatchAttendance me={ME} batch={{ id: 'b1', name: 'Grade 10 Maths', academicYear: null }} /></MemoryRouter>);
    const table = await screen.findByRole('table');
    const diya = within(table).getByRole('rowheader', { name: 'Diya Rao' }).closest('tr');
    expect(within(diya).getByLabelText('Not in the batch')).toBeInTheDocument();
    expect(within(diya).getByLabelText('Cancelled')).toBeInTheDocument();
    const before = calls.filter((call) => call.path.startsWith('attendance/register')).at(-1).path;
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }));
    await waitFor(() => expect(calls.filter((call) => call.path.startsWith('attendance/register')).at(-1).path).not.toBe(before));
  });

  it('shows attendance corrections on the student timeline', async () => {
    render(<MemoryRouter><ActivityTimeline entityType="student" entityId="stu_1" /></MemoryRouter>);
    expect(await screen.findByText(/Attendance changed from/)).toHaveTextContent('Attendance changed from Absent to Late for Grade 10 Maths, Wed, 7 Oct');
    expect(screen.getByText('Reason: Arrived late')).toBeInTheDocument();
  });
});
