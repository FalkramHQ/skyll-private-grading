import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const session = vi.hoisted(() => ({ useSession: vi.fn(), clearSession: vi.fn(), invalidateSessionCache: vi.fn(), setSession: vi.fn() }));
vi.mock('../../lib/auth', () => session);

import CrmApp from '../../pages/crm/CrmApp';

function me(overrides = {}) {
  return {
    user: { id: 'usr_1', username: 'demo', role: 'admin' },
    school: { id: 'sch_demo', name: 'Skyll Demo School' },
    capabilities: ['crm.access'],
    sections: ['overview', 'leads', 'students', 'classes', 'attendance', 'fees', 'communications', 'reports', 'settings'],
    support: false,
    ...overrides,
  };
}

function mockApi(handlers) {
  globalThis.fetch = vi.fn(async (url) => {
    const key = String(url).replace('/api/auth/crm/', '');
    const [status, body] = handlers[key] || [404, { error: { code: 'not_found', message: 'Not found' } }];
    return { ok: status < 400, status, json: async () => body };
  });
}

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/crm/*" element={<CrmApp />} />
        <Route path="/dashboard" element={<p>dashboard page</p>} />
        <Route path="/review-login" element={<p>login page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

function sidebar() {
  return within(screen.getAllByRole('navigation', { name: 'CRM sections' })[0]);
}

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('CRM shell guard', () => {
  it('sends signed-out visitors to login', () => {
    session.useSession.mockReturnValue({ user: null, loading: false, isAuthenticated: false });
    renderAt('/crm');
    expect(screen.getByText('login page')).toBeInTheDocument();
  });

  it('never shows the CRM to students', () => {
    session.useSession.mockReturnValue({ user: { role: 'student' }, loading: false, isAuthenticated: true });
    mockApi({});
    renderAt('/crm');
    expect(screen.getByText('dashboard page')).toBeInTheDocument();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('leaves when the server hides the CRM (flag off)', async () => {
    session.useSession.mockReturnValue({ user: { role: 'admin' }, loading: false, isAuthenticated: true });
    mockApi({ me: [404, { error: { code: 'not_found', message: 'Not found' } }] });
    renderAt('/crm');
    expect(await screen.findByText('dashboard page')).toBeInTheDocument();
  });

  it('shows all nine sections to an admin', async () => {
    session.useSession.mockReturnValue({ user: { role: 'admin' }, loading: false, isAuthenticated: true });
    mockApi({ me: [200, me()] });
    renderAt('/crm');
    expect(await screen.findAllByText('Skyll Demo School')).not.toHaveLength(0);
    const labels = sidebar().getAllByRole('link').map((link) => link.textContent);
    expect(labels).toEqual(['Overview', 'Leads', 'Students', 'Classes', 'Attendance', 'Fees', 'Communications', 'Reports', 'Settings']);
  });

  it('hides sections the server did not allow and redirects direct links to them', async () => {
    session.useSession.mockReturnValue({ user: { role: 'teacher' }, loading: false, isAuthenticated: true });
    mockApi({ me: [200, me({ sections: ['overview', 'students', 'classes', 'attendance'] })] });
    renderAt('/crm/fees');
    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument();
    const labels = sidebar().getAllByRole('link').map((link) => link.textContent);
    expect(labels).toEqual(['Overview', 'Students', 'Classes', 'Attendance']);
  });

  it('asks platform staff to pick a school, then sends it as X-Skyll-School', async () => {
    session.useSession.mockReturnValue({ user: { role: 'skyll_admin' }, loading: false, isAuthenticated: true });
    mockApi({
      schools: [200, { items: [{ id: 'sch_demo', slug: 'skyll-demo', name: 'Skyll Demo School', crmEnabled: true }], nextCursor: null }],
      me: [200, me({ support: true })],
    });
    renderAt('/crm');
    const picker = await screen.findByRole('combobox', { name: 'School' });
    await screen.findByRole('option', { name: 'Skyll Demo School' });
    fireEvent.change(picker, { target: { value: 'sch_demo' } });
    expect(await screen.findAllByText('Support')).toHaveLength(2); // desktop + mobile header
    const meCall = globalThis.fetch.mock.calls.find(([url]) => String(url).endsWith('/me'));
    expect(meCall[1].headers['X-Skyll-School']).toBe('sch_demo');
    expect(sessionStorage.getItem('skyll.crm.supportSchoolId')).toBe('sch_demo');
  });
});
