import { ensureAuthTables, requireUser, database } from '../../api/_lib/auth.js';
import { ensureIntakeTables, id } from '../../api/_lib/intake.js';
import { assetKey, createDownloadUrl, createUploadUrl, deleteObject } from '../../api/_lib/storage.js';
import {
  answerSheetUploadBlockedMessage,
  canAcceptAnswerSheetUpload,
  canRemoveStudentScan,
} from '../../shared/workflowLifecycle.js';
import { INTAKE_SCANNER_ROLES, canUploadIntakeAsset, isScannerOnly, scannerDeniedMessage } from './rolePolicy.js';
import { studentPaperStatus } from './paperCompleteness.js';
import { syncTestUploadStatus } from './uploadStatus.js';

const kinds = new Set(['answer_sheet', 'question_paper', 'answer_key']);
const allowedMimeTypes = new Set(['application/pdf', 'image/jpeg', 'image/png']);

function normalizedMimeType(value) {
  return String(value || '').trim().toLowerCase().split(';', 1)[0];
}

const extensionMimeTypes = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
};

// Android's document picker frequently reports a missing or generic
// application/octet-stream type for perfectly valid files. Fall back to the
// filename extension in that case so legitimate uploads are not rejected;
// anything else still fails the allowlist below.
function resolveMimeType(mimeType, filename) {
  const declared = normalizedMimeType(mimeType);
  if (declared && declared !== 'application/octet-stream') return declared;
  const extension = String(filename || '').split('.').pop().trim().toLowerCase();
  return extensionMimeTypes[extension] || declared;
}

function removalReason(value) {
  const reason = String(value || 'admin_requested_rescan').trim();
  if (!reason || reason.length > 500) throw new Error('Removal reason must be between 1 and 500 characters.');
  return reason;
}

function removalBlockedMessage() {
  return 'This paper can no longer be changed because processing has started or been queued. Cancel or reset processing before replacing the scan.';
}

async function rememberExpectedPageCount(db, testStudentId, expectedPageCount) {
  const expected = Number(expectedPageCount);
  if (!testStudentId || !Number.isInteger(expected) || expected < 1 || expected > 200) return;
  await db.execute({
    sql: `UPDATE test_students
          SET expected_page_count = CASE
            WHEN expected_page_count IS NULL OR expected_page_count < ? THEN ?
            ELSE expected_page_count
          END
          WHERE id = ?`,
    args: [expected, expected, testStudentId],
  });
}

async function syncStudentPaperStatus(db, testStudentId) {
  if (!testStudentId) return;
  const student = await db.execute({ sql: 'SELECT expected_page_count FROM test_students WHERE id = ?', args: [testStudentId] });
  if (!student.rows.length) return;
  const uploaded = await db.execute({
    sql: "SELECT COUNT(*) AS count FROM file_assets WHERE test_student_id = ? AND kind = 'answer_sheet' AND status = 'uploaded'",
    args: [testStudentId],
  });
  const status = studentPaperStatus({
    expectedPageCount: student.rows[0].expected_page_count,
    uploadedCount: uploaded.rows[0]?.count,
  });
  await db.execute({ sql: 'UPDATE test_students SET status = ? WHERE id = ?', args: [status, testStudentId] });
}

export default async function handler(req, res) {
  try {
    await ensureAuthTables(); await ensureIntakeTables();
    const user = await requireUser(req, res, INTAKE_SCANNER_ROLES);
    if (!user) return;
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const db = database(); const { action } = req.body || {};
    if (action === 'create') {
      const { testId, testStudentId = null, kind, filename, mimeType, byteSize, expectedPageCount = null } = req.body || {};
      if (!testId || !kinds.has(kind) || !filename) return res.status(400).json({ error: 'testId, kind, and filename are required' });
      if (!canUploadIntakeAsset(user, kind)) return res.status(403).json({ error: scannerDeniedMessage() });
      if (String(testId).length > 160 || String(testStudentId || '').length > 160 || String(filename).length > 240) return res.status(400).json({ error: 'Upload metadata is too long' });
      const safeMimeType = resolveMimeType(mimeType, filename);
      if (!allowedMimeTypes.has(safeMimeType)) return res.status(400).json({ error: 'Only PDF, JPEG, and PNG assessment files are supported' });
      if (!Number.isFinite(Number(byteSize)) || Number(byteSize) < 1 || Number(byteSize) > 50 * 1024 * 1024) return res.status(400).json({ error: 'Files must be between 1 byte and 50 MB' });
      const test = await db.execute({ sql: 'SELECT * FROM tests WHERE id = ? AND school = ?', args: [testId, user.school] });
      if (!test.rows.length) return res.status(404).json({ error: 'Test not found' });
      if (kind === 'answer_sheet' && !testStudentId) return res.status(400).json({ error: 'A student is required for an answer sheet' });
      if (kind === 'answer_sheet') {
        const activeJob = await db.execute({
          sql: "SELECT id FROM processing_jobs WHERE test_id = ? AND status IN ('queued', 'running') LIMIT 1",
          args: [testId],
        });
        if (!canAcceptAnswerSheetUpload({
          testStatus: test.rows[0].status,
          hasActiveProcessingJob: Boolean(activeJob.rows.length),
        })) {
          return res.status(409).json({
            error: answerSheetUploadBlockedMessage(test.rows[0].status),
            code: 'answer_sheet_upload_locked',
          });
        }
      }
      if (testStudentId) {
        const student = await db.execute({ sql: 'SELECT id FROM test_students WHERE id = ? AND test_id = ?', args: [testStudentId, testId] });
        if (!student.rows.length) return res.status(404).json({ error: 'Student is not part of this test' });
      }
      if (!testStudentId && (kind === 'question_paper' || kind === 'answer_key')) {
        await db.execute({
          sql: "UPDATE file_assets SET status = 'superseded' WHERE test_id = ? AND kind = ? AND status IN ('uploading', 'registered', 'failed')",
          args: [testId, kind],
        });
      }
      const assetId = id('asset'); const key = assetKey({ school: user.school, testId, assetId, filename }); const now = new Date().toISOString();
      await db.execute({ sql: `INSERT INTO file_assets (id, test_id, test_student_id, kind, storage_key, mime_type, byte_size, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'uploading', ?, ?)`, args: [assetId, testId, testStudentId, kind, key, safeMimeType, Number(byteSize), user.username, now] });
      if (kind === 'answer_sheet') await rememberExpectedPageCount(db, testStudentId, expectedPageCount);
      return res.status(201).json({ asset: { id: assetId, storageKey: key }, uploadUrl: createUploadUrl({ key, contentType: safeMimeType }), headers: { 'Content-Type': safeMimeType } });
    }
    if (action === 'complete') {
      const { assetId, checksum, byteSize } = req.body || {};
      if (!assetId || String(assetId).length > 160) return res.status(400).json({ error: 'A valid asset ID is required' });
      if (checksum && !/^[a-f0-9]{64}$/i.test(String(checksum))) return res.status(400).json({ error: 'Checksum must be a SHA-256 digest' });
      const result = await db.execute({ sql: `SELECT a.*, t.school FROM file_assets a JOIN tests t ON t.id = a.test_id WHERE a.id = ?`, args: [assetId] }); const asset = result.rows[0];
      if (!asset || asset.school !== user.school) return res.status(404).json({ error: 'Asset not found' });
      if (!canUploadIntakeAsset(user, asset.kind)) return res.status(403).json({ error: scannerDeniedMessage() });
      if (Number(byteSize) !== Number(asset.byte_size)) return res.status(400).json({ error: 'Uploaded file size does not match registered size' });
      const updates = [{ sql: "UPDATE file_assets SET status = 'uploaded', checksum = ? WHERE id = ?", args: [checksum || null, assetId] }];
      if (!asset.test_student_id && (asset.kind === 'question_paper' || asset.kind === 'answer_key')) {
        updates.push({ sql: "UPDATE file_assets SET status = 'superseded' WHERE test_id = ? AND kind = ? AND id <> ? AND status <> 'superseded'", args: [asset.test_id, asset.kind, assetId] });
      }
      await db.batch(updates, 'write');
      if (asset.test_student_id) await syncStudentPaperStatus(db, asset.test_student_id);
      await syncTestUploadStatus(db, asset.test_id);
      return res.status(200).json({ ok: true, assetId, status: 'uploaded' });
    }
    if (action === 'resume') {
      const { assetId } = req.body || {};
      if (!assetId || String(assetId).length > 160) return res.status(400).json({ error: 'A valid asset ID is required' });
      const result = await db.execute({ sql: `SELECT a.*, t.school FROM file_assets a JOIN tests t ON t.id = a.test_id WHERE a.id = ?`, args: [assetId] });
      const asset = result.rows[0];
      if (!asset || asset.school !== user.school) return res.status(404).json({ error: 'Asset not found' });
      if (!canUploadIntakeAsset(user, asset.kind)) return res.status(403).json({ error: scannerDeniedMessage() });
      // The client lost the `complete` response but the page landed. Report it
      // as done so the app does not fall back to `create` and add a duplicate
      // page. No uploadUrl is issued: a finished asset must not be rewritable,
      // and app builds that predate this response fail their PUT on the
      // missing URL (and retry/back off) instead of creating a second asset.
      if (asset.status === 'uploaded') {
        return res.status(200).json({
          ok: true,
          status: 'uploaded',
          alreadyUploaded: true,
          assetId: asset.id,
          asset: { id: asset.id, storageKey: asset.storage_key },
        });
      }
      if (!['registered', 'uploading'].includes(asset.status)) {
        return res.status(409).json({ error: 'Only an incomplete upload can be resumed' });
      }
      return res.status(200).json({
        asset: { id: asset.id, storageKey: asset.storage_key },
        uploadUrl: createUploadUrl({ key: asset.storage_key, contentType: asset.mime_type }),
        headers: { 'Content-Type': asset.mime_type },
      });
    }
    if (action === 'discard') {
      const { assetId } = req.body || {};
      const result = await db.execute({ sql: `SELECT a.*, t.school FROM file_assets a JOIN tests t ON t.id = a.test_id WHERE a.id = ?`, args: [assetId] });
      const asset = result.rows[0];
      if (!asset || asset.school !== user.school) return res.status(404).json({ error: 'Asset not found' });
      if (!canUploadIntakeAsset(user, asset.kind)) return res.status(403).json({ error: scannerDeniedMessage() });
      if (!['registered', 'uploading', 'failed', 'superseded'].includes(asset.status)) {
        return res.status(409).json({ error: 'Only an incomplete upload can be discarded' });
      }
      const deletion = await deleteObject({ key: asset.storage_key });
      if (!deletion.ok && deletion.status !== 404) throw new Error(`Could not discard upload (${deletion.status})`);
      const statements = [{ sql: 'DELETE FROM file_assets WHERE id = ?', args: [assetId] }];
      if (asset.test_student_id) {
        statements.push({
          sql: `UPDATE test_students SET status = 'expected'
                WHERE id = ? AND NOT EXISTS (
                  SELECT 1 FROM file_assets
                  WHERE test_student_id = ? AND kind = 'answer_sheet' AND status = 'uploaded'
                )`,
          args: [asset.test_student_id, asset.test_student_id],
        });
      }
      await db.batch(statements, 'write');
      if (asset.test_student_id) await syncStudentPaperStatus(db, asset.test_student_id);
      await syncTestUploadStatus(db, asset.test_id);
      return res.status(200).json({ ok: true, assetId, status: 'discarded' });
    }
    if (action === 'discard_answer_sheet_assets') {
      const { testId, testStudentId } = req.body || {};
      const assetIds = [...new Set(Array.isArray(req.body?.assetIds) ? req.body.assetIds.map(String).filter(Boolean) : [])];
      if (!testId || !testStudentId || !assetIds.length) return res.status(400).json({ error: 'testId, testStudentId, and assetIds are required' });
      const test = await db.execute({ sql: 'SELECT id, status FROM tests WHERE id = ? AND school = ?', args: [testId, user.school] });
      if (!test.rows.length) return res.status(404).json({ error: 'Test not found' });
      const activeJob = await db.execute({ sql: "SELECT id FROM processing_jobs WHERE test_id = ? AND status IN ('queued', 'running') LIMIT 1", args: [testId] });
      if (!canRemoveStudentScan({ testStatus: test.rows[0].status, hasActiveProcessingJob: Boolean(activeJob.rows.length) })) return res.status(409).json({ error: removalBlockedMessage() });
      const placeholders = assetIds.map(() => '?').join(', ');
      const assets = await db.execute({
        sql: `SELECT id, storage_key FROM file_assets WHERE test_id = ? AND test_student_id = ? AND kind = 'answer_sheet' AND id IN (${placeholders})`,
        args: [testId, testStudentId, ...assetIds],
      });
      for (const asset of assets.rows) {
        const deletion = await deleteObject({ key: asset.storage_key });
        if (!deletion.ok && deletion.status !== 404) throw new Error(`Could not discard replacement page (${deletion.status})`);
      }
      if (assets.rows.length) await db.batch([
        { sql: `DELETE FROM file_assets WHERE id IN (${assets.rows.map(() => '?').join(', ')})`, args: assets.rows.map((asset) => asset.id) },
        { sql: `UPDATE test_students SET status = 'expected' WHERE id = ? AND NOT EXISTS (SELECT 1 FROM file_assets WHERE test_id = ? AND test_student_id = ? AND kind = 'answer_sheet' AND status = 'uploaded')`, args: [testStudentId, testId, testStudentId] },
      ], 'write');
      await syncTestUploadStatus(db, testId);
      return res.status(200).json({ ok: true, discardedAssetIds: assets.rows.map((asset) => asset.id) });
    }
    if (action === 'remove_answer_sheet') {
      const { testId, testStudentId } = req.body || {};
      if (!testId || !testStudentId) return res.status(400).json({ error: 'testId and testStudentId are required' });
      const reason = removalReason(req.body?.reason);
      const testResult = await db.execute({ sql: 'SELECT id, status FROM tests WHERE id = ? AND school = ?', args: [testId, user.school] });
      const test = testResult.rows[0];
      if (!test) return res.status(404).json({ error: 'Test not found' });
      const student = await db.execute({ sql: 'SELECT id FROM test_students WHERE id = ? AND test_id = ?', args: [testStudentId, testId] });
      if (!student.rows.length) return res.status(404).json({ error: 'Student is not part of this test' });
      const activeJob = await db.execute({
        sql: "SELECT id FROM processing_jobs WHERE test_id = ? AND status IN ('queued', 'running') LIMIT 1",
        args: [testId],
      });
      if (!canRemoveStudentScan({ testStatus: test.status, hasActiveProcessingJob: Boolean(activeJob.rows.length) })) {
        return res.status(409).json({ error: removalBlockedMessage() });
      }
      const assets = await db.execute({
        sql: "SELECT id, storage_key, status FROM file_assets WHERE test_id = ? AND test_student_id = ? AND kind = 'answer_sheet' ORDER BY created_at",
        args: [testId, testStudentId],
      });
      if (!assets.rows.length) {
        await db.execute({ sql: 'DELETE FROM intake_asset_events WHERE test_id = ? AND test_student_id = ?', args: [testId, testStudentId] });
        return res.status(200).json({ ok: true, alreadyRemoved: true, removedAssetIds: [], pageCount: 0, historyDeleted: true });
      }

      const assetIds = assets.rows.map((asset) => asset.id);
      for (const asset of assets.rows) {
        const deletion = await deleteObject({ key: asset.storage_key });
        if (!deletion.ok && deletion.status !== 404) throw new Error(`Could not remove uploaded scan (${deletion.status})`);
      }
      const completedAt = new Date().toISOString();
      await db.batch([
        { sql: 'DELETE FROM intake_asset_events WHERE test_id = ? AND test_student_id = ?', args: [testId, testStudentId] },
        { sql: 'DELETE FROM file_assets WHERE test_id = ? AND test_student_id = ? AND kind = \'answer_sheet\'', args: [testId, testStudentId] },
        {
          sql: `UPDATE test_students SET status = 'expected', expected_page_count = NULL WHERE id = ?`,
          args: [testStudentId],
        },
      ], 'write');
      await syncTestUploadStatus(db, testId, completedAt);
      return res.status(200).json({ ok: true, removedAssetIds: assetIds, pageCount: assetIds.length, studentStatus: 'expected', historyDeleted: true, reason });
    }
    if (action === 'replace_answer_sheet') {
      const { testId, testStudentId, keepAssetIds } = req.body || {};
      if (isScannerOnly(user) && !testStudentId) return res.status(403).json({ error: scannerDeniedMessage() });
      const retainedIds = [...new Set(Array.isArray(keepAssetIds) ? keepAssetIds.filter(Boolean) : [])];
      if (!testId || !testStudentId || !retainedIds.length) return res.status(400).json({ error: 'testId, testStudentId, and replacement pages are required' });
      const test = await db.execute({ sql: 'SELECT id, status FROM tests WHERE id = ? AND school = ?', args: [testId, user.school] });
      if (!test.rows.length) return res.status(404).json({ error: 'Test not found' });
      const activeJob = await db.execute({ sql: "SELECT id FROM processing_jobs WHERE test_id = ? AND status IN ('queued', 'running') LIMIT 1", args: [testId] });
      if (!canRemoveStudentScan({ testStatus: test.rows[0].status, hasActiveProcessingJob: Boolean(activeJob.rows.length) })) return res.status(409).json({ error: removalBlockedMessage() });
      const placeholders = retainedIds.map(() => '?').join(', ');
      const retained = await db.execute({
        sql: `SELECT id FROM file_assets WHERE test_id = ? AND test_student_id = ? AND kind = 'answer_sheet' AND status = 'uploaded' AND id IN (${placeholders})`,
        args: [testId, testStudentId, ...retainedIds],
      });
      if (retained.rows.length !== retainedIds.length) return res.status(400).json({ error: 'Replacement pages must be completed uploads for this student.' });
      const existing = await db.execute({
        sql: `SELECT id, storage_key FROM file_assets WHERE test_id = ? AND test_student_id = ? AND kind = 'answer_sheet' AND status = 'uploaded' AND id NOT IN (${placeholders})`,
        args: [testId, testStudentId, ...retainedIds],
      });
      for (const asset of existing.rows) {
        const deletion = await deleteObject({ key: asset.storage_key });
        if (!deletion.ok && deletion.status !== 404) throw new Error(`Could not replace prior page (${deletion.status})`);
      }
      if (existing.rows.length) {
        await db.execute({ sql: `DELETE FROM file_assets WHERE id IN (${existing.rows.map(() => '?').join(', ')})`, args: existing.rows.map((asset) => asset.id) });
      }
      await db.execute({
        sql: 'UPDATE test_students SET expected_page_count = ?, status = ? WHERE id = ?',
        args: [retainedIds.length, 'uploaded', testStudentId],
      });
      return res.status(200).json({ ok: true, retainedAssetIds: retainedIds, supersededAssetIds: existing.rows.map((asset) => asset.id) });
    }
    if (action === 'preview') {
      const { assetId } = req.body || {};
      const result = await db.execute({ sql: `SELECT a.*, t.school FROM file_assets a JOIN tests t ON t.id = a.test_id WHERE a.id = ?`, args: [assetId] });
      const asset = result.rows[0];
      if (!asset || asset.school !== user.school || asset.status !== 'uploaded') return res.status(404).json({ error: 'Uploaded file not found' });
      if (!canUploadIntakeAsset(user, asset.kind)) return res.status(403).json({ error: scannerDeniedMessage() });
      // The mobile workflow exposes previews for reference PDFs, while this
      // scoped endpoint also supports authenticated quality checks of a
      // student's own uploaded pages.
      if (!kinds.has(asset.kind)) return res.status(400).json({ error: 'This asset cannot be previewed' });
      return res.status(200).json({ previewUrl: createDownloadUrl({ key: asset.storage_key }) });
    }
    return res.status(400).json({ error: 'Unknown upload action' });
  } catch (error) { return res.status(/^Storage is not configured/.test(error.message) ? 503 : 500).json({ error: error.message }); }
}
