import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SystemHealthPanel from '../components/SystemHealthPanel.jsx';

const payload = {
  generatedAt: '2026-07-29T12:00:00.000Z',
  overallStatus: 'warning',
  summary: { healthy: 2, warning: 1, critical: 0, unknown: 1, inactive: 0 },
  services: [
    { id: 'turso', name: 'Turso database', status: 'healthy', detail: 'A read query completed.', lastCheckedAt: '2026-07-29T12:00:00.000Z' },
    { id: 'worker', name: 'OCI processing worker', status: 'warning', detail: 'The latest worker heartbeat is delayed.', lastCheckedAt: '2026-07-29T11:58:00.000Z', source: 'heartbeat' },
  ],
  classes: [
    { id: 'batch_1', school: 'Skyll Academy', name: 'Class 10 A', grade: '10', studentCount: 20, status: 'healthy', detail: 'Class roster and required metadata are present.' },
  ],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('admin dashboard health panel', () => {
  it('shows health checks in the dashboard and refreshes them independently', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => payload });
    vi.stubGlobal('fetch', fetchMock);

    render(<SystemHealthPanel />);

    expect(await screen.findByRole('heading', { name: 'System health' })).toBeInTheDocument();
    expect(screen.getByText(/Overall status:/)).toBeInTheDocument();
    expect(screen.getAllByText('OCI processing worker')).toHaveLength(2);
    expect(screen.getByText('Class 10 A')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/health', { credentials: 'same-origin' });

    fireEvent.click(screen.getByRole('button', { name: 'Refresh health' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
