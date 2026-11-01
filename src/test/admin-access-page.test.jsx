import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AdminAccess from '../pages/AdminAccess';

const usersPayload = {
  users: [{ membershipId: 'mem_1', userId: 'user_1', displayName: 'Alpha Admin', loginId: 'alpha_admin', role: 'admin', schoolId: 'school_alpha', school: 'Alpha School', status: 'active', lastSessionAt: '2026-03-01T00:00:00.000Z' }],
  schools: [{ id: 'school_alpha', name: 'Alpha School' }],
  scope: { schoolId: 'school_alpha', role: null, includeStudents: false },
};

function mockFetch(routes) {
  const fetchMock = vi.fn(async (url, options = {}) => {
    const route = routes.find(([match]) => url.startsWith(match));
    if (!route) throw new Error(`Unexpected fetch ${url}`);
    const payload = typeof route[1] === 'function' ? route[1](url, options) : route[1];
    return { ok: true, status: 200, json: async () => payload };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

describe('admin access page', () => {
  it('lists users for a school admin without exposing platform-only tabs', async () => {
    localStorage.setItem('userRole', 'admin');
    mockFetch([['/api/auth/admin/users', usersPayload]]);
    render(<MemoryRouter><AdminAccess /></MemoryRouter>);
    expect(await screen.findByText('alpha_admin')).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'School admin' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Feature flags' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('School')).not.toBeInTheDocument();
  });

  it('creates a teacher and shows the credentials once', async () => {
    localStorage.setItem('userRole', 'admin');
    const fetchMock = mockFetch([
      ['/api/auth/admin/users', usersPayload],
      ['/api/auth/admin/teachers', { ok: true, teacher: { userId: 'user_2', displayName: 'Priya Sharma', loginId: 'alpha_priya_sharma', role: 'teacher', schoolId: 'school_alpha', school: 'Alpha School', loginUrl: '/alpha' }, password: 'Abcdefgh1234' }],
    ]);
    render(<MemoryRouter><AdminAccess /></MemoryRouter>);
    await screen.findByText('alpha_admin');
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Add teacher' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Add teacher' }));
    fireEvent.change(await screen.findByLabelText('Display name'), { target: { value: 'Priya Sharma' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create teacher login' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/auth/admin/teachers', expect.objectContaining({ method: 'POST', body: JSON.stringify({ displayName: 'Priya Sharma' }) })));
    expect(await screen.findByTestId('teacher-login-id')).toHaveTextContent('alpha_priya_sharma');
    expect(screen.getByTestId('teacher-password')).toHaveTextContent('Abcdefgh1234');
  });

  it('lets a platform admin toggle a school feature flag', async () => {
    localStorage.setItem('userRole', 'skyll_admin');
    const fetchMock = mockFetch([
      ['/api/auth/admin/users', { ...usersPayload, schools: [{ id: 'school_alpha', slug: 'alpha', name: 'Alpha School' }] }],
      ['/api/auth/admin/flags', (url, options) => (options.method === 'POST'
        ? { ok: true, flag: { schoolId: 'school_alpha', school: 'Alpha School', featureKey: 'crm', enabled: true, updatedBy: 'skyll_ops', updatedAt: '2026-03-01T00:00:00.000Z' } }
        : { features: ['review_scale_v2', 'mobile_portal_v2', 'deep_signals', 'crm'], flags: [], schools: [{ id: 'school_alpha', slug: 'alpha', name: 'Alpha School' }] })],
    ]);
    render(<MemoryRouter><AdminAccess /></MemoryRouter>);
    await screen.findByText('alpha_admin');
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Feature flags' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Feature flags' }));
    const toggle = await screen.findByRole('button', { name: 'Enable CRM for Alpha School' });
    fireEvent.click(toggle);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/auth/admin/flags', expect.objectContaining({ method: 'POST', body: JSON.stringify({ schoolId: 'school_alpha', featureKey: 'crm', enabled: true }) })));
    expect(await screen.findByRole('button', { name: 'Disable CRM for Alpha School' })).toBeInTheDocument();
  });
});
