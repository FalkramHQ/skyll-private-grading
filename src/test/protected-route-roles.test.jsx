import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { vi, describe, expect, it, beforeEach } from 'vitest';

const session = { user: null };
vi.mock('../lib/auth', () => ({
  useSession: () => ({ user: session.user, loading: false, isAuthenticated: Boolean(session.user) }),
  loginPathForSchool: () => '/partnerb',
}));
vi.mock('../data/studentData', () => ({
  loadStudentData: vi.fn().mockResolvedValue({}),
  loadTeacherData: vi.fn().mockResolvedValue({}),
}));

import { ProtectedRoute } from '../App';

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/review" element={<ProtectedRoute roles={['teacher', 'admin', 'skyll_admin']}><div>review queue</div></ProtectedRoute>} />
        <Route path="/dashboard" element={<ProtectedRoute><div>role dashboard</div></ProtectedRoute>} />
        <Route path="/admin-dashboard" element={<div>operations</div>} />
        <Route path="/review-login" element={<div>review login</div>} />
        <Route path="/partnerb" element={<div>school login</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ProtectedRoute role allowlists', () => {
  beforeEach(() => { session.user = null; });

  it('lets a teacher open the review queue instead of bouncing to the login page', async () => {
    session.user = { username: 't1', role: 'teacher', school: 'Alpha' };
    renderAt('/review');
    expect(await screen.findByText('review queue')).toBeInTheDocument();
  });

  it('sends a signed-in student to their dashboard, not to a login loop', async () => {
    session.user = { username: 's1', role: 'student', school: 'Alpha' };
    renderAt('/review');
    expect(await screen.findByText('role dashboard')).toBeInTheDocument();
  });

  it('sends a signed-out visitor to the review login with a return path', async () => {
    renderAt('/review');
    expect(await screen.findByText('review login')).toBeInTheDocument();
  });

  it('routes a platform admin from /dashboard to operations instead of the student dashboard', async () => {
    session.user = { username: 'ops', role: 'skyll_admin', school: null };
    renderAt('/dashboard');
    expect(await screen.findByText('operations')).toBeInTheDocument();
  });
});
