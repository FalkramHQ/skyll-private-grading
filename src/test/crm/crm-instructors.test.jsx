// Instructors UI (FLKRM-327 S2): batch instructors, the Instructors tab, and
// the availability editor for self vs others.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AvailabilityDialog from '../../components/crm/classes/AvailabilityDialog';
import BatchInstructors from '../../components/crm/classes/BatchInstructors';
import InstructorsTab from '../../components/crm/classes/InstructorsTab';

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

const batch = { id: 'b_math10', name: 'Grade 10 Maths', status: 'active', subject: { id: 'sub_math', name: 'Mathematics' }, course: null };
const options = { subjects: [{ id: 'sub_math', name: 'Mathematics' }, { id: 'sub_sci', name: 'Science' }], courses: [] };
const assignment = (overrides) => ({ id: 'bi_1', batchId: 'b_math10', userId: 'usr_teacher', name: 'Teacher A', subject: { id: 'sub_math', name: 'Mathematics' }, isLead: true, status: 'active', startedAt: '2026-06-01T00:00:00.000Z', endedAt: null, version: 1, ...overrides });
const people = [
  { userId: 'usr_admin', name: 'Admin A', role: 'admin', assignments: [], availability: { summary: 'Always available', windowCount: 0, nextLeave: null, leaveCount: 0 }, canEditAvailability: true },
  { userId: 'usr_teacher', name: 'Teacher A', role: 'teacher', assignments: [{ id: 'bi_1', batchId: 'b_math10', batchName: 'Grade 10 Maths', subject: { name: 'Mathematics' }, isLead: true }], availability: { summary: 'Mon–Fri 15:00–20:00', windowCount: 5, nextLeave: { startsOn: '2026-10-14', endsOn: '2026-10-14', reason: 'Leave' }, leaveCount: 1 }, canEditAvailability: false },
];
const availability = (overrides = {}) => ({
  userId: 'usr_teacher', name: 'Teacher A', role: 'teacher', summary: 'Mon 15:00–20:00', canEdit: true,
  windows: [{ id: 'aw1', weekday: 1, start: '15:00', end: '20:00' }], exceptions: [], ...overrides,
});

beforeEach(() => {
  handlers = [
    ['classes/batches/instructors?', 'GET', () => [200, { items: [assignment(), assignment({ id: 'bi_2', userId: 'usr_admin', name: 'Admin A', subject: { id: 'sub_sci', name: 'Science' }, isLead: false }), assignment({ id: 'bi_0', name: 'Old Teacher', status: 'ended', isLead: false, endedAt: '2026-07-01T00:00:00.000Z' })], nextCursor: null }]],
    ['classes/instructors', 'GET', () => [200, { items: people, nextCursor: null }]],
    ['classes/batches/instructors', 'POST', (body) => [201, assignment({ ...body, id: 'bi_new' })]],
    ['classes/batches/instructors/lead', 'POST', () => [200, assignment({ id: 'bi_2', isLead: true })]],
    ['classes/availability?', 'GET', () => [200, availability()]],
    ['classes/availability', 'POST', (body) => [200, availability({ windows: body.windows.map((window, index) => ({ id: `w${index}`, ...window })) })]],
  ];
  mockApi();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Batch instructors', () => {
  it('shows the lead, subjects and history, and assigns with the batch subject preselected', async () => {
    render(<MemoryRouter><BatchInstructors me={ADMIN} batch={batch} options={options} /></MemoryRouter>);
    const row = (await screen.findByText('Teacher A', { selector: 'span' })).closest('li');
    expect(within(row).getByText('Lead')).toBeInTheDocument();
    expect(screen.getByText('Past instructors (1)')).toBeInTheDocument();
    expect(screen.getByLabelText('Subject (optional)')).toHaveValue('sub_math');
    fireEvent.change(screen.getByLabelText('Instructor'), { target: { value: 'usr_admin' } });
    fireEvent.click(screen.getByRole('button', { name: /Assign/ }));
    await waitFor(() => expect(posts('classes/batches/instructors')).toEqual([{ batchId: 'b_math10', userId: 'usr_admin', subjectId: 'sub_math' }]));
    fireEvent.click(screen.getByRole('button', { name: 'Make lead' }));
    await waitFor(() => expect(posts('classes/batches/instructors/lead')).toEqual([{ assignmentId: 'bi_2', expectedVersion: 1 }]));
  });

  it('is read-only for teachers', async () => {
    render(<MemoryRouter><BatchInstructors me={TEACHER} batch={batch} options={options} /></MemoryRouter>);
    await screen.findByText('Teacher A');
    expect(screen.queryByRole('button', { name: 'Make lead' })).not.toBeInTheDocument();
    expect(screen.queryByText('Assign an instructor')).not.toBeInTheDocument();
  });
});

describe('Instructors tab and availability', () => {
  it('lists people with batches, hours and leave, and offers the teacher their own editor', async () => {
    render(<MemoryRouter><InstructorsTab me={TEACHER} /></MemoryRouter>);
    expect(await screen.findByText('Your availability')).toBeInTheDocument();
    expect(screen.getAllByText('Mon–Fri 15:00–20:00').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: /Grade 10 Maths · Mathematics/ })).toBeInTheDocument();
    expect(screen.getAllByText(/Leave · 14 Oct 2026/).length).toBeGreaterThan(0);
  });

  it('edits weekly hours: copies Monday to Tue–Fri and saves the whole set', async () => {
    render(<AvailabilityDialog open onOpenChange={() => {}} userId="usr_teacher" me={TEACHER} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy Monday to Tue–Fri' }));
    expect(screen.getAllByLabelText(/from$/)).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: 'Save weekly hours' }));
    await waitFor(() => expect(posts('classes/availability')).toHaveLength(1));
    expect(posts('classes/availability')[0].windows.map((window) => window.weekday)).toEqual([1, 2, 3, 4, 5]);
  });

  it('shows every day as "Any time" when no hours are set', async () => {
    handlers.unshift(['classes/availability?', 'GET', () => [200, availability({ windows: [], summary: 'Always available' })]]);
    render(<AvailabilityDialog open onOpenChange={() => {}} userId="usr_teacher" me={TEACHER} />);
    expect(await screen.findAllByText('Any time')).toHaveLength(7);
    expect(screen.queryByText('Not available')).not.toBeInTheDocument();
  });

  it('blocks overlapping hours before saving', async () => {
    render(<AvailabilityDialog open onOpenChange={() => {}} userId="usr_teacher" me={TEACHER} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add hours on Monday' }));
    expect(await screen.findByText('Two windows on the same day overlap')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save weekly hours' })).toBeDisabled();
  });

  it('never shows the previous person\'s editable hours while the next one loads', async () => {
    let release;
    const { rerender } = render(<AvailabilityDialog open onOpenChange={() => {}} userId="usr_teacher" me={TEACHER} />);
    await screen.findByRole('button', { name: 'Save weekly hours' });
    handlers.unshift(['classes/availability?', 'GET', () => [200, availability({ userId: 'usr_admin', name: 'Admin A', canEdit: false })]]);
    const slow = globalThis.fetch;
    globalThis.fetch = vi.fn((...args) => new Promise((resolve) => { release = () => resolve(slow(...args)); }));
    rerender(<AvailabilityDialog open onOpenChange={() => {}} userId="usr_admin" me={TEACHER} />);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save weekly hours' })).not.toBeInTheDocument());
    release();
    expect(await screen.findByText("Admin A's availability")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save weekly hours' })).not.toBeInTheDocument();
  });

  it('shows someone else\'s availability read-only', async () => {
    handlers.unshift(['classes/availability?', 'GET', () => [200, availability({ canEdit: false })]]);
    render(<AvailabilityDialog open onOpenChange={() => {}} userId="usr_teacher" me={me(['crm.access', 'crm.classes.read'], { id: 'usr_teacher2', role: 'teacher' })} />);
    expect(await screen.findByText("Teacher A's availability")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save weekly hours' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add leave' })).not.toBeInTheDocument();
  });
});
