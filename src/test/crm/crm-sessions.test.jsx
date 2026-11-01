// Session changes and holidays UI (FLKRM-327 S4): cancel with a reason, undo,
// substitute with a clash panel, holiday preview, and the archive prompt.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import BatchPage from '../../components/crm/classes/BatchPage';
import HolidaysCard from '../../components/crm/classes/HolidaysCard';
import SessionDialog from '../../components/crm/classes/SessionDialog';

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

function me(capabilities) {
  return { user: { id: 'usr_admin', role: 'admin' }, school: { id: 'sch_a', name: 'A', timezone: 'Asia/Kolkata' }, capabilities, sections: ['classes'], support: false, taskScope: 'school', crmOnly: false };
}
const ADMIN = me(['crm.access', 'crm.classes.read', 'crm.classes.write']);
const TEACHER = me(['crm.access', 'crm.classes.read']);

const session = {
  id: 'cs_1', batch: { id: 'b_math10', name: 'Grade 10 Maths' }, subject: { name: 'Mathematics' }, instructor: { userId: 'usr_teacher', name: 'Teacher A' },
  room: { id: 'room_2', name: 'Room 2' }, onlineUrl: null, localDate: '2099-01-07', startsAt: '2099-01-07T10:30:00.000Z', endsAt: '2099-01-07T12:00:00.000Z',
  status: 'scheduled', notMarked: false, isEdited: false, onLeave: true, capacity: 30, version: 1,
};

beforeEach(() => {
  handlers = [
    ['classes/instructors', 'GET', () => [200, { items: [{ userId: 'usr_teacher', name: 'Teacher A' }, { userId: 'usr_admin', name: 'Admin A' }], nextCursor: null }]],
    ['classes/sessions/cancel', 'POST', (body) => [200, { ...session, status: 'cancelled', cancelReason: body.reason, version: 2 }]],
    ['classes/sessions/restore', 'POST', () => [200, { ...session, version: 3 }]],
  ];
  mockApi();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Session dialog', () => {
  it('shows the leave flag, cancels with a reason, and undoes the cancel', async () => {
    const onChanged = vi.fn();
    render(<MemoryRouter><SessionDialog session={session} me={ADMIN} options={{ rooms: [] }} onOpenChange={() => {}} onChanged={onChanged} /></MemoryRouter>);
    expect(screen.getByText('Instructor on leave')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel class' }));
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Other' } });
    expect(screen.getAllByRole('button', { name: 'Cancel class' }).at(-1)).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Say why'), { target: { value: 'Board exam duty' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel class' }).at(-1));
    await waitFor(() => expect(posts('classes/sessions/cancel')).toEqual([{ sessionId: 'cs_1', expectedVersion: 1, reason: 'Board exam duty' }]));
    expect(await screen.findByText('Board exam duty')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Undo cancel' }));
    await waitFor(() => expect(posts('classes/sessions/restore')).toEqual([{ sessionId: 'cs_1', expectedVersion: 2 }]));
    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  it('puts in a substitute, showing the clash panel before saving anyway', async () => {
    let attempts = 0;
    handlers.unshift(['classes/sessions/update', 'POST', () => {
      attempts += 1;
      return attempts === 1
        ? [409, { error: { code: 'schedule_conflict', message: 'Clash', details: { conflicts: [{ kind: 'instructor', otherBatch: { id: 'b2', name: 'Grade 9 Science' }, instructorName: 'Admin A', time: '16:00–17:00', count: 1, dates: ['2099-01-07'] }], availability: [], capacity: null } } }]
        : [200, { ...session, instructor: { userId: 'usr_admin', name: 'Admin A' }, isEdited: true, version: 2 }];
    }]);
    render(<MemoryRouter><SessionDialog session={session} me={ADMIN} options={{ rooms: [] }} onOpenChange={() => {}} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Substitute or room' }));
    await screen.findByRole('option', { name: 'Admin A' });
    fireEvent.change(screen.getByLabelText('Instructor'), { target: { value: 'usr_admin' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Admin A is already teaching Grade 9 Science/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save anyway' }));
    await waitFor(() => expect(posts('classes/sessions/update').at(-1)).toMatchObject({ instructorUserId: 'usr_admin', acknowledgeConflicts: true }));
    expect(await screen.findByText('Changed by hand')).toBeInTheDocument();
    expect(screen.queryByText('Instructor on leave')).not.toBeInTheDocument();
  });

  it('offers no changes to people without classes write', () => {
    render(<MemoryRouter><SessionDialog session={session} me={TEACHER} options={{ rooms: [] }} onOpenChange={() => {}} /></MemoryRouter>);
    expect(screen.queryByRole('button', { name: 'Cancel class' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Substitute or room' })).not.toBeInTheDocument();
  });
});

describe('Holidays', () => {
  it('previews the classes a holiday cancels and adds it', async () => {
    handlers.unshift(
      ['classes/holidays/impact', 'GET', () => [200, { sessions: 3, batches: [{ id: 'b_math10', name: 'Grade 10 Maths', sessions: 3 }] }]],
      ['classes/holidays', 'POST', (body) => [201, { holiday: { id: 'hol_1', ...body }, sessionsCancelled: 3 }]],
    );
    render(<HolidaysCard me={ADMIN} />);
    expect(await screen.findByText('No holidays yet.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Holiday name'), { target: { value: 'Diwali' } });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2099-11-08' } });
    expect(await screen.findByText('This cancels 3 classes: Grade 10 Maths (3).')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add holiday and cancel 3' }));
    await waitFor(() => expect(posts('classes/holidays')).toEqual([{ startsOn: '2099-11-08', endsOn: '2099-11-08', label: 'Diwali' }]));
    expect(await screen.findByText('Diwali added. 3 classes cancelled.')).toBeInTheDocument();
  });
});

describe('Archiving a batch with future classes', () => {
  it('asks to confirm the classes it cancels', async () => {
    const batch = { id: 'b_sci9', name: 'Grade 9 Science', status: 'active', studentCount: 0, version: 1, academicYear: null, course: null };
    let attempts = 0;
    handlers.unshift(
      ['classes/options', 'GET', () => [200, { academicYears: [], subjects: [], rooms: [], courses: [], programs: [] }]],
      ['classes/batches/detail', 'GET', () => [200, batch]],
      ['classes/batches/archive', 'POST', () => {
        attempts += 1;
        return attempts === 1 ? [409, { error: { code: 'has_future_sessions', message: 'x', details: { sessionCount: 4 } } }] : [200, { ...batch, status: 'archived', cancelledSessions: 4 }];
      }],
    );
    render(<MemoryRouter initialEntries={['/b']}><Routes><Route path="/b" element={<BatchPage me={ADMIN} />} /></Routes></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Archive' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive batch' }));
    expect(await within(dialog).findByText(/This cancels 4 future classes/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive and cancel 4 classes' }));
    await waitFor(() => expect(posts('classes/batches/archive')).toEqual([{ batchId: 'b_sci9' }, { batchId: 'b_sci9', cancelFutureSessions: true }]));
  });
});
