import { describe, expect, it, vi } from 'vitest';
import { JOB_STATUS, WORKFLOW_STEPS, claimJob, startStep } from '../../server/intake/jobLifecycle.js';

describe('processing job lifecycle', () => {
  it('claims only a queued job and moves its test into processing', async () => {
    const db = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 'job_1', test_id: 'test_1', status: 'running', worker_id: 'worker_1' }] })
        .mockResolvedValueOnce({ rows: [] }),
    };

    const job = await claimJob(db, { jobId: 'job_1', workerId: 'worker_1' });

    expect(job).toMatchObject({ id: 'job_1', status: JOB_STATUS.RUNNING });
    expect(db.execute.mock.calls[0][0].sql).toContain("WHERE id = ? AND status = ?");
    expect(db.execute.mock.calls[2][0].sql).toContain("status = 'processing'");
  });

  it('returns null if the job is already claimed by another worker (concurrent claim)', async () => {
    const db = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [] }) // UPDATE returns nothing
        .mockResolvedValueOnce({ rows: [{ id: 'job_1', test_id: 'test_1', status: 'running', worker_id: 'worker_2' }] }), // readJob sees worker_2
    };

    const job = await claimJob(db, { jobId: 'job_1', workerId: 'worker_1' });
    expect(job).toBeNull();
  });

  it('returns null if the job is no longer queued', async () => {
    const db = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [] }) // UPDATE returns nothing
        .mockResolvedValueOnce({ rows: [{ id: 'job_1', test_id: 'test_1', status: 'succeeded', worker_id: 'worker_1' }] }), // readJob sees succeeded
    };

    const job = await claimJob(db, { jobId: 'job_1', workerId: 'worker_1' });
    expect(job).toBeNull();
  });

  it('does not let a processor start an undefined workflow phase', async () => {
    await expect(startStep({}, { jobId: 'job_1', workerId: 'worker_1', step: 'invent_a_step' }))
      .rejects.toThrow('Unsupported workflow step');
  });

  it('enforces that a worker cannot start or complete a step if they do not own the running job', async () => {
    const db = {
      execute: vi.fn().mockResolvedValueOnce({ rows: [{ id: 'job_1', status: 'running', worker_id: 'worker_2' }] }),
    };

    await expect(startStep(db, { jobId: 'job_1', workerId: 'worker_1', step: 'ocr' }))
      .rejects.toThrow('Only the worker that claimed a running job can start a workflow step.');
  });

  it('keeps the required processing phases explicit', () => {
    expect(WORKFLOW_STEPS).toEqual([
      'validate_inputs', 'parse_key', 'ocr', 'evidence', 'visual_rescue',
      'grade', 'quality_gate', 'build_reports', 'ready_for_review',
    ]);
  });
});
