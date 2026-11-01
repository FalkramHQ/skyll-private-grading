import { describe, expect, test, vi } from 'vitest';
import { cleanupStaleIncompleteUploads } from '../jobs.js';

vi.mock('../../../api/_lib/storage.js', () => ({
  deleteObject: vi.fn(async () => ({ ok: true, status: 200 })),
}));

describe('intake job cleanup', () => {
  test('discards stale incomplete uploads and refreshes test status', async () => {
    let staleRowsReturned = false;
    const execute = vi.fn(async ({ sql }) => {
      if (sql.includes("ORDER BY created_at")) {
        staleRowsReturned = true;
        return {
          rows: [
            { id: 'asset_1', test_student_id: 'student_1', kind: 'answer_sheet', storage_key: 'k1' },
            { id: 'asset_2', test_student_id: null, kind: 'question_paper', storage_key: 'k2' },
          ],
        };
      }
      if (sql.includes("status IN ('registered', 'uploading')") && sql.includes('LIMIT 1')) {
        return { rows: staleRowsReturned ? [] : [{ has_pending: 1 }] };
      }
      if (sql.includes("status IN ('registered', 'uploading')")) {
        return { rows: [] };
      }
      if (sql.includes("status = 'uploaded' GROUP BY kind")) {
        return { rows: [{ kind: 'question_paper', count: 1 }, { kind: 'answer_key', count: 1 }, { kind: 'answer_sheet', count: 1 }] };
      }
      if (sql.includes('UPDATE tests SET status = ?, updated_at = ?')
        && sql.includes("status IN ('uploading', 'ready_for_processing')")) {
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const batch = vi.fn(async () => {});
    const db = { execute, batch };

    const result = await cleanupStaleIncompleteUploads({ db, testId: 'test_1', now: new Date('2026-07-31T12:00:00.000Z') });

    expect(result).toMatchObject({
      cleaned: true,
      removedAssetIds: ['asset_1', 'asset_2'],
      removedStudentIds: ['student_1'],
    });
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0][0]).toEqual([
      { sql: 'DELETE FROM file_assets WHERE id IN (?, ?)', args: ['asset_1', 'asset_2'] },
      expect.objectContaining({ args: ['student_1', 'test_1', 'student_1'] }),
    ]);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      args: ['ready_for_processing', '2026-07-31T12:00:00.000Z', 'test_1'],
    }));
    expect(execute.mock.calls.some(([arg]) => (
      String(arg.sql || '').includes('UPDATE tests SET status')
      && String(arg.sql || '').includes("status IN ('uploading', 'ready_for_processing')")
    ))).toBe(true);
  });
});
