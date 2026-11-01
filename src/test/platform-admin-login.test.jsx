import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SkyllAdminLogin from '../pages/SkyllAdminLogin';

const session = vi.hoisted(() => ({ signIn: vi.fn(), signOut: vi.fn() }));

vi.mock('../lib/session', () => session);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderLogin() {
  render(<MemoryRouter><SkyllAdminLogin /></MemoryRouter>);
}

describe('Skyll Admin login', () => {
  it('uses server authentication instead of browser-only credentials', async () => {
    session.signIn.mockResolvedValue({ username: 'skyll_admin', role: 'skyll_admin', school: 'Skyll' });
    renderLogin();

    fireEvent.change(screen.getByLabelText('Admin Username'), { target: { value: 'skyll_admin' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign In' }));

    await waitFor(() => expect(session.signIn).toHaveBeenCalledWith('skyll_admin', 'correct-password', { allowedRoles: ['skyll_admin'] }));
    expect(session.signOut).not.toHaveBeenCalled();
  });

  it('clears the server session when a non-platform account reaches this route', async () => {
    session.signIn.mockResolvedValue({ username: 'partnerc_admin', role: 'admin', school: 'Partner Academy C' });
    session.signOut.mockResolvedValue(undefined);
    renderLogin();

    fireEvent.change(screen.getByLabelText('Admin Username'), { target: { value: 'partnerc_admin' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign In' }));

    expect(await screen.findByText(/does not have Skyll platform administrator access/i)).toBeInTheDocument();
    expect(session.signOut).toHaveBeenCalledTimes(1);
  });
});
