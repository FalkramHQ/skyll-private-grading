// Tasks UI (FLKRM-326 S2): Overdue / Today / Upcoming in school time, task
// actions, own-only teachers, the nav badge, and moving tasks with a lead.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import CrmLayout from '../../components/crm/CrmLayout';
import LeadProfile from '../../components/crm/leads/LeadProfile';
import TasksPage from '../../components/crm/tasks/TasksPage';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-09-28T06:30:00.000Z'); // 12:00 IST

function task(overrides = {}) {
  return {
    id: 'task_1', title: 'Call Mrs Shah', details: null, dueAt: new Date(NOW - 2 * HOUR).toISOString(), priority: 'normal', status: 'open',
    ownerUserId: 'usr_admin', owner: { userId: 'usr_admin', name: 'Admin A' }, related: null, completedAt: null, version: 1,
    createdAt: '2026-09-27T09:00:00.000Z', ...overrides,
  };
}

const TASKS = [
  task(),
  task({ id: 'task_2', title: 'Send fee details', dueAt: new Date(NOW + 3 * HOUR).toISOString(), priority: 'high' }),
  task({ id: 'task_3', title: 'Trial class reminder', dueAt: new Date(NOW + 30 * HOUR).toISOString(), related: { type: 'lead', id: 'lead_1', name: 'Meera', restricted: false } }),
];

function me(overrides = {}) {
  return {
    user: { id: 'usr_admin', role: 'admin' },
    school: { id: 'sch_a', name: 'School A', timezone: 'Asia/Kolkata' },
    capabilities: ['crm.access', 'crm.leads.read', 'crm.leads.write', 'crm.tasks.read', 'crm.tasks.write'],
    sections: ['overview', 'leads', 'tasks'],
    support: false,
    taskScope: 'school',
    ...overrides,
  };
}

const TEACHER = me({ user: { id: 'usr_teacher', role: 'teacher' }, capabilities: ['crm.access', 'crm.tasks.read', 'crm.tasks.write'], taskScope: 'own' });

let calls;
let handlers;

function mockApi() {
  calls = [];
  globalThis.fetch = vi.fn(async (url, options = {}) => {
    const path = String(url).replace('/api/auth/crm/', '');
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ method: options.method || 'GET', path, body });
    const handler = handlers.find(([match]) => path.startsWith(match));
    const [status, payload] = handler ? handler[1](body, path) : [404, { error: { code: 'not_found', message: path } }];
    return { ok: status < 400, status, json: async () => payload };
  });
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  handlers = [
    ['tasks/summary', () => [200, { timezone: 'Asia/Kolkata', scope: 'school', mine: { overdue: 1, today: 1, upcoming: 1 }, all: { overdue: 2, today: 1, upcoming: 1, unassigned: 1 } }]],
    ['tasks/assignees', () => [200, { items: [{ userId: 'usr_admin', name: 'Admin A', role: 'admin' }, { userId: 'usr_staff', name: 'Staff A', role: 'staff' }], nextCursor: null }]],
    ['tasks?', () => [200, { items: TASKS, nextCursor: null, view: 'mine' }]],
  ];
  mockApi();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function renderTasks(user = me()) {
  return render(<MemoryRouter><TasksPage me={user} /></MemoryRouter>);
}

describe('Tasks page', () => {
  it('groups open tasks into Overdue, Today and Upcoming in school time', async () => {
    renderTasks();
    const overdue = (await screen.findByText('Call Mrs Shah')).closest('.rounded-2xl, [class*="rounded"]');
    expect(overdue).toBeTruthy();
    const cards = screen.getAllByRole('list').map((list) => within(list).getAllByRole('listitem').map((item) => item.textContent));
    expect(cards[0].join()).toContain('Call Mrs Shah');
    expect(cards[0].join()).toContain('Overdue ·');
    expect(cards[1].join()).toContain('Send fee details');
    expect(cards[1].join()).toContain('Today · 3:00 pm');
    expect(cards[2].join()).toContain('Trial class reminder');
    expect(screen.getByRole('link', { name: 'Lead: Meera' })).toHaveAttribute('href', '/crm/leads/lead_1');
    expect(screen.getByText('High')).toBeInTheDocument();
  });

  it('completes a task with its version and reloads the lists', async () => {
    handlers.unshift(['tasks/complete', (body) => [200, task({ id: body.taskId, status: 'done', version: 2 })]]);
    renderTasks();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Mark "Call Mrs Shah" done' }));
    await waitFor(() => expect(calls.map((call) => call.path)).toContain('tasks/complete'));
    expect(calls.find((call) => call.path === 'tasks/complete').body).toEqual({ taskId: 'task_1', expectedVersion: 1 });
    await waitFor(() => expect(calls.filter((call) => call.path.startsWith('tasks?')).length).toBe(2));
  });

  it('creates a task with the due time entered in IST', async () => {
    handlers.push(['tasks', (body) => [201, task({ id: 'task_new', title: body.title })]]);
    renderTasks();
    fireEvent.click(await screen.findByRole('button', { name: /New task/ }));
    const dialog = await screen.findByRole('dialog');
    const create = within(dialog).getByRole('button', { name: 'Create task' });
    expect(create).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('What needs doing'), { target: { value: 'Share timetable' } });
    fireEvent.change(within(dialog).getByLabelText('Due (IST)'), { target: { value: '2026-09-30T10:00' } });
    fireEvent.change(within(dialog).getByLabelText('Priority'), { target: { value: 'high' } });
    await within(dialog).findByRole('option', { name: 'Staff A' });
    fireEvent.change(within(dialog).getByLabelText('Assigned to'), { target: { value: 'usr_staff' } });
    fireEvent.click(create);
    await waitFor(() => expect(calls.some((call) => call.method === 'POST' && call.path === 'tasks')).toBe(true));
    expect(calls.find((call) => call.method === 'POST' && call.path === 'tasks').body).toEqual({
      title: 'Share timetable', dueAt: '2026-09-30T04:30:00.000Z', priority: 'high', ownerUserId: 'usr_staff',
    });
  });

  it('reschedules with a quick pick', async () => {
    handlers.unshift(['tasks/reschedule', (body) => [200, task({ dueAt: body.dueAt, version: 2 })]]);
    renderTasks();
    fireEvent.click(await screen.findByRole('button', { name: 'Reschedule "Call Mrs Shah"' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Tomorrow 10:00' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reschedule' }));
    await waitFor(() => expect(calls.some((call) => call.path === 'tasks/reschedule')).toBe(true));
    expect(calls.find((call) => call.path === 'tasks/reschedule').body).toEqual({ taskId: 'task_1', dueAt: '2026-09-29T04:30:00.000Z', expectedVersion: 1 });
  });

  it('gives own-only teachers no Everyone view, no reassign and no owner picker', async () => {
    renderTasks(TEACHER);
    await screen.findByText('Call Mrs Shah');
    expect(screen.queryByRole('button', { name: 'Everyone' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Reassign/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /New task/ }));
    expect(within(await screen.findByRole('dialog')).queryByLabelText('Assigned to')).not.toBeInTheDocument();
  });

  it('offers Undo right after a cancel, which reopens the task', async () => {
    handlers.unshift(
      ['tasks/cancel', (body) => [200, task({ id: body.taskId, status: 'cancelled', version: 2 })]],
      ['tasks/reopen', (body) => [200, task({ id: body.taskId, status: 'open', version: 3 })]],
    );
    renderTasks();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel "Call Mrs Shah"' }));
    const bar = await screen.findByText(/Cancelled .Call Mrs Shah./);
    fireEvent.click(within(bar.closest('[role="status"]')).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(calls.map((call) => call.path)).toContain('tasks/reopen'));
    expect(calls.find((call) => call.path === 'tasks/reopen').body).toEqual({ taskId: 'task_1', expectedVersion: 2 });
    await waitFor(() => expect(screen.queryByText(/Cancelled .Call Mrs Shah./)).not.toBeInTheDocument());
  });

  it('lets cancelled tasks be reopened from the Cancelled tab', async () => {
    handlers.unshift(['tasks?', (body, path) => [200, { items: path.includes('status=cancelled') ? [task({ status: 'cancelled' })] : TASKS, nextCursor: null }]]);
    renderTasks();
    await screen.findByText('Call Mrs Shah');
    fireEvent.click(screen.getByRole('button', { name: 'Cancelled' }));
    expect(await screen.findByRole('button', { name: /Reopen/ })).toBeInTheDocument();
  });

  it('shows done tasks with a Reopen action', async () => {
    handlers.unshift(['tasks?', (body, path) => [200, { items: path.includes('status=done') ? [task({ status: 'done', completedAt: new Date(NOW).toISOString() })] : TASKS, nextCursor: null }]]);
    renderTasks();
    await screen.findByText('Call Mrs Shah');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(await screen.findByRole('button', { name: /Reopen/ })).toBeInTheDocument();
  });
});

describe('Tasks nav badge', () => {
  it('shows overdue plus due-today on the Tasks link, red when something is overdue', async () => {
    render(
      <MemoryRouter initialEntries={['/crm']}>
        <Routes><Route path="/crm" element={<CrmLayout me={me()} />} /></Routes>
      </MemoryRouter>,
    );
    const badges = await screen.findAllByLabelText('1 overdue, 1 due today');
    expect(badges[0]).toHaveTextContent('2');
    expect(badges[0].className).toMatch(/bg-destructive/);
  });
});

describe('Lead owner change', () => {
  const lead = {
    id: 'lead_1', learnerName: 'Meera', learnerGrade: '9', stage: { id: 'st_new', name: 'New inquiry', category: 'open' }, lifecycle: 'lead',
    source: null, interest: { course: null, schedule: null }, ownerUserId: 'usr_admin', owner: { userId: 'usr_admin', name: 'Admin A' },
    lostReasonKey: null, lostReason: null, convertedStudentId: null, hasContact: false, contact: null, version: 3,
    createdAt: '2026-09-27T09:00:00.000Z', lastActivityAt: '2026-09-27T09:00:00.000Z', ownerOpenTaskCount: 2, stageHistory: [], notes: [],
  };

  it('offers to move the lead\'s open tasks to the new owner', async () => {
    handlers.unshift(
      ['leads/detail', () => [200, lead]],
      ['settings/pipeline', () => [200, { stages: [] }]],
      ['leads/owners', () => [200, { items: [{ userId: 'usr_admin', name: 'Admin A' }, { userId: 'usr_staff', name: 'Staff A' }], nextCursor: null }]],
      ['leads/owner', () => [200, { ...lead, owner: { userId: 'usr_staff', name: 'Staff A' }, movedTaskCount: 2 }]],
    );
    render(
      <MemoryRouter initialEntries={['/crm/leads/lead_1']}>
        <Routes><Route path="/crm/leads/:leadId" element={<LeadProfile me={me()} />} /></Routes>
      </MemoryRouter>,
    );
    fireEvent.change(await screen.findByLabelText('Owner'), { target: { value: 'usr_staff' } });
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Admin A has 2 open tasks for this lead/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move lead and tasks' }));
    await waitFor(() => expect(calls.some((call) => call.path === 'leads/owner')).toBe(true));
    expect(calls.find((call) => call.path === 'leads/owner').body).toEqual({ leadId: 'lead_1', expectedVersion: 3, ownerUserId: 'usr_staff', moveOpenTasks: true });
    expect(await screen.findByRole('heading', { name: 'Open tasks' })).toBeInTheDocument();
  });

  it('refreshes the task count after a task is added from the profile', async () => {
    let count = 1;
    handlers.unshift(
      ['leads/detail', () => [200, { ...lead, ownerOpenTaskCount: count }]],
      ['settings/pipeline', () => [200, { stages: [] }]],
      ['leads/owners', () => [200, { items: [{ userId: 'usr_admin', name: 'Admin A' }, { userId: 'usr_staff', name: 'Staff A' }], nextCursor: null }]],
    );
    handlers.push(['tasks', () => { count = 2; return [201, task({ id: 'task_new' })]; }]);
    render(
      <MemoryRouter initialEntries={['/crm/leads/lead_1']}>
        <Routes><Route path="/crm/leads/:leadId" element={<LeadProfile me={me()} />} /></Routes>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /Add task/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('What needs doing'), { target: { value: 'Book trial' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create task' }));
    await waitFor(() => expect(calls.filter((call) => call.path.startsWith('leads/detail')).length).toBe(2));
    fireEvent.change(screen.getByLabelText('Owner'), { target: { value: 'usr_staff' } });
    expect(await screen.findByText(/Admin A has 2 open tasks for this lead/)).toBeInTheDocument();
  });
});
