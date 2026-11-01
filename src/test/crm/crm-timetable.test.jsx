// Timetable UI (FLKRM-327 S3): the rule form with its clash panel and "Save
// anyway", the change form's apply-from date, and the week view.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { BatchRules } from '../../components/crm/classes/BatchTimetable';
import TimetableTab from '../../components/crm/classes/TimetableTab';

let calls;
let handlers;

function mockApi() {
  calls = [];
  globalThis.fetch = vi.fn(async (url, options = {}) => {
    const path = String(url).replace('/api/auth/crm/', '');
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ method: options.method || 'GET', path, body });
    const handler = handlers.find(([match, method]) => path.startsWith(match) && (!method || method === (options.method || 'GET')));
    const [status, payload] = handler ? handler[2](body, path) : [200, { items: [], nextCursor: null }];
    return { ok: status < 400, status, json: async () => payload };
  });
}

const posts = (path) => calls.filter((call) => call.method === 'POST' && call.path === path).map((call) => call.body);

function me(capabilities, user = { id: 'usr_admin', role: 'admin' }) {
  return { user, school: { id: 'sch_a', name: 'A', timezone: 'Asia/Kolkata' }, capabilities, sections: ['classes'], support: false, taskScope: 'school', crmOnly: false };
}
const ADMIN = me(['crm.access', 'crm.classes.read', 'crm.classes.write']);
const TEACHER = me(['crm.access', 'crm.classes.read'], { id: 'usr_teacher', role: 'teacher' });

const batch = {
  id: 'b_math10', name: 'Grade 10 Maths', status: 'active', subject: { id: 'sub_math', name: 'Mathematics' }, lead: { userId: 'usr_teacher', name: 'Teacher A' },
  startsOn: '2030-01-07', endsOn: '2030-03-31', academicYear: { endsOn: '2030-03-31' }, defaultRoom: { id: 'room_2', name: 'Room 2', status: 'active' }, defaultOnlineUrl: null,
};
const options = { subjects: [{ id: 'sub_math', name: 'Mathematics' }], rooms: [{ id: 'room_2', name: 'Room 2', seats: 30 }] };
const rule = {
  id: 'rule_1', seriesId: 'rule_1', batchId: 'b_math10', subject: { id: 'sub_math', name: 'Mathematics' }, instructor: { userId: 'usr_teacher', name: 'Teacher A' },
  weekdays: [1, 3, 5], startTime: '16:00', endTime: '17:30', room: { id: 'room_2', name: 'Room 2' }, onlineUrl: null, validFrom: '2030-01-07', validUntil: '2030-03-31',
  status: 'active', sessionCount: 36, upcomingCount: 36, version: 1,
};
const conflict = {
  conflicts: [{ kind: 'instructor', otherBatch: { id: 'b_sci9', name: 'Grade 9 Science' }, instructorName: 'Teacher A', roomName: null, time: '16:00–17:00', count: 5, dates: ['2030-01-07', '2030-01-14', '2030-01-21', '2030-01-28', '2030-02-04'] }],
  availability: [{ kind: 'on_leave', reason: 'Leave', count: 1, dates: ['2030-01-09'] }],
  capacity: null,
};

beforeEach(() => {
  handlers = [
    ['classes/rules?', 'GET', () => [200, { items: [rule, { ...rule, id: 'rule_0', status: 'ended', startTime: '15:00', endTime: '16:00', validUntil: '2030-01-06' }], nextCursor: null }]],
    ['classes/batches/instructors?', 'GET', () => [200, { items: [{ id: 'bi_1', userId: 'usr_teacher', name: 'Teacher A', subject: { name: 'Mathematics' }, isLead: true, status: 'active' }], nextCursor: null }]],
    ['classes/batches', 'GET', () => [200, { items: [batch], nextCursor: null }]],
    ['classes/instructors', 'GET', () => [200, { items: [{ userId: 'usr_teacher', name: 'Teacher A' }], nextCursor: null }]],
  ];
  mockApi();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Timetable rules', () => {
  it('lists the current timetable and earlier versions', async () => {
    render(<MemoryRouter><BatchRules me={ADMIN} batch={batch} options={options} /></MemoryRouter>);
    expect(await screen.findByText('Mon, Wed, Fri · 16:00–17:30')).toBeInTheDocument();
    expect(screen.getByText(/36 upcoming of 36 classes/)).toBeInTheDocument();
    expect(screen.getByText('Earlier versions (1)')).toBeInTheDocument();
  });

  it('shows the clash panel, then saves anyway with the override', async () => {
    let attempts = 0;
    handlers.unshift(['classes/rules', 'POST', () => {
      attempts += 1;
      return attempts === 1 ? [409, { error: { code: 'schedule_conflict', message: 'Clash', details: conflict } }] : [201, { rule, sessionsCreated: 36, capacity: null }];
    }]);
    render(<MemoryRouter><BatchRules me={ADMIN} batch={batch} options={options} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /New timetable/ }));
    const dialog = await screen.findByRole('dialog');
    // Defaults come from the batch: lead instructor, subject, room, dates.
    await waitFor(() => expect(within(dialog).getByLabelText('Instructor')).toHaveValue('usr_teacher'));
    expect(within(dialog).getByLabelText('Room (optional)')).toHaveValue('room_2');
    expect(within(dialog).getByLabelText('Last date')).toHaveValue('2030-03-31');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create timetable' }));
    expect(await within(dialog).findByText('Choose at least one day')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mon' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Wed' }));
    expect(within(dialog).getByText(/makes about \d+ classes/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create timetable' }));

    const panel = await within(dialog).findByRole('alert');
    expect(panel).toHaveTextContent('Teacher A is already teaching Grade 9 Science at 16:00–17:00 on Mon, 7 Jan, Mon, 14 Jan, Mon, 21 Jan and 2 more.');
    expect(panel).toHaveTextContent('Teacher A is away (Leave) on Wed, 9 Jan.');
    fireEvent.click(within(panel).getByRole('button', { name: 'Save anyway' }));
    await waitFor(() => expect(posts('classes/rules')).toHaveLength(2));
    expect(posts('classes/rules')[0].acknowledgeConflicts).toBeUndefined();
    expect(posts('classes/rules')[1]).toMatchObject({ acknowledgeConflicts: true, weekdays: [1, 3], batchId: 'b_math10', instructorUserId: 'usr_teacher', roomId: 'room_2' });
    expect(await screen.findByText('Timetable created with 36 classes.')).toBeInTheDocument();
  });

  it('changes a timetable from a date and explains what was kept', async () => {
    handlers.unshift(['classes/rules/update', 'POST', () => [200, { rule, sessionsCreated: 20, sessionsRemoved: 20, sessionsKept: 2, capacity: null }]]);
    render(<MemoryRouter><BatchRules me={ADMIN} batch={batch} options={options} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Change' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Changes apply from'), { target: { value: '2030-02-04' } });
    fireEvent.change(within(dialog).getByLabelText('Starts (IST)'), { target: { value: '17:00' } });
    fireEvent.change(within(dialog).getByLabelText('Ends (IST)'), { target: { value: '18:00' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(posts('classes/rules/update')).toEqual([expect.objectContaining({ ruleId: 'rule_1', expectedVersion: 1, applyFrom: '2030-02-04', startTime: '17:00', endTime: '18:00' })]));
    expect(await screen.findByText(/2 classes were kept because they were taken, cancelled or changed by hand/)).toBeInTheDocument();
  });

  it('is read-only for teachers', async () => {
    render(<MemoryRouter><BatchRules me={TEACHER} batch={batch} options={options} /></MemoryRouter>);
    await screen.findByText('Mon, Wed, Fri · 16:00–17:30');
    expect(screen.queryByRole('button', { name: /New timetable/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change' })).not.toBeInTheDocument();
  });
});

describe('Week view', () => {
  it('groups the week\'s classes by day and starts teachers on their own classes', async () => {
    handlers.unshift(['classes/sessions?', 'GET', (_, path) => {
      const params = new URLSearchParams(path.split('?')[1]);
      const session = {
        id: 'cs_1', batch: { id: 'b_math10', name: 'Grade 10 Maths' }, subject: { name: 'Mathematics' }, instructor: { userId: 'usr_teacher', name: 'Teacher A' },
        room: { name: 'Room 2' }, localDate: params.get('from'), startsAt: `${params.get('from')}T10:30:00.000Z`, endsAt: `${params.get('from')}T12:00:00.000Z`,
        status: 'scheduled', notMarked: false, isMine: true, isEdited: false,
      };
      return [200, { items: [session, { ...session, id: 'cs_2', status: 'cancelled', cancelReason: 'Teacher unwell', isMine: false }], nextCursor: null }];
    }]);
    render(<MemoryRouter><TimetableTab me={TEACHER} options={options} /></MemoryRouter>);
    expect(await screen.findAllByText('16:00–17:30')).toHaveLength(2);
    expect(screen.getByText('Teacher unwell')).toBeInTheDocument();
    const first = calls.find((call) => call.path.startsWith('classes/sessions?'));
    expect(first.path).toContain('mine=1');
    const monday = new URLSearchParams(first.path.split('?')[1]).get('from');
    expect(new Date(`${monday}T00:00:00Z`).getUTCDay()).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
    await waitFor(() => expect(calls.filter((call) => call.path.startsWith('classes/sessions?')).length).toBe(2));
    expect(calls.filter((call) => call.path.startsWith('classes/sessions?'))[1].path).not.toContain(`from=${monday}`);
  });
});
