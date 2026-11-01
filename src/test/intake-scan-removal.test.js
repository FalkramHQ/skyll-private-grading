import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  db: { execute: vi.fn(), batch: vi.fn() },
  deleteObject: vi.fn(),
  createUploadUrl: vi.fn(() => 'https://upload.example/asset'),
}));

vi.mock('../../api/_lib/auth.js', () => ({
  ensureAuthTables: vi.fn(),
  requireUser: vi.fn().mockResolvedValue({ school: 'Skyll School', username: 'admin_1', role: 'admin' }),
  database: () => mocks.db,
}));

vi.mock('../../api/_lib/intake.js', () => ({
  ensureIntakeTables: vi.fn(),
  id: vi.fn().mockReturnValue('intake_asset_event_1'),
}));

vi.mock('../../api/_lib/storage.js', () => ({
  assetKey: vi.fn(),
  createDownloadUrl: vi.fn(),
  createUploadUrl: mocks.createUploadUrl,
  deleteObject: mocks.deleteObject,
}));

const { default: handler } = await import('../../server/intake/uploads.js');

function response() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  };
}

describe('remove_answer_sheet intake action', () => {
  beforeEach(() => {
    mocks.db.execute.mockReset();
    mocks.db.batch.mockReset();
    mocks.deleteObject.mockReset();
    mocks.db.batch.mockResolvedValue({});
    mocks.deleteObject.mockResolvedValue({ ok: true, status: 204 });
    mocks.db.execute.mockResolvedValue({ rows: [] });
  });

  it('allows scanner accounts that can upload answer sheets to remove them', async () => {
    const { requireUser } = await import('../../api/_lib/auth.js');
    requireUser.mockResolvedValueOnce({ school: 'Skyll School', username: 'scanner_1', role: 'scanner' });
    mocks.db.execute
      .mockResolvedValueOnce({ rows: [{ id: 'test_1', status: 'uploading' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'student_1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'asset_1', storage_key: 'key/one' }] });
    const res = response();

    await handler({ method: 'POST', body: { action: 'remove_answer_sheet', testId: 'test_1', testStudentId: 'student_1' } }, res);

    expect(requireUser).toHaveBeenCalledWith(expect.anything(), res, expect.arrayContaining(['scanner']));
    expect(mocks.deleteObject).toHaveBeenCalledWith({ key: 'key/one' });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('deletes all student page rows and their history after storage deletion', async () => {
    mocks.db.execute
      .mockResolvedValueOnce({ rows: [{ id: 'test_1', status: 'uploading' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'student_1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'asset_1', storage_key: 'key/one' }, { id: 'asset_2', storage_key: 'key/two' }] });
    const res = response();

    await handler({ method: 'POST', body: { action: 'remove_answer_sheet', testId: 'test_1', testStudentId: 'student_1', reason: 'Wrong paper scanned' } }, res);

    expect(mocks.deleteObject).toHaveBeenCalledTimes(2);
    expect(mocks.deleteObject).toHaveBeenNthCalledWith(1, { key: 'key/one' });
    expect(mocks.deleteObject).toHaveBeenNthCalledWith(2, { key: 'key/two' });
    expect(mocks.db.batch).toHaveBeenCalledTimes(1);
    const statements = mocks.db.batch.mock.calls[0][0];
    expect(statements.map((statement) => statement.sql).join('\n')).toContain('DELETE FROM file_assets');
    expect(statements.map((statement) => statement.sql).join('\n')).toContain('DELETE FROM intake_asset_events');
    expect(statements.map((statement) => statement.sql).join('\n')).toContain("UPDATE test_students SET status = 'expected'");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true, removedAssetIds: ['asset_1', 'asset_2'], pageCount: 2, historyDeleted: true }));
  });

  it('blocks removal when processing is already queued', async () => {
    mocks.db.execute
      .mockResolvedValueOnce({ rows: [{ id: 'test_1', status: 'uploading' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'student_1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'job_1' }] });
    const res = response();

    await handler({ method: 'POST', body: { action: 'remove_answer_sheet', testId: 'test_1', testStudentId: 'student_1' } }, res);

    expect(mocks.deleteObject).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('processing has started or been queued') }));
  });

  it('is idempotent after every active page has already been removed', async () => {
    mocks.db.execute
      .mockResolvedValueOnce({ rows: [{ id: 'test_1', status: 'uploading' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'student_1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const res = response();

    await handler({ method: 'POST', body: { action: 'remove_answer_sheet', testId: 'test_1', testStudentId: 'student_1' } }, res);

    expect(mocks.deleteObject).not.toHaveBeenCalled();
    expect(mocks.db.batch).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(mocks.db.execute).toHaveBeenLastCalledWith(expect.objectContaining({ sql: expect.stringContaining('DELETE FROM intake_asset_events') }));
    expect(res.json).toHaveBeenCalledWith({ ok: true, alreadyRemoved: true, removedAssetIds: [], pageCount: 0, historyDeleted: true });
  });

  it('discards only specified replacement pages without deleting the original paper', async () => {
    mocks.db.execute
      .mockResolvedValueOnce({ rows: [{ id: 'test_1', status: 'uploading' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'replacement_1', storage_key: 'key/replacement' }] });
    const res = response();

    await handler({ method: 'POST', body: { action: 'discard_answer_sheet_assets', testId: 'test_1', testStudentId: 'student_1', assetIds: ['replacement_1'] } }, res);

    expect(mocks.deleteObject).toHaveBeenCalledWith({ key: 'key/replacement' });
    const statements = mocks.db.batch.mock.calls[0][0];
    expect(statements[0]).toMatchObject({ sql: expect.stringContaining('DELETE FROM file_assets'), args: ['replacement_1'] });
    expect(res.json).toHaveBeenCalledWith({ ok: true, discardedAssetIds: ['replacement_1'] });
  });

  it('allows discarding assets with status failed, superseded, uploading, or registered', async () => {
    for (const status of ['failed', 'superseded', 'uploading', 'registered']) {
      mocks.db.execute.mockReset();
      mocks.db.batch.mockReset();
      mocks.deleteObject.mockReset();
      mocks.db.batch.mockResolvedValue({});
      mocks.deleteObject.mockResolvedValue({ ok: true, status: 204 });
      mocks.db.execute.mockResolvedValue({ rows: [] });

      mocks.db.execute.mockResolvedValueOnce({
        rows: [{
          id: `asset_${status}`,
          school: 'Skyll School',
          kind: 'question_paper',
          status,
          storage_key: `key/${status}`,
          test_student_id: null,
        }],
      });

      const res = response();
      await handler({ method: 'POST', body: { action: 'discard', assetId: `asset_${status}` } }, res);

      expect(mocks.deleteObject).toHaveBeenCalledWith({ key: `key/${status}` });
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ ok: true, assetId: `asset_${status}`, status: 'discarded' });
    }
  });

  it('rejects discarding an already uploaded active asset with 409', async () => {
    mocks.db.execute.mockResolvedValueOnce({
      rows: [{
        id: 'asset_uploaded',
        school: 'Skyll School',
        kind: 'question_paper',
        status: 'uploaded',
        storage_key: 'key/uploaded',
        test_student_id: null,
      }],
    });

    const res = response();
    await handler({ method: 'POST', body: { action: 'discard', assetId: 'asset_uploaded' } }, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ error: 'Only an incomplete upload can be discarded' });
    expect(mocks.deleteObject).not.toHaveBeenCalled();
  });

  it('resumes an incomplete upload without creating a new asset row', async () => {
    mocks.db.execute.mockResolvedValueOnce({
      rows: [{
        id: 'asset_resume',
        school: 'Skyll School',
        kind: 'answer_sheet',
        status: 'uploading',
        mime_type: 'image/jpeg',
        storage_key: 'key/resume',
        test_student_id: 'student_1',
      }],
    });
    const res = response();
    await handler({ method: 'POST', body: { action: 'resume', assetId: 'asset_resume' } }, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      asset: { id: 'asset_resume', storageKey: 'key/resume' },
      uploadUrl: expect.any(String),
    }));
    expect(mocks.db.batch).not.toHaveBeenCalled();
  });

  function resumeAsset(overrides = {}) {
    return {
      id: 'asset_done',
      school: 'Skyll School',
      kind: 'answer_sheet',
      status: 'uploaded',
      mime_type: 'image/jpeg',
      storage_key: 'key/done',
      test_student_id: 'student_1',
      ...overrides,
    };
  }

  it('reports an already-uploaded asset as done instead of 409 so clients never re-create it', async () => {
    mocks.createUploadUrl.mockClear();
    mocks.db.execute.mockResolvedValueOnce({ rows: [resumeAsset()] });
    const res = response();
    await handler({ method: 'POST', body: { action: 'resume', assetId: 'asset_done' } }, res);
    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body).toMatchObject({ status: 'uploaded', alreadyUploaded: true, assetId: 'asset_done', asset: { id: 'asset_done', storageKey: 'key/done' } });
    // No write URL for a finished asset: older app builds fail their PUT and
    // back off instead of overwriting or duplicating the page.
    expect(body).not.toHaveProperty('uploadUrl');
    expect(mocks.createUploadUrl).not.toHaveBeenCalled();
    expect(mocks.db.batch).not.toHaveBeenCalled();
  });

  it('keeps the school scope for an already-uploaded asset', async () => {
    mocks.db.execute.mockResolvedValueOnce({ rows: [resumeAsset({ school: 'Other School' })] });
    const res = response();
    await handler({ method: 'POST', body: { action: 'resume', assetId: 'asset_done' } }, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('still refuses to resume failed or superseded assets', async () => {
    for (const status of ['failed', 'superseded']) {
      mocks.db.execute.mockReset();
      mocks.db.execute.mockResolvedValueOnce({ rows: [resumeAsset({ status })] });
      const res = response();
      await handler({ method: 'POST', body: { action: 'resume', assetId: 'asset_done' } }, res);
      expect(res.status).toHaveBeenCalledWith(409);
    }
  });
});
