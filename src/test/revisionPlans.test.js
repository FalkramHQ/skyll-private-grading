import { describe, expect, it } from 'vitest';
import { listRevisionPlans, saveRevisionPlan } from '../../api/_lib/revisionPlan.js';

describe('revision plan persistence', () => {
  it('saves a plan and lists it back scoped by school and username', async () => {
    const written = [];
    const db = {
      execute: async ({ sql, args }) => {
        if (sql.startsWith('INSERT INTO revision_plans')) {
          written.push(args);
          return { rows: [] };
        }
        if (sql.startsWith('SELECT id, username, subject, plan_json')) {
          expect(args).toEqual(['school_1', 'aa12', 10]);
          return {
            rows: [{
              id: 'rp_1', username: 'aa12', subject: 'Mathematics',
              plan_json: JSON.stringify({ subject: 'Mathematics', priority_1: { topic: 'Circles' } }),
              created_at: '2026-08-05T00:00:00.000Z',
            }],
          };
        }
        return { rows: [] };
      },
    };
    const id = await saveRevisionPlan(db, {
      schoolId: 'school_1',
      username: 'aa12',
      subject: 'Mathematics',
      plan: { subject: 'Mathematics', source: 'llm' },
    });
    expect(id).toMatch(/^rp_/);
    expect(written[0][1]).toBe('school_1');

    const plans = await listRevisionPlans(db, { schoolId: 'school_1', username: 'aa12' });
    expect(plans).toHaveLength(1);
    expect(plans[0].plan.priority_1.topic).toBe('Circles');
  });
});
