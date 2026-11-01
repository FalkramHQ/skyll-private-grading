import { describe, expect, it, vi } from 'vitest';
import { publicHealthProbe } from '../../server/admin/healthProbe.js';

describe('public health probe', () => {
  it('returns only a minimal success body when the database read succeeds', async () => {
    const runDatabaseCheck = vi.fn().mockResolvedValue({ rows: [{ ok: 1 }] });
    const result = await publicHealthProbe({ runDatabaseCheck, now: () => '2026-07-25T12:00:00.000Z' });
    expect(result).toEqual({ status: 200, body: { ok: true, checkedAt: '2026-07-25T12:00:00.000Z' } });
    expect(Object.keys(result.body)).toEqual(['ok', 'checkedAt']);
  });

  it('returns a safe service-unavailable response without forwarding database errors', async () => {
    const result = await publicHealthProbe({ runDatabaseCheck: vi.fn().mockRejectedValue(new Error('secret connection detail')), now: () => '2026-07-25T12:00:00.000Z' });
    expect(result).toEqual({ status: 503, body: { ok: false, checkedAt: '2026-07-25T12:00:00.000Z' } });
  });
});
