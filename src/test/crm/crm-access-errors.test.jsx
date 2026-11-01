// CRM shell error handling with the real route guard. Office staff are
// CRM-only: ProtectedRoute sends them from /dashboard back to /crm, so a CRM
// error must never redirect them to /dashboard (that looped forever).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

const session = vi.hoisted(() => ({
  useSession: vi.fn(),
  clearSession: vi.fn(),
  invalidateSessionCache: vi.fn(),
  setSession: vi.fn(),
  loginPathForSchool: () => '/partnerb',
}));
vi.mock('../../lib/auth', () => session);
vi.mock('../../data/studentData', () => ({
  loadStudentData: vi.fn().mockResolvedValue({}),
  loadTeacherData: vi.fn().mockResolvedValue({}),
}));

import { ProtectedRoute } from '../../App';
import CrmApp from '../../pages/crm/CrmApp';

const ME = {
  user: { id: 'usr_1', username: 'desk', role: 'staff' },
  school: { id: 'sch_demo', name: 'Skyll Demo School' },
  capabilities: ['crm.access'],
  sections: ['overview'],
  support: false,
};

let meResponses;
function meCalls() {
  return globalThis.fetch.mock.calls.filter(([url]) => String(url).endsWith('/crm/me'));
}

function LoginProbe() {
  const location = useLocation();
  return <p>login page {location.search}</p>;
}

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/crm/*" element={<CrmApp />} />
        <Route path="/dashboard" element={<ProtectedRoute><p>dashboard page</p></ProtectedRoute>} />
        <Route path="/review-login" element={<LoginProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

function signedInAs(role) {
  session.useSession.mockReturnValue({ user: { username: 'u1', role, school: 'Demo' }, loading: false, isAuthenticated: true });
}

beforeEach(() => {
  sessionStorage.clear();
  meResponses = [];
  globalThis.fetch = vi.fn(async (url) => {
    const u = String(url);
    if (u.endsWith('/crm/me')) {
      const next = meResponses.length > 1 ? meResponses.shift() : meResponses[0];
      if (next === 'network') throw new TypeError('Failed to fetch');
      const [status, body] = next;
      return { ok: status < 400, status, json: async () => body };
    }
    return { ok: true, status: 200, json: async () => ({ items: [], nextCursor: null }) };
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('CRM access errors', () => {
  it('shows staff without CRM access a sign-out card instead of looping through /dashboard', async () => {
    signedInAs('staff');
    meResponses = [[403, { error: { code: 'forbidden', message: 'No CRM access' } }]];
    renderAt('/crm');
    expect(await screen.findByText("CRM isn't available for your account")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(meCalls()).toHaveLength(1);
    expect(screen.queryByText('dashboard page')).toBeNull();
  });

  it('shows staff the same card when the CRM is off for the school (404)', async () => {
    signedInAs('staff');
    meResponses = [[404, { error: { code: 'not_found', message: 'Not found' } }]];
    renderAt('/crm');
    expect(await screen.findByText("CRM isn't available for your account")).toBeInTheDocument();
    expect(meCalls()).toHaveLength(1);
  });

  it('still sends a teacher without CRM access to their dashboard', async () => {
    signedInAs('teacher');
    meResponses = [[403, { error: { code: 'forbidden', message: 'No CRM access' } }]];
    renderAt('/crm');
    expect(await screen.findByText('dashboard page')).toBeInTheDocument();
  });

  it('on 401 drops the cached session and goes to login with a return path', async () => {
    signedInAs('staff');
    meResponses = [[401, { error: { code: 'unauthenticated', message: 'Sign in' } }]];
    renderAt('/crm/leads');
    expect(await screen.findByText(/login page/)).toHaveTextContent('from=%2Fcrm%2Fleads');
    expect(session.invalidateSessionCache).toHaveBeenCalled();
    expect(session.clearSession).toHaveBeenCalled();
  });

  it('offers a retry on a server error and recovers', async () => {
    signedInAs('staff');
    meResponses = [[503, { error: { code: 'unavailable', message: 'Try again' } }], [200, ME]];
    renderAt('/crm');
    expect(await screen.findByText("Couldn't load the CRM")).toBeInTheDocument();
    expect(screen.queryByText('dashboard page')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findAllByText('Skyll Demo School')).not.toHaveLength(0);
    expect(meCalls()).toHaveLength(2);
  });

  it('offers a retry when the network is down', async () => {
    signedInAs('admin');
    meResponses = ['network'];
    renderAt('/crm');
    expect(await screen.findByText("Couldn't load the CRM")).toBeInTheDocument();
    await waitFor(() => expect(meCalls()).toHaveLength(1));
  });
});
