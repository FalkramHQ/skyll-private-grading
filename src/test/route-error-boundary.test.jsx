// RouteErrorBoundary clears its error on navigation without remounting the
// route tree, so pages keep their state (and don't refetch) on every click.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router-dom';
import { useEffect } from 'react';
import { RouteErrorBoundary } from '../components/ErrorBoundary';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

const mounts = vi.fn();
function Shell() {
  useEffect(() => { mounts(); }, []);
  return <Outlet />;
}

function Boom() {
  throw new Error('boom');
}

function makeRouter(initial) {
  return createMemoryRouter([
    {
      path: '/',
      element: <RouteErrorBoundary><Shell /></RouteErrorBoundary>,
      children: [
        { path: 'a', element: <p>page a</p> },
        { path: 'b', element: <p>page b</p> },
        { path: 'broken', element: <Boom /> },
      ],
    },
  ], { initialEntries: [initial] });
}

afterEach(() => {
  cleanup();
  mounts.mockReset();
  vi.restoreAllMocks();
});

describe('RouteErrorBoundary', () => {
  it('keeps the route tree mounted across navigation', async () => {
    const router = makeRouter('/a');
    render(<RouterProvider router={router} />);
    expect(screen.getByText('page a')).toBeInTheDocument();
    await act(async () => { await router.navigate('/b'); });
    expect(screen.getByText('page b')).toBeInTheDocument();
    expect(mounts).toHaveBeenCalledTimes(1);
  });

  it('clears the error when the path changes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const router = makeRouter('/broken');
    render(<RouterProvider router={router} />);
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    await act(async () => { await router.navigate('/a'); });
    expect(screen.queryByText('Something went wrong')).toBeNull();
    expect(screen.getByText('page a')).toBeInTheDocument();
  });
});
