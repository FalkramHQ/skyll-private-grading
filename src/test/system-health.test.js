import { describe, expect, it } from 'vitest';
import { buildSystemHealth, classifyClassHealth, classifyRecentJobService, classifyWorkerFleetHealth, classifyWorkerHealth, HEALTH_STATUS } from '../../shared/systemHealth.js';

describe('system health contract', () => {
  it('classifies active classes by roster and metadata quality', () => {
    expect(classifyClassHealth({ id: 'batch_1', name: 'Class 10 A', status: 'active', grade: '10', academicYear: '2026', studentCount: 24 }).status).toBe(HEALTH_STATUS.HEALTHY);
    expect(classifyClassHealth({ id: 'batch_2', name: 'Class 10 B', status: 'active', grade: '10', academicYear: '2026', studentCount: 0 }).status).toBe(HEALTH_STATUS.CRITICAL);
    expect(classifyClassHealth({ id: 'batch_3', name: 'Class 10 C', status: 'active', grade: '', academicYear: '2026', studentCount: 12 }).status).toBe(HEALTH_STATUS.WARNING);
    expect(classifyClassHealth({ id: 'batch_4', name: 'Past class', status: 'inactive', studentCount: 0 }).status).toBe(HEALTH_STATUS.INACTIVE);
  });

  it('uses worker heartbeat freshness to distinguish healthy, warning, and critical states', () => {
    const now = Date.parse('2026-07-25T12:00:00.000Z');
    expect(classifyWorkerHealth({ status: 'healthy', last_seen_at: '2026-07-25T11:59:00.000Z' }, { now }).status).toBe(HEALTH_STATUS.HEALTHY);
    expect(classifyWorkerHealth({ status: 'healthy', last_seen_at: '2026-07-25T11:58:00.000Z' }, { now }).status).toBe(HEALTH_STATUS.WARNING);
    expect(classifyWorkerHealth({ status: 'healthy', last_seen_at: '2026-07-25T11:56:00.000Z' }, { now }).status).toBe(HEALTH_STATUS.CRITICAL);
    expect(classifyWorkerHealth(null, { now }).status).toBe(HEALTH_STATUS.UNKNOWN);
  });

  it('represents the fleet by the newest healthy heartbeat seen in the last two minutes', () => {
    const now = Date.parse('2026-07-25T12:00:00.000Z');
    const fleet = classifyWorkerFleetHealth([
      { worker_id: 'w_stopping', status: 'stopping', last_seen_at: '2026-07-25T11:59:50.000Z' },
      { worker_id: 'w_busy', status: 'healthy', active_job_id: 'job_1', last_seen_at: '2026-07-25T11:59:30.000Z' },
      { worker_id: 'w_idle', status: 'healthy', last_seen_at: '2026-07-25T11:58:30.000Z' },
      { worker_id: 'w_old', status: 'healthy', last_seen_at: '2026-07-25T11:50:00.000Z' },
    ], { now });
    expect(fleet.status).toBe(HEALTH_STATUS.HEALTHY);
    expect(fleet.detail).toBe('2 healthy workers seen in the last 2 minutes, 1 processing work.');
    expect(fleet.lastCheckedAt).toBe('2026-07-25T11:59:30.000Z');
    expect(fleet.workers).toEqual({ healthy: 2, seen: 3 });
  });

  it('falls back to the newest heartbeat of any status when no fresh healthy worker exists', () => {
    const now = Date.parse('2026-07-25T12:00:00.000Z');
    const stopping = classifyWorkerFleetHealth([
      { worker_id: 'w_stopping', status: 'stopping', last_seen_at: '2026-07-25T11:59:50.000Z' },
      { worker_id: 'w_old', status: 'healthy', last_seen_at: '2026-07-25T11:50:00.000Z' },
    ], { now });
    expect(stopping.status).toBe(HEALTH_STATUS.WARNING);
    expect(stopping.detail).toBe('The worker is stopping.');
    expect(stopping.workers).toEqual({ healthy: 0, seen: 1 });

    const stale = classifyWorkerFleetHealth([{ worker_id: 'w_old', status: 'healthy', last_seen_at: '2026-07-25T11:50:00.000Z' }], { now });
    expect(stale.status).toBe(HEALTH_STATUS.CRITICAL);
    expect(classifyWorkerFleetHealth([], { now }).status).toBe(HEALTH_STATUS.UNKNOWN);
  });

  it('derives external provider health from recent completed jobs without live probes', () => {
    const now = Date.parse('2026-07-25T12:00:00.000Z');
    expect(classifyRecentJobService({ id: 'mistral', name: 'Mistral OCR', job: { status: 'succeeded', completed_at: '2026-07-25T11:00:00.000Z' }, now }).status).toBe(HEALTH_STATUS.HEALTHY);
    expect(classifyRecentJobService({ id: 'mistral', name: 'Mistral OCR', job: { status: 'failed_retryable', completed_at: '2026-07-25T11:00:00.000Z' }, now }).status).toBe(HEALTH_STATUS.CRITICAL);
    expect(classifyRecentJobService({ id: 'mistral', name: 'Mistral OCR', job: { status: 'succeeded', completed_at: '2026-07-23T11:00:00.000Z' }, now }).status).toBe(HEALTH_STATUS.UNKNOWN);
  });

  it('surfaces the worst active status while excluding inactive classes', () => {
    const health = buildSystemHealth({
      classes: [
        { id: 'batch_old', name: 'Old', status: 'inactive', studentCount: 0 },
        { id: 'batch_live', name: 'Live', status: 'active', grade: '10', academicYear: '2026', studentCount: 10 },
      ],
      services: [{ id: 'worker', name: 'Worker', status: HEALTH_STATUS.WARNING, detail: 'Stale heartbeat.' }],
      generatedAt: '2026-07-25T12:00:00.000Z',
    });
    expect(health.overallStatus).toBe(HEALTH_STATUS.WARNING);
    expect(health.summary.inactive).toBe(1);
    expect(health.summary.warning).toBe(1);
  });
});
