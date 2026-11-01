import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@libsql/client';
import {
  claimJobStatement,
  createShutdown,
  extendLeaseStatement,
  releaseOnShutdownStatement,
  startLeaseHeartbeat,
} from '../../apps/processing-worker/lifecycle.js';

const LEASE = '2999-01-01T00:00:00.000Z';

describe('FLKRM-373: job release on shutdown (real SQL)', () => {
  let db;

  async function job() {
    return (await db.execute({ sql: 'SELECT * FROM processing_jobs WHERE id = ?', args: ['job_1'] })).rows[0];
  }

  async function claim(workerId, at = '2026-10-01T10:00:00.000Z') {
    return db.execute(claimJobStatement({ jobId: 'job_1', workerId, at, leaseExpiresAt: LEASE }));
  }

  beforeEach(async () => {
    db = createClient({ url: ':memory:' });
    await db.execute(`CREATE TABLE processing_jobs (
      id TEXT PRIMARY KEY, status TEXT, worker_id TEXT, started_at TEXT, error TEXT,
      heartbeat_at TEXT, lease_expires_at TEXT, next_attempt_at TEXT, progress_json TEXT,
      attempt_count INTEGER DEFAULT 0, lease_reclaim_count INTEGER DEFAULT 0
    )`);
    await db.execute("INSERT INTO processing_jobs (id, status) VALUES ('job_1', 'queued')");
  });

  afterEach(() => db.close());

  it('returns a killed-mid-run job to the queue without burning an attempt', async () => {
    await claim('worker_a');
    expect(await job()).toMatchObject({ status: 'running', worker_id: 'worker_a', attempt_count: 1 });

    const released = await db.execute(releaseOnShutdownStatement({ jobId: 'job_1', workerId: 'worker_a', at: '2026-10-01T10:00:30.000Z' }));
    expect(released.rowsAffected).toBe(1);
    const queued = await job();
    expect(queued).toMatchObject({ status: 'queued', worker_id: null, lease_expires_at: null, next_attempt_at: null, lease_reclaim_count: 0 });
    expect(JSON.parse(queued.progress_json)).toMatchObject({ phase: 'released_on_shutdown', is_reclaim: 1 });

    // The replacement worker picks it straight up; the interrupted run is not a new attempt.
    await claim('worker_b', '2026-10-01T10:00:35.000Z');
    const reclaimed = await job();
    expect(reclaimed).toMatchObject({ status: 'running', worker_id: 'worker_b', attempt_count: 1 });
    // The marker is consumed by the claim, so a later genuine retry still counts.
    expect(JSON.parse(reclaimed.progress_json).is_reclaim).toBeUndefined();
  });

  it('does not release a job owned by another worker or one that already finished', async () => {
    await claim('worker_a');
    expect((await db.execute(releaseOnShutdownStatement({ jobId: 'job_1', workerId: 'worker_b', at: 'now' }))).rowsAffected).toBe(0);

    await db.execute("UPDATE processing_jobs SET status = 'succeeded' WHERE id = 'job_1'");
    expect((await db.execute(releaseOnShutdownStatement({ jobId: 'job_1', workerId: 'worker_a', at: 'now' }))).rowsAffected).toBe(0);
    expect(await job()).toMatchObject({ status: 'succeeded' });
  });

  it('extends the lease only while this worker still owns the running job', async () => {
    await claim('worker_a');
    const later = '3000-01-01T00:00:00.000Z';
    const extended = await db.execute(extendLeaseStatement({ jobId: 'job_1', workerId: 'worker_a', at: 'beat', leaseExpiresAt: later }));
    expect(extended.rowsAffected).toBe(1);
    expect(await job()).toMatchObject({ heartbeat_at: 'beat', lease_expires_at: later });

    await db.execute(releaseOnShutdownStatement({ jobId: 'job_1', workerId: 'worker_a', at: 'now' }));
    const afterRelease = await db.execute(extendLeaseStatement({ jobId: 'job_1', workerId: 'worker_a', at: 'late', leaseExpiresAt: later }));
    expect(afterRelease.rowsAffected).toBe(0);
  });
});

describe('FLKRM-373: timer lease heartbeat', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('extends the lease on every interval until stopped', async () => {
    const beat = vi.fn().mockResolvedValue();
    const stop = startLeaseHeartbeat(beat, { intervalMs: 30_000 });

    await vi.advanceTimersByTimeAsync(95_000);
    expect(beat).toHaveBeenCalledTimes(3);

    stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(beat).toHaveBeenCalledTimes(3);
  });

  it('never overlaps a slow beat and survives a failing one', async () => {
    let finish;
    const beat = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValue();
    const onError = vi.fn();
    const stop = startLeaseHeartbeat(beat, { intervalMs: 1_000, onError });

    await vi.advanceTimersByTimeAsync(3_500);
    expect(beat).toHaveBeenCalledTimes(1); // still in flight; ticks are skipped

    finish();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(beat).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'db down' }));
    stop();
  });
});

describe('FLKRM-373: graceful shutdown', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup({ job = { id: 'job_1' }, releaseJob = vi.fn().mockResolvedValue() } = {}) {
    const state = { job };
    const exit = vi.fn();
    const log = vi.fn();
    const shutdown = createShutdown({ graceMs: 30_000, activeJob: () => state.job, releaseJob, exit, log });
    return { state, exit, log, releaseJob, shutdown };
  }

  it('releases a job still running when the grace period ends, then exits', async () => {
    const { exit, releaseJob, shutdown } = setup();
    shutdown.request('SIGTERM');
    expect(shutdown.requested).toBe(true);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(releaseJob).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(releaseJob).toHaveBeenCalledWith({ id: 'job_1' });
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('leaves a job that finishes within the grace period alone', async () => {
    const { state, exit, releaseJob, shutdown } = setup();
    shutdown.request('SIGTERM');
    state.job = null; // tick() cleared it after the job completed

    await vi.advanceTimersByTimeAsync(30_000);
    expect(releaseJob).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('does not schedule anything when idle; the run loop simply ends', async () => {
    const { exit, releaseJob, shutdown } = setup({ job: null });
    shutdown.request('SIGTERM');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(releaseJob).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('releases immediately on a second signal and only once', async () => {
    const { exit, releaseJob, shutdown } = setup();
    shutdown.request('SIGTERM');
    await shutdown.request('SIGINT');
    expect(releaseJob).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(releaseJob).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('still exits when the release itself fails', async () => {
    const { exit, log, shutdown } = setup({ releaseJob: vi.fn().mockRejectedValue(new Error('db down')) });
    shutdown.request('SIGTERM');
    await shutdown.request('SIGTERM');
    expect(exit).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: 'job_release_failed', error: 'db down' }));
  });
});
