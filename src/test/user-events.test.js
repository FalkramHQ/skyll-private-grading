import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TRACKABLE_EVENTS,
  buildProductMetrics,
  normalizeEventType,
  recordUserEvent,
} from '../../api/_lib/userEvents.js';

function createDb(handlers) {
  return {
    execute: vi.fn(async ({ sql }) => {
      for (const handler of handlers) {
        if (handler.match(sql)) return { rows: handler.rows };
      }
      return { rows: [{ n: 0 }] };
    }),
  };
}

describe('user events analytics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accepts only the allowlisted event types', () => {
    expect(normalizeEventType('login')).toBe('login');
    expect(normalizeEventType('dna_viewed')).toBe('dna_viewed');
    expect(normalizeEventType('hack_the_planet')).toBeNull();
    expect(TRACKABLE_EVENTS).toContain('report_viewed');
  });

  it('records an event with school-scoped identity fields', async () => {
    const db = createDb([]);
    const id = await recordUserEvent(db, {
      user: { user_id: 'u1', username: 'asha', role: 'student', school_id: 's1', school: 'Alpha School' },
      eventType: 'report_viewed',
      eventData: { examId: 'exam_1' },
      platform: 'web',
      now: '2026-08-21T10:00:00.000Z',
      id: 'evt_test',
    });
    expect(id).toBe('evt_test');
    expect(db.execute).toHaveBeenCalledWith(expect.objectContaining({
      sql: expect.stringContaining('INSERT INTO user_events'),
      args: expect.arrayContaining(['evt_test', 'u1', 'asha', 'student', 's1', 'Alpha School', 'report_viewed']),
    }));
  });

  it('builds KPI payload for school admins', async () => {
    const db = createDb([
      { match: (sql) => sql.includes('GROUP BY event_type'), rows: [{ event_type: 'login', events: 10, users: 4 }] },
      { match: (sql) => sql.includes('ORDER BY created_at DESC'), rows: [{ event_type: 'login', username: 'asha', role: 'student', school: 'Alpha School', platform: 'web', created_at: '2026-08-21T09:00:00.000Z' }] },
      { match: (sql) => sql.includes('EXISTS'), rows: [{ n: 1 }] },
      { match: (sql) => sql.includes('COUNT(DISTINCT COALESCE(user_id, username))'), rows: [{ n: 4 }] },
    ]);
    const metrics = await buildProductMetrics(db, { role: 'admin', school: 'Alpha School' }, { now: new Date('2026-08-21T12:00:00.000Z') });
    expect(metrics.kpis.dau).toBe(4);
    expect(metrics.kpis.mau).toBe(4);
    expect(metrics.scope).toBe('school');
    expect(metrics.funnel7d.login).toBe(4);
    expect(metrics.events7d[0]).toMatchObject({ eventType: 'login', events: 10, users: 4 });
  });
});
