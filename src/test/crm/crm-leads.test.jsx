// Leads workspace UI (FLKRM-326 S1): board, lost-reason dialog, duplicate
// warning, and contact fields shown only with contact access.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import LeadsPage from '../../components/crm/leads/LeadsPage';
import LeadProfile from '../../components/crm/leads/LeadProfile';

const stages = [
  { id: 'st_new', key: 'new_inquiry', name: 'New inquiry', category: 'open', position: 0, version: 1 },
  { id: 'st_contacted', key: 'contacted', name: 'Contacted', category: 'open', position: 1, version: 1 },
  { id: 'st_app', key: 'application', name: 'Application', category: 'applicant', position: 2, version: 1 },
  { id: 'st_won', key: 'enrolled', name: 'Enrolled', category: 'won', position: 3, version: 1 },
  { id: 'st_lost', key: 'lost', name: 'Lost', category: 'lost', position: 4, version: 1 },
];

function lead(overrides = {}) {
  return {
    id: 'lead_1', learnerName: 'Meera', learnerGrade: '9', stage: { id: 'st_new', name: 'New inquiry', category: 'open' },
    lifecycle: 'lead', source: null, interest: { course: 'Grade 9 Maths', schedule: null }, ownerUserId: 'usr_admin',
    owner: { userId: 'usr_admin', name: 'Admin A' }, lostReasonKey: null, lostReason: null, convertedStudentId: null,
    hasContact: true, contact: null, version: 1, createdAt: '2026-09-20T09:00:00.000Z', lastActivityAt: '2026-09-20T09:00:00.000Z',
    ...overrides,
  };
}

function me(capabilities) {
  return { user: { id: 'usr_admin', role: 'admin' }, school: { id: 'sch_a', name: 'A' }, capabilities, sections: ['leads'], support: false };
}

const ADMIN = me(['crm.access', 'crm.leads.read', 'crm.leads.write', 'crm.contacts.read', 'crm.contacts.write', 'crm.students.read']);
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

function renderLeads(user = ADMIN, path = '/crm/leads') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/crm/leads" element={<LeadsPage me={user} />} />
        <Route path="/crm/leads/:leadId" element={<LeadProfile me={user} />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  handlers = [
    ['settings/pipeline', () => [200, { id: 'pl', version: 1, stages }]],
    ['leads/owners', () => [200, { items: [{ userId: 'usr_admin', name: 'Admin A', role: 'admin' }], nextCursor: null }]],
    ['leads/duplicates', () => [200, { matches: [] }]],
    ['leads?', () => [200, { items: [lead(), lead({ id: 'lead_2', learnerName: 'Kabir', owner: null, stage: { id: 'st_app', name: 'Application', category: 'applicant' } })], nextCursor: null }]],
  ];
  mockApi();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Leads board', () => {
  it('groups leads by stage, flags unowned leads, and never offers Enrolled as a move', async () => {
    renderLeads();
    const newColumn = await screen.findByRole('region', { name: 'New inquiry stage' });
    expect(within(newColumn).getByText('Meera')).toBeInTheDocument();
    expect(within(newColumn).getByText('1')).toBeInTheDocument();
    // An empty column shows 0, not the stage type.
    expect(within(screen.getByRole('region', { name: 'Contacted stage' })).getByText('0')).toBeInTheDocument();
    const appColumn = screen.getByRole('region', { name: 'Application stage' });
    expect(within(appColumn).getByText('Unowned')).toBeInTheDocument();

    const move = within(newColumn).getByRole('combobox', { name: 'Move Meera to stage' });
    const options = within(move).getAllByRole('option').map((option) => option.textContent);
    expect(options).toEqual(['Move to…', 'Contacted', 'Application', 'Lost']);
  });

  it('asks for a lost reason before moving to Lost; Other needs a note', async () => {
    handlers.unshift(['leads/stage', (body) => [200, lead({ stage: { id: 'st_lost', name: 'Lost', category: 'lost' }, lostReasonKey: body.lostReasonKey, lostReason: body.reason || null, version: 2 })]]);
    renderLeads();
    const newColumn = await screen.findByRole('region', { name: 'New inquiry stage' });
    fireEvent.change(within(newColumn).getByRole('combobox', { name: 'Move Meera to stage' }), { target: { value: 'st_lost' } });

    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Mark as lost' });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'other' } });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Note (required)'), { target: { value: 'Moved city' } });
    fireEvent.click(confirm);

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.find((call) => call.path === 'leads/stage').body).toEqual({
      leadId: 'lead_1', toStageId: 'st_lost', expectedVersion: 1, lostReasonKey: 'other', reason: 'Moved city',
    });
    const lostColumn = screen.getByRole('region', { name: 'Lost stage' });
    expect(within(lostColumn).getByText('Other: Moved city')).toBeInTheDocument();
  });

  it('shows possible duplicates and only creates after "Create anyway"', async () => {
    let created = 0;
    handlers.unshift(['leads/duplicates', () => [200, { matches: [{ kind: 'lead', id: 'lead_1', name: 'Meera', reasons: ['phone'], stage: { name: 'New inquiry', category: 'open' }, ownerName: 'Admin A', convertedStudentId: null }] }]]);
    handlers.unshift(['leads/detail', () => [200, { ...lead({ id: 'lead_9' }), stageHistory: [], notes: [] }]]);
    handlers.push(['leads', (body) => { created += 1; return [201, lead({ id: 'lead_9', learnerName: body.learnerName })]; }]);
    renderLeads();
    fireEvent.click(await screen.findByRole('button', { name: /New lead/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Student name'), { target: { value: 'Meera' } });
    fireEvent.change(within(dialog).getByLabelText('Parent phone'), { target: { value: '98200 11122' } });

    expect(await within(dialog).findByText(/this family may already be in the CRM/)).toBeInTheDocument();
    expect(within(dialog).getByText('Matched on:')).toBeInTheDocument();
    expect(within(dialog).getByText('Same parent phone')).toBeInTheDocument();
    expect(within(dialog).getByText('Owner:')).toBeInTheDocument();
    expect(within(dialog).getByText('Admin A')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create anyway' }));
    await waitFor(() => expect(created).toBe(1));
    expect(calls.find((call) => call.method === 'POST' && call.path === 'leads').body).toEqual(expect.objectContaining({
      learnerName: 'Meera', contact: { phone: '98200 11122', whatsappOptIn: false }, ownerUserId: 'usr_admin', acknowledgeDuplicates: true,
    }));
  });

  it('validates the phone in the form with the shared schema before calling the server', async () => {
    renderLeads();
    fireEvent.click(await screen.findByRole('button', { name: /New lead/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Student name'), { target: { value: 'Tara' } });
    const phone = within(dialog).getByLabelText('Parent phone');
    fireEvent.change(phone, { target: { value: '12345' } });
    fireEvent.blur(phone);
    expect(within(dialog).getByText(/Enter a valid mobile number/)).toBeInTheDocument();
    expect(phone).toHaveAttribute('aria-invalid', 'true');
    expect(within(dialog).getByRole('button', { name: 'Create lead' })).toBeDisabled();

    fireEvent.change(phone, { target: { value: '098200 11122' } });
    expect(within(dialog).getByText('Will be saved as +91 98200 11122')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Create lead' })).toBeEnabled();
    // The half-typed number never reached the duplicate check.
    await waitFor(() => expect(calls.some((call) => call.path.startsWith('leads/duplicates'))).toBe(true));
    expect(calls.filter((call) => call.path.startsWith('leads/duplicates')).every((call) => !call.path.includes('12345&') && !call.path.endsWith('12345'))).toBe(true);
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('moves the card at once and puts it back if the server refuses', async () => {
    handlers.unshift(['leads/stage', () => [422, { error: { code: 'invalid_transition', message: 'Cannot move leadStage from open to applicant.' } }]]);
    renderLeads();
    const newColumn = await screen.findByRole('region', { name: 'New inquiry stage' });
    fireEvent.change(within(newColumn).getByRole('combobox', { name: 'Move Meera to stage' }), { target: { value: 'st_contacted' } });
    expect(await screen.findByText(/Cannot move leadStage/)).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'New inquiry stage' })).getByText('Meera')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Contacted stage' })).queryByText('Meera')).not.toBeInTheDocument();
  });

  it('marks the active view and remembers the choice', async () => {
    renderLeads();
    const board = await screen.findByRole('button', { name: 'Board' });
    const list = screen.getByRole('button', { name: 'List' });
    expect(board).toHaveAttribute('aria-pressed', 'true');
    expect(list).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(list);
    expect(list).toHaveAttribute('aria-pressed', 'true');
    // The active view wears the primary button style.
    expect(list.className).toMatch(/bg-action/);
    expect(board.className).not.toMatch(/bg-action/);
    expect(screen.getByRole('table')).toBeInTheDocument();
    localStorage.clear();
  });

  it('makes cards draggable only for staff who can move leads', async () => {
    renderLeads();
    const card = (await screen.findByRole('region', { name: 'New inquiry stage' })).querySelector('li');
    expect(card).toHaveAttribute('aria-roledescription', 'Draggable lead');
    cleanup();
    renderLeads(me(['crm.access', 'crm.leads.read']));
    const readOnly = (await screen.findByRole('region', { name: 'New inquiry stage' })).querySelector('li');
    expect(readOnly).not.toHaveAttribute('aria-roledescription');
  });

  it('hides contact fields without contact access', async () => {
    renderLeads(me(['crm.access', 'crm.leads.read', 'crm.leads.write']));
    fireEvent.click(await screen.findByRole('button', { name: /New lead/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByLabelText('Parent phone')).not.toBeInTheDocument();
    expect(within(dialog).getByText(/add a note so the lead can be followed up/)).toBeInTheDocument();
  });

  it('is read-only without leads write access', async () => {
    renderLeads(me(['crm.access', 'crm.leads.read']));
    await screen.findByRole('region', { name: 'New inquiry stage' });
    expect(screen.queryByRole('button', { name: /New lead/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /Move .* to stage/ })).not.toBeInTheDocument();
  });
});

describe('Lead profile', () => {
  it('shows details, history and a restricted contact note without contact access', async () => {
    handlers.unshift(
      ['leads/detail', () => [200, { ...lead(), tags: [{ id: 'tag_1', label: 'Hot lead', color: 'red', archived: false }] }]],
      ['notes?', () => [200, { items: [{ id: 'n1', body: 'Prefers mornings', author: { userId: 'usr_admin', name: 'Admin A' }, createdAt: '2026-09-20T09:00:00.000Z', edited: false, version: 1, canEdit: false, canRemove: false }], nextCursor: null }]],
      ['timeline?', () => [200, { items: [{ id: 'stage:e1', kind: 'created', at: '2026-09-20T09:00:00.000Z', actorName: 'Admin A', to: { name: 'New inquiry', category: 'open' } }], nextCursor: null }]],
    );
    renderLeads(me(['crm.access', 'crm.leads.read']), '/crm/leads/lead_1');
    expect(await screen.findByRole('heading', { name: 'Meera' })).toBeInTheDocument();
    expect(screen.getByText('Grade 9 Maths')).toBeInTheDocument();
    expect(await screen.findByText('Prefers mornings')).toBeInTheDocument();
    expect(await screen.findByText(/Lead created in/)).toBeInTheDocument();
    // Read-only: tags show without remove or add controls, and there is no note composer.
    expect(screen.getByText('Hot lead')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove tag/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add tag' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('New note')).not.toBeInTheDocument();
    expect(screen.getByText(/don.t have access to contact details/)).toBeInTheDocument();
    expect(screen.getByLabelText('Owner')).toBeDisabled();
  });
});
