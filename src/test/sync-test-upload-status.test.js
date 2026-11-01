import { describe, expect, it, vi } from 'vitest';
import { syncTestUploadStatus } from '../../server/intake/uploadStatus.js';

describe('syncTestUploadStatus', () => {
  it('does not rewrite tests that have already left the upload phase', async () => {
    const db = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [
          { kind: 'question_paper', count: 1 },
          { kind: 'answer_key', count: 1 },
          { kind: 'answer_sheet', count: 1 },
        ] })
        .mockResolvedValueOnce({ rows: [] }),
    };

    const result = await syncTestUploadStatus(db, 'test_1', '2026-09-08T00:00:00.000Z');
    expect(result).toMatchObject({ ready: true, status: 'ready_for_processing' });
    expect(db.execute.mock.calls[2][0].sql).toMatch(/status IN \('uploading', 'ready_for_processing'\)/);
  });
});
