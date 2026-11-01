// AI fair-use quotas count atomically and never over-admit.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSchemaDatabase } from './helpers/schemaDatabase.js';

const holder = vi.hoisted(() => ({ db: null }));
vi.mock('../../api/_lib/auth.js', () => ({ database: () => holder.db }));

const { checkAiRateLimit } = await import('../../api/_lib/aiRateLimitTiers.js');

beforeEach(async () => {
  holder.db = await createSchemaDatabase();
});

describe('checkAiRateLimit', () => {
  it('admits exactly the daily revision quota, even when requests race', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => checkAiRateLimit('usr_1', 'revision', 'student')));
    expect(results.filter((result) => !result.limited)).toHaveLength(5);
    expect(results.filter((result) => result.limited)).toHaveLength(3);
    const row = (await holder.db.execute("SELECT count FROM ai_rate_limits WHERE key LIKE '%revision%'")).rows[0];
    expect(row.count).toBe(5);
  });

  it('keeps separate quotas per feature', async () => {
    for (let index = 0; index < 5; index += 1) await checkAiRateLimit('usr_1', 'revision', 'student');
    expect((await checkAiRateLimit('usr_1', 'revision', 'student')).limited).toBe(true);
    expect((await checkAiRateLimit('usr_1', 'tutor', 'student')).limited).toBe(false);
  });
});
