import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadRevisionHistory } from '../../api/vl-queue.js';
import { createRecheckTestDatabase } from './helpers/recheckTestDatabase.js';

describe('question revision history', () => {
  let ctx;
  beforeEach(async () => { ctx = await createRecheckTestDatabase(); });
  afterEach(async () => { await ctx.close(); });

  it('joins regrade item state onto stored revisions and caps at three entries', async () => {
    const { db } = ctx;
    const ops = [];
    for (let revision = 1; revision <= 4; revision += 1) {
      ops.push({
        sql: `INSERT INTO submission_question_revisions
                (id, submission_question_id, revision, source, actor_user_id, cohort_regrade_run_id, snapshot_json, created_at)
              VALUES (?, 'question_a', ?, 'cohort_regrade_snapshot', 'admin_a', 'run_a', ?, ?)`,
        args: [`rev_${revision}`, revision,
          JSON.stringify({ studentAnswer: `Answer v${revision}`, approvedMarks: revision, marksTotal: 5 }),
          `2026-07-2${revision}T10:00:00.000Z`],
      });
    }
    ops.push({
      sql: `INSERT INTO regrade_items (id, run_id, submission_id, submission_question_id, revision, state, output_json)
            VALUES ('item_4', 'run_a', 'submission_a', 'question_a', 4, 'completed', ?)`,
      args: [JSON.stringify({ feedback: { nextStep: 'Add units.' } })],
    });
    await db.batch(ops, 'write');

    const history = await loadRevisionHistory(db, ['question_a']);
    const entries = history.get('question_a');
    expect(entries).toHaveLength(3);
    // Newest first; state joined from regrade_items, default 'queued' otherwise.
    expect(entries[0]).toMatchObject({ revision: 4, state: 'completed', approvedMarks: 4, feedback: { nextStep: 'Add units.' } });
    expect(entries[1]).toMatchObject({ revision: 3, state: 'queued', studentAnswer: 'Answer v3' });
  });

  it('returns an empty map for no question ids', async () => {
    expect((await loadRevisionHistory(ctx.db, [])).size).toBe(0);
  });
});
