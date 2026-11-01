// CRM lists are latest-wins: a slow answer for an earlier filter or search
// must never replace the newer one already on screen.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useTasks } from '../../components/crm/tasks/useTasks';
import LeadsPage from '../../components/crm/leads/LeadsPage';

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function ok(body) {
  return { ok: true, status: 200, json: async () => body };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useTasks', () => {
  it('ignores a slow response for a filter the user already left', async () => {
    const slowMine = deferred();
    globalThis.fetch = vi.fn((url) => {
      if (String(url).includes('view=mine')) return slowMine.promise;
      return Promise.resolve(ok({ items: [{ id: 'all_1' }], nextCursor: null }));
    });
    const { result, rerender } = renderHook((props) => useTasks(props), { initialProps: { view: 'mine' } });
    rerender({ view: 'all' });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.tasks.map((task) => task.id)).toEqual(['all_1']);
    await act(async () => { slowMine.resolve(ok({ items: [{ id: 'mine_1' }], nextCursor: null })); });
    expect(result.current.tasks.map((task) => task.id)).toEqual(['all_1']);
  });
});

describe('LeadsPage search', () => {
  const stages = [{ id: 'st_new', key: 'new_inquiry', name: 'New inquiry', category: 'open', position: 0, version: 1 }];
  const ME = { user: { id: 'usr_admin', role: 'admin' }, school: { id: 'sch_a', name: 'A' }, capabilities: ['crm.access', 'crm.leads.read'], sections: ['leads'], support: false };
  function lead(id, learnerName) {
    return { id, learnerName, learnerGrade: '9', stage: { id: 'st_new', name: 'New inquiry', category: 'open' }, owner: null, tags: [], version: 1, lastActivityAt: '2026-09-20T09:00:00.000Z' };
  }

  it('keeps the newest search results and loads stages and owners once', async () => {
    const slow = deferred();
    globalThis.fetch = vi.fn((url) => {
      const path = String(url).replace('/api/auth/crm/', '');
      if (path.startsWith('settings/pipeline')) return Promise.resolve(ok({ stages }));
      if (path.startsWith('leads/owners')) return Promise.resolve(ok({ items: [], nextCursor: null }));
      const q = new URLSearchParams(path.split('?')[1]).get('q');
      if (q === 'Me') return slow.promise;
      if (q === 'Kab') return Promise.resolve(ok({ items: [lead('l2', 'Kabir')], nextCursor: null }));
      return Promise.resolve(ok({ items: [lead('l1', 'Meera'), lead('l2', 'Kabir')], nextCursor: null }));
    });
    localStorage.setItem('skyll.crm.leadsView', 'list');
    render(<MemoryRouter><LeadsPage me={ME} /></MemoryRouter>);
    const box = await screen.findByRole('textbox', { name: 'Search leads by student name' });

    fireEvent.change(box, { target: { value: 'Me' } });
    await waitFor(() => expect(globalThis.fetch.mock.calls.some(([url]) => String(url).includes('q=Me'))).toBe(true));
    fireEvent.change(box, { target: { value: 'Kab' } });
    await waitFor(() => expect(screen.queryByText('Meera')).toBeNull());
    expect(screen.getByText('Kabir')).toBeInTheDocument();

    await act(async () => { slow.resolve(ok({ items: [lead('l1', 'Meera')], nextCursor: null })); });
    expect(screen.queryByText('Meera')).toBeNull();
    expect(screen.getByText('Kabir')).toBeInTheDocument();

    const metaCalls = globalThis.fetch.mock.calls.filter(([url]) => /settings\/pipeline|leads\/owners/.test(String(url)));
    expect(metaCalls).toHaveLength(2);
  });
});
