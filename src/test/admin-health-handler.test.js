import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockDb = vi.hoisted(() => ({ execute: vi.fn() }));

const auth = vi.hoisted(() => ({
  database: vi.fn(() => mockDb),
  ensureAuthTables: vi.fn().mockResolvedValue(),
  requireUser: vi.fn(),
}));

const storage = vi.hoisted(() => ({
  STORAGE_PROBE_TIMEOUT_MS: 5000,
  probeStorage: vi.fn(),
}));

vi.mock('../../api/_lib/auth.js', () => auth);
vi.mock('../../api/_lib/storage.js', () => storage);

import handler, { storageHealth } from '../../server/admin/health.js';

function response() {
  return {
    statusCode: null,
    body: null,
    status: vi.fn(function status(code) { this.statusCode = code; return this; }),
    json: vi.fn(function json(data) { this.body = data; return this; }),
  };
}

const minuteAgo = (seconds) => new Date(Date.now() - seconds * 1000).toISOString();

describe('storage health check', () => {
  it('is healthy when the bounded listing succeeds', async () => {
    const probe = vi.fn().mockResolvedValue({ ok: true, status: 200, elapsedMs: 42 });
    const result = await storageHealth({ probe, timeoutMs: 5000 });
    expect(probe).toHaveBeenCalledWith({ timeoutMs: 5000 });
    expect(result).toMatchObject({ id: 'r2_storage', status: 'healthy', detail: 'A one-key bucket listing completed in 42 ms.', source: 'live' });
  });

  it('is critical on HTTP errors, timeouts and network failures without leaking provider text', async () => {
    expect((await storageHealth({ probe: vi.fn().mockResolvedValue({ ok: false, status: 403, elapsedMs: 10 }) })).status).toBe('critical');
    const timeout = Object.assign(new Error('Storage probe timed out after 5000 ms'), { code: 'storage_timeout' });
    const timedOut = await storageHealth({ probe: vi.fn().mockRejectedValue(timeout), timeoutMs: 5000 });
    expect(timedOut).toMatchObject({ status: 'critical', detail: 'The storage bucket did not answer within 5 seconds.' });
    const network = await storageHealth({ probe: vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND secret-account.r2.cloudflarestorage.com')) });
    expect(network.status).toBe('critical');
    expect(JSON.stringify(network)).not.toContain('secret-account');
  });

  it('is unknown when storage is not configured', async () => {
    const result = await storageHealth({ probe: vi.fn().mockRejectedValue(new Error('Storage is not configured: missing S3_BUCKET')) });
    expect(result).toMatchObject({ status: 'unknown', source: 'configuration' });
    expect(result.detail).not.toContain('S3_BUCKET');
  });
});

describe('admin health handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.requireUser.mockResolvedValue({ username: 'sky', role: 'skyll_admin', school: '' });
    storage.probeStorage.mockResolvedValue({ ok: true, status: 200, elapsedMs: 12 });
    mockDb.execute.mockImplementation(async (statement) => {
      const sql = typeof statement === 'string' ? statement : statement.sql;
      if (sql.includes('FROM worker_heartbeats')) {
        expect(sql).toContain('LIMIT 20');
        expect(sql).toContain("service LIKE 'skyll-worker@%'");
        return { rows: [
          { worker_id: 'w_a', service: 'skyll-worker@1', status: 'healthy', active_job_id: 'job_1', last_seen_at: minuteAgo(20) },
          { worker_id: 'w_b', service: 'skyll-worker@1', status: 'healthy', active_job_id: null, last_seen_at: minuteAgo(50) },
          { worker_id: 'w_c', service: 'skyll-worker@2', status: 'healthy', active_job_id: null, last_seen_at: minuteAgo(600) },
        ] };
      }
      return { rows: [] };
    });
  });

  it('reports the live storage probe and the healthy worker count', async () => {
    const res = response();
    await handler({ method: 'GET', query: {}, url: '/api/auth/health' }, res);
    expect(res.statusCode).toBe(200);
    const byId = Object.fromEntries(res.body.services.map((item) => [item.id, item]));
    expect(byId.r2_storage).toMatchObject({ status: 'healthy', source: 'live' });
    expect(storage.probeStorage).toHaveBeenCalledWith({ timeoutMs: 5000 });
    expect(byId.oci_processing_worker).toMatchObject({ status: 'healthy', detail: '2 healthy workers seen in the last 2 minutes, 1 processing work.' });
  });

  it('keeps the rest of the panel when the storage probe fails', async () => {
    storage.probeStorage.mockRejectedValue(Object.assign(new Error('timed out'), { code: 'storage_timeout' }));
    const res = response();
    await handler({ method: 'GET', query: {}, url: '/api/auth/health' }, res);
    expect(res.statusCode).toBe(200);
    const r2 = res.body.services.find((item) => item.id === 'r2_storage');
    expect(r2.status).toBe('critical');
    expect(res.body.overallStatus).toBe('critical');
  });
});
