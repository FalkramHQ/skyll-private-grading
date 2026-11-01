import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const api = vi.hoisted(() => ({ getStudentProfile: vi.fn() }));
vi.mock('../lib/db', () => api);
vi.mock('../lib/session', () => ({ signOut: vi.fn() }));
vi.mock('../lib/auth', () => ({ loginPathForSchool: vi.fn(() => '/individual') }));

import StudentProfile from '../pages/StudentProfile.jsx';

describe('StudentProfile', () => {
  afterEach(() => vi.clearAllMocks());

  it('shows read-only academic fields and no password form for students', async () => {
    api.getStudentProfile.mockResolvedValue({
      profile: { name: 'Aarav Shah', username: 'ab12cd', class: '10', school: 'Example School', batches: ['Science A'], board: 'CBSE' },
    });

    render(<MemoryRouter initialEntries={['/profile']}><Routes><Route path="/profile" element={<StudentProfile />} /></Routes></MemoryRouter>);

    expect(await screen.findByText('Academic information')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Aarav Shah' })).toBeInTheDocument();
    expect(screen.getByText('Science A')).toBeInTheDocument();
    expect(screen.getByText(/school-managed details are read-only/i)).toBeInTheDocument();

    // Student password self-service is disabled — no form or button should render.
    expect(screen.queryByText(/account security/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change password' })).not.toBeInTheDocument();
    expect(screen.queryByText(/current password/i)).not.toBeInTheDocument();
  });
});
