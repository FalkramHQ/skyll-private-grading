import { beforeEach, describe, expect, it, vi } from 'vitest';

const fakeClient = vi.hoisted(() => ({ execute: vi.fn() }));

const env = vi.hoisted(() => ({ tursoUrl: 'file:/tmp/images-test.db', tursoAuthToken: 'token' }));

const auth = vi.hoisted(() => ({
  ensureAuthTables: vi.fn().mockResolvedValue(),
  requireUser: vi.fn(),
  schoolMatches: vi.fn((actual, expected) => actual === expected),
}));

const storage = vi.hoisted(() => ({ getObject: vi.fn() }));

vi.mock('@libsql/client/web', () => ({ createClient: vi.fn(() => fakeClient) }));
vi.mock('../../api/_lib/env.js', () => env);
vi.mock('../../api/_lib/auth.js', () => auth);
vi.mock('../../api/_lib/canonicalSubmissions.js', () => ({
  // Name -> id lookup used by inActorSchool (FLKRM-389).
  resolveSchoolId: vi.fn(async (_db, name) => ({ 'Alpha School': 'school_a', 'Beta School': 'school_b' })[name] || null),
}));
vi.mock('../../api/_lib/storage.js', () => storage);

import handler from '../../api/images/[...route].js';

function response() {
  const res = {
    statusCode: null,
    body: null,
    headers: {},
    setHeader: vi.fn(function setHeader(k, v) { this.headers[k] = v; return this; }),
    status: vi.fn(function status(code) { this.statusCode = code; return this; }),
    json: vi.fn(function json(data) { this.body = data; return this; }),
    end: vi.fn(),
  };
  return res;
}

// client.execute accepts a plain SQL string (PRAGMA) or { sql, args }.
function sqlFrom(arg) {
  return typeof arg === 'string' ? arg : arg.sql;
}

function withSql(impl) {
  return async (arg) => impl(sqlFrom(arg), arg && typeof arg === 'object' ? arg.args : undefined);
}

describe('images reference asset tenant authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeClient.execute.mockImplementation(withSql((sql) => {
      if (sql.includes('PRAGMA table_info(review_reference_assets)')) {
        return { rows: [{ name: 'asset_id' }, { name: 'school' }] };
      }
      return { rows: [] };
    }));
    storage.getObject.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: vi.fn(() => 'image/png') },
      arrayBuffer: async () => new Uint8Array([1, 2, 3]),
    });
  });

  it('selects the school column for assetId lookups so the tenant check can run', async () => {
    auth.requireUser.mockResolvedValueOnce({ username: 'admin_a', role: 'admin', school: 'Alpha School', school_id: 'school_a' });
    fakeClient.execute.mockImplementation(withSql((sql) => {
      if (sql.includes('PRAGMA')) return { rows: [{ name: 'school' }] };
      if (sql.includes('FROM review_reference_assets')) {
        expect(sql).toContain('school');
        return { rows: [{ mime_type: 'image/png', storage_key: 'schools/alpha/a.png', school: 'Alpha School' }] };
      }
      return { rows: [] };
    }));

    const res = response();
    await handler({ method: 'GET', query: { route: ['reference'], asset: 'asset_x' } }, res);
    expect(res.statusCode).toBe(200);
  });

  it('denies a cross-school admin fetching a reference asset by id before returning bytes', async () => {
    auth.requireUser.mockResolvedValueOnce({ username: 'admin_b', role: 'admin', school: 'Beta School', school_id: 'school_b' });
    fakeClient.execute.mockImplementation(withSql((sql) => {
      if (sql.includes('PRAGMA')) return { rows: [{ name: 'school' }] };
      if (sql.includes('FROM review_reference_assets')) {
        return { rows: [{ mime_type: 'image/png', storage_key: 'schools/alpha/a.png', school: 'Alpha School' }] };
      }
      return { rows: [] };
    }));

    const res = response();
    await handler({ method: 'GET', query: { route: ['reference'], asset: 'asset_x' } }, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('School access denied');
    expect(storage.getObject).not.toHaveBeenCalled();
  });

  it('serves the asset to a same-school admin', async () => {
    auth.requireUser.mockResolvedValueOnce({ username: 'admin_a', role: 'admin', school: 'Alpha School', school_id: 'school_a' });
    fakeClient.execute.mockImplementation(withSql((sql) => {
      if (sql.includes('PRAGMA')) return { rows: [{ name: 'school' }] };
      if (sql.includes('FROM review_reference_assets')) {
        return { rows: [{ mime_type: 'image/png', storage_key: 'schools/alpha/a.png', school: 'Alpha School' }] };
      }
      return { rows: [] };
    }));

    const res = response();
    await handler({ method: 'GET', query: { route: ['reference'], asset: 'asset_x' } }, res);
    expect(res.statusCode).toBe(200);
    expect(storage.getObject).toHaveBeenCalledWith({ key: 'schools/alpha/a.png' });
  });

  it('allows a skyll_admin to fetch any school reference asset', async () => {
    auth.requireUser.mockResolvedValueOnce({ username: 'sky_admin', role: 'skyll_admin', school: '' });
    fakeClient.execute.mockImplementation(withSql((sql) => {
      if (sql.includes('PRAGMA')) return { rows: [{ name: 'school' }] };
      if (sql.includes('FROM review_reference_assets')) {
        return { rows: [{ mime_type: 'image/png', storage_key: 'schools/beta/b.png', school: 'Beta School' }] };
      }
      return { rows: [] };
    }));

    const res = response();
    await handler({ method: 'GET', query: { route: ['reference'], asset: 'asset_y' } }, res);
    expect(res.statusCode).toBe(200);
  });

  it('denies the asset when the legacy table lacks a school column instead of serving bytes', async () => {
    // The capability cache is per-module; reset the registry so this scenario
    // starts from an unprimed cache.
    vi.resetModules();
    const { default: freshHandler } = await import('../../api/images/[...route].js');
    auth.requireUser.mockResolvedValueOnce({ username: 'admin_b', role: 'admin', school: 'Beta School', school_id: 'school_b' });
    fakeClient.execute.mockImplementation(withSql((sql) => {
      if (sql.includes('PRAGMA')) return { rows: [{ name: 'asset_id' }] };
      if (sql.includes('FROM review_reference_assets')) {
        expect(sql).not.toContain('school');
        return { rows: [{ mime_type: 'image/png', storage_key: 'schools/alpha/a.png' }] };
      }
      return { rows: [] };
    }));

    const res = response();
    await freshHandler({ method: 'GET', query: { route: ['reference'], asset: 'asset_x' } }, res);
    expect(res.statusCode).toBe(403);
    expect(storage.getObject).not.toHaveBeenCalled();
  });

  it('denies an asset whose school is null rather than serving bytes', async () => {
    vi.resetModules();
    const { default: freshHandler } = await import('../../api/images/[...route].js');
    auth.requireUser.mockResolvedValueOnce({ username: 'admin_a', role: 'admin', school: 'Alpha School', school_id: 'school_a' });
    fakeClient.execute.mockImplementation(withSql((sql) => {
      if (sql.includes('PRAGMA')) return { rows: [{ name: 'school' }] };
      if (sql.includes('FROM review_reference_assets')) {
        return { rows: [{ mime_type: 'image/png', storage_key: 'schools/unknown/a.png', school: null }] };
      }
      return { rows: [] };
    }));

    const res = response();
    await freshHandler({ method: 'GET', query: { route: ['reference'], asset: 'asset_x' } }, res);
    expect(res.statusCode).toBe(403);
    expect(storage.getObject).not.toHaveBeenCalled();
  });
});
