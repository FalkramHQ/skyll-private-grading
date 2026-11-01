// Students and guardians UI (FLKRM-326 S4): list, profile sections by
// capability, report link, and guardian actions.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import GuardiansCard from '../../components/crm/students/GuardiansCard';
import StudentProfile from '../../components/crm/students/StudentProfile';
import StudentsPage from '../../components/crm/students/StudentsPage';

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

function me(capabilities, extra = {}) {
  return {
    user: { id: 'usr_admin', role: 'admin' }, school: { id: 'sch_a', name: 'A', timezone: 'Asia/Kolkata' },
    capabilities, sections: ['students'], support: false, taskScope: 'school', crmOnly: false, ...extra,
  };
}
const ADMIN = me(['crm.access', 'crm.students.read', 'crm.students.write', 'crm.contacts.read', 'crm.contacts.write', 'crm.progress.read', 'crm.leads.read']);
const TEACHER = me(['crm.access', 'crm.students.read', 'crm.progress.read'], { user: { id: 'usr_teacher', role: 'teacher' } });

const student = {
  id: 'stu_riya', name: 'Riya Shah', status: 'active', lifecycle: 'enrolled', standard: '9', hasLogin: true, owner: null, ownerUserId: null, version: 0,
  reportUsername: 'riya01', tags: [], convertedFromLead: { id: 'lead_1', name: 'Riya Shah' },
  batches: [
    { membershipId: 'bm1', batchId: 'b_math', name: 'Grade 9 Maths', status: 'active', joinedAt: '2026-06-01T00:00:00.000Z', leftAt: null },
    { membershipId: 'bm2', batchId: 'b_old', name: 'Grade 8 Science', status: 'inactive', joinedAt: '2025-06-01T00:00:00.000Z', leftAt: '2026-04-01T00:00:00.000Z' },
  ],
  enrollments: [{ id: 'e1', academicYear: '2026-27', standard: '9', status: 'active', isCurrent: true }],
  progress: [{ id: 'sub1', examName: 'Unit test 1', subject: 'Mathematics', date: '2026-07-10', score: 34, maxMarks: 40, reportPublished: true }],
};

function guardian(overrides = {}) {
  return {
    linkId: 'gl_mother', studentId: 'stu_riya', relationship: 'mother', isPrimary: true, isEmergency: false, isFeePayer: true, version: 1,
    contact: { id: 'ct_1', name: 'Sunita Shah', phone: '+919820011122', email: null, preferredChannel: 'whatsapp', whatsappOptIn: true, consentAt: '2026-06-01T00:00:00.000Z', consentSource: 'roster_import', version: 1 },
    alsoGuardianOf: [], ...overrides,
  };
}

function renderProfile(user) {
  return render(
    <MemoryRouter initialEntries={['/crm/students/stu_riya']}>
      <Routes><Route path="/crm/students/:studentId" element={<StudentProfile me={user} />} /></Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  handlers = [
    ['students/detail', 'GET', () => [200, student]],
    ['students/owners', 'GET', () => [200, { items: [{ userId: 'usr_admin', name: 'Admin A' }], nextCursor: null }]],
    ['students/guardians?', 'GET', () => [200, { items: [guardian()], nextCursor: null }]],
    ['students/batches', 'GET', () => [200, { items: [{ id: 'b_math', name: 'Grade 9 Maths' }], nextCursor: null }]],
    ['students?', 'GET', () => [200, { items: [{ ...student, batches: [{ id: 'b_math', name: 'Grade 9 Maths' }], primaryGuardian: { name: 'Sunita Shah', phone: '+919820011122' } }], nextCursor: null }]],
  ];
  mockApi();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Students list', () => {
  it('shows batches, class and the primary guardian with contact access, and filters by status and batch', async () => {
    render(<MemoryRouter><StudentsPage me={ADMIN} /></MemoryRouter>);
    const row = (await screen.findByRole('link', { name: 'Riya Shah' })).closest('tr');
    expect(within(row).getByText('Grade 9 Maths')).toBeInTheDocument();
    expect(within(row).getByText(/Sunita Shah/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Alumni' }));
    await waitFor(() => expect(calls.some((call) => call.path.includes('status=alumni'))).toBe(true));
    fireEvent.change(screen.getByLabelText('Filter by batch'), { target: { value: 'b_math' } });
    await waitFor(() => expect(calls.some((call) => call.path.includes('batchId=b_math'))).toBe(true));
  });

  it('has no guardian column without contact access', async () => {
    render(<MemoryRouter><StudentsPage me={TEACHER} /></MemoryRouter>);
    await screen.findByRole('link', { name: 'Riya Shah' });
    expect(screen.queryByText('Primary guardian')).not.toBeInTheDocument();
  });
});

describe('Student profile', () => {
  it('shows batches, assessments, the report link, admissions history and guardians for an admin', async () => {
    renderProfile(ADMIN);
    expect(await screen.findByRole('heading', { name: 'Riya Shah' })).toBeInTheDocument();
    expect(screen.getByText('Grade 8 Science')).toBeInTheDocument();
    expect(screen.getByText('34/40')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open full report/ })).toHaveAttribute('href', '/student/riya01');
    expect(screen.getByRole('link', { name: /Admissions history/ })).toHaveAttribute('href', '/crm/leads/lead_1');
    expect(await screen.findByText('Sunita Shah')).toBeInTheDocument();
  });

  it('hides guardians from a teacher and the report link from CRM-only staff', async () => {
    renderProfile(TEACHER);
    await screen.findByRole('heading', { name: 'Riya Shah' });
    expect(screen.queryByRole('heading', { name: 'Guardians' })).not.toBeInTheDocument();
    expect(calls.some((call) => call.path.startsWith('students/guardians'))).toBe(false);
    expect(screen.getByLabelText('CRM owner')).toBeDisabled();
    // Teachers can add notes on students they can see (D14a), but not tag them.
    expect(screen.getByLabelText('New note')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add tag' })).not.toBeInTheDocument();
    cleanup();
    renderProfile({ ...ADMIN, crmOnly: true });
    await screen.findByRole('heading', { name: 'Riya Shah' });
    expect(screen.queryByRole('link', { name: /Open full report/ })).not.toBeInTheDocument();
  });

  it('sets the CRM owner with the profile version', async () => {
    handlers.unshift(['students/owner', 'POST', () => [200, { ...student, version: 1 }]]);
    renderProfile(ADMIN);
    fireEvent.change(await screen.findByLabelText('CRM owner'), { target: { value: 'usr_admin' } });
    await waitFor(() => expect(posts('students/owner')).toEqual([{ studentId: 'stu_riya', ownerUserId: 'usr_admin', expectedVersion: 0 }]));
  });
});

describe('Guardians card', () => {
  function renderCard(items) {
    handlers.unshift(['students/guardians?', 'GET', () => [200, { items, nextCursor: null }]]);
    return render(<GuardiansCard studentId="stu_riya" me={ADMIN} />);
  }

  it('adds the first guardian as primary and fee payer by default', async () => {
    handlers.unshift(['students/guardians', 'POST', () => [201, { guardian: guardian(), reusedContact: null }]]);
    renderCard([]);
    expect(await screen.findByText('No guardian on file.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Add/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/first guardian becomes the primary/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/Pays the fees/)).toBeChecked();
    fireEvent.change(within(dialog).getByLabelText('Phone'), { target: { value: '12345' } });
    fireEvent.blur(within(dialog).getByLabelText('Phone'));
    expect(within(dialog).getByText(/Enter a valid mobile number/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Phone'), { target: { value: '98200 11122' } });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Sunita Shah' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add guardian' }));
    await waitFor(() => expect(posts('students/guardians')).toEqual([{
      studentId: 'stu_riya', contact: { phone: '98200 11122', name: 'Sunita Shah', whatsappOptIn: false }, relationship: 'mother', isEmergency: false, isFeePayer: true,
    }]));
  });

  it('makes another guardian primary, and blocks removing the primary while others remain', async () => {
    handlers.unshift(['students/guardians/primary', 'POST', () => [200, {}]], ['students/guardians/remove', 'POST', () => [200, { removed: true }]]);
    renderCard([guardian(), guardian({ linkId: 'gl_father', relationship: 'father', isPrimary: false, isFeePayer: false, version: 3, contact: { ...guardian().contact, id: 'ct_2', name: 'Raj Shah', phone: '+919820033344' } })]);
    const mother = (await screen.findByText('Sunita Shah')).closest('li');
    expect(within(mother).getByRole('button', { name: 'Remove' })).toBeDisabled();
    expect(within(mother).getByText(/Make another guardian primary before removing/)).toBeInTheDocument();

    const father = screen.getByText('Raj Shah').closest('li');
    fireEvent.click(within(father).getByRole('button', { name: 'Make primary' }));
    await waitFor(() => expect(posts('students/guardians/primary')).toEqual([{ linkId: 'gl_father', expectedVersion: 3 }]));
    fireEvent.click(within(father).getByRole('button', { name: 'Remove' }));
    fireEvent.click(within(within(father).getByRole('group', { name: 'Confirm removal' })).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(posts('students/guardians/remove')).toEqual([{ linkId: 'gl_father', expectedVersion: 3 }]));
  });

  it('edits a shared contact with a warning, sending contact and link changes separately', async () => {
    handlers.unshift(['contacts/update', 'POST', () => [200, {}]], ['students/guardians/update', 'POST', () => [200, guardian()]]);
    renderCard([guardian({ alsoGuardianOf: [{ studentId: 'stu_arjun', name: 'Arjun Shah' }] })]);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Also guardian of Arjun Shah/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Email'), { target: { value: 'sunita@example.com' } });
    fireEvent.click(within(dialog).getByLabelText(/Agreed to WhatsApp updates/));
    fireEvent.click(within(dialog).getByLabelText(/Emergency contact/));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(posts('students/guardians/update')).toHaveLength(1));
    expect(posts('contacts/update')).toEqual([{ contactId: 'ct_1', expectedVersion: 1, email: 'sunita@example.com', whatsappOptIn: false }]);
    expect(posts('students/guardians/update')).toEqual([{ linkId: 'gl_mother', expectedVersion: 1, isEmergency: true }]);
  });
});
