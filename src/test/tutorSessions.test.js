import { describe, expect, it } from 'vitest';
import { listTutorSessions } from '../../api/_lib/tutor.js';

describe('listTutorSessions', () => {
  it('groups chat messages into sessions scoped by user and school', async () => {
    const captured = [];
    const db = {
      execute: async ({ sql, args }) => {
        captured.push({ sql, args });
        return {
          rows: [{
            session_id: 'tut_a',
            started_at: '2026-08-01T09:00:00.000Z',
            last_at: '2026-08-01T09:04:00.000Z',
            turns: 4,
            first_question: 'Why is the tangent perpendicular to the radius?',
          }],
        };
      },
    };
    const sessions = await listTutorSessions(db, { userId: 'u1', schoolId: 's1' });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe('tut_a');
    expect(sessions[0].turns).toBe(4);
    expect(sessions[0].firstQuestion).toMatch(/tangent/);
    expect(captured[0].args).toEqual(['u1', 's1', 15]);
    expect(captured[0].sql).toContain("scope = 'tutor'");
  });

  it('returns [] without user or school scope (never queries)', async () => {
    const db = { execute: async () => { throw new Error('must not query'); } };
    expect(await listTutorSessions(db, {})).toEqual([]);
    expect(await listTutorSessions(db, { userId: 'u1' })).toEqual([]);
  });
});
