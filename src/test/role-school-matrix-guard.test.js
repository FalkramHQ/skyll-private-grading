// FLKRM-386 guard: every API entry point must declare how its role × school
// authorization is tested. A new route (router key, vl-queue action, or api/
// file) fails here until it is added to src/test/matrix/routeRegistry.js.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverRoutes } from './matrix/discoverRoutes.js';
import { ROUTE_REGISTRY } from './matrix/routeRegistry.js';
import { MATRIX_ROUTES } from './matrix/matrixRoutes.js';

const discovered = discoverRoutes();

describe('role × school route registry (FLKRM-386)', () => {
  it('discovers the API surface (sanity: the parser still works)', () => {
    expect(discovered.length).toBeGreaterThan(50);
    expect(discovered).toEqual(expect.arrayContaining(['auth/login', 'ai/tutor', 'intake/tests', 'vl-queue/GET', 'query']));
  });

  it('registers every discovered route', () => {
    const missing = discovered.filter((route) => !ROUTE_REGISTRY[route]);
    expect(missing, `Add these routes to src/test/matrix/routeRegistry.js and test them: ${missing.join(', ')}`).toEqual([]);
  });

  it('lists no route that no longer exists', () => {
    const stale = Object.keys(ROUTE_REGISTRY).filter((route) => !discovered.includes(route));
    expect(stale, `Remove stale registry entries: ${stale.join(', ')}`).toEqual([]);
  });

  it('gives every non-matrix route a real test file or a written reason', () => {
    for (const [route, entry] of Object.entries(ROUTE_REGISTRY)) {
      expect(['matrix', 'covered', 'public', 'self'], route).toContain(entry.kind);
      if (entry.kind === 'covered' || entry.kind === 'self') {
        expect(entry.by?.length, `${route} must name its test file(s)`).toBeGreaterThan(0);
      }
      if (entry.kind === 'public' || entry.kind === 'self') {
        expect(entry.why, `${route} must say why it is ${entry.kind}`).toBeTruthy();
      }
      for (const file of entry.by || []) {
        expect(existsSync(path.join(import.meta.dirname, file)), `${route}: ${file} does not exist`).toBe(true);
      }
    }
  });

  it('has a matrix row for every route registered as matrix, and none extra', () => {
    const registered = Object.entries(ROUTE_REGISTRY).filter(([, entry]) => entry.kind === 'matrix').map(([route]) => route).sort();
    const rows = [...new Set(MATRIX_ROUTES.map((row) => row.route))].sort();
    expect(rows).toEqual(registered);
  });
});
