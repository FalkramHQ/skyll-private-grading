import { ensureAuthTables, requireUser, database } from '../../api/_lib/auth.js';
import { ensureIntakeTables, id } from '../../api/_lib/intake.js';
import { deleteObject } from '../../api/_lib/storage.js';
import { approveRubricAndMarkForGrading } from '../../api/_lib/rubricReviewService.js';
import { incompleteStudentPapersSql } from './paperCompleteness.js';
import { syncTestUploadStatus } from './uploadStatus.js';

const OCR_JOB_TYPE = 'mistral_ocr';
const RUBRIC_JOB_TYPE = 'build_rubric';
const PROCESS_JOB_TYPE = 'process_test';
const STALE_INCOMPLETE_UPLOAD_AGE_MS = 15 * 60 * 1000;

/**
 * The test an action targets. School admins stay scoped to their own school
 * (tests carries the school name; canonical school_id is still being backfilled
 * on legacy rows). Platform admins (skyll_admin) act on any school's test, so
 * the lookup is by id alone and the test's own school is used downstream.
 */
export async function resolveActionableTest(db, user, testId) {
  const lookup = user.role === 'skyll_admin'
    ? { sql: 'SELECT * FROM tests WHERE id = ?', args: [testId] }
    : { sql: 'SELECT * FROM tests WHERE id = ? AND school = ?', args: [testId, user.school] };
  const result = await db.execute(lookup);
  return result.rows[0] || null;
}

/**
 * Tenancy for rows created on behalf of a test: always the test's own school,
 * never the acting user's, so a platform admin cannot stamp their own school
 * onto another school's job.
 */
export function jobTenancy(test, user) {
  return {
    school: test.school || user.school,
    schoolId: test.school_id || (user.role === 'skyll_admin' ? null : user.school_id || null),
  };
}

async function dispatchOcrJob(jobId) {
  const workerUrl = String(process.env.OCR_WORKER_URL || '').replace(/\/$/, '');
  const sharedSecret = process.env.OCR_WORKER_SHARED_SECRET;
  // OCI processors claim queued jobs directly from Turso. Retain this optional
  // dispatch only for the Cloudflare worker fallback during migration.
  if (!workerUrl || !sharedSecret) return { queuedForPoller: true };
  const response = await fetch(`${workerUrl}/dispatch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-skyll-ocr-secret': sharedSecret },
    body: JSON.stringify({ jobId }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Cloudflare OCR dispatch failed (${response.status})`);
}

// The latest queued/running job of one type for a test, or null.
async function findActiveJob(db, testId, type) {
  const active = await db.execute({
    sql: `SELECT id, status FROM processing_jobs
          WHERE test_id = ? AND type = ? AND status IN ('queued', 'running')
          ORDER BY requested_at DESC LIMIT 1`,
    args: [testId, type],
  });
  return active.rows[0] || null;
}

/**
 * Insert a test-level job. Two clicks can both pass the active-job check;
 * migration 088's partial unique index lets one insert win, and the loser
 * returns the winner's job (as already queued) instead of a 500.
 */
async function insertSingletonJob(db, statements, testId, type) {
  try {
    await db.batch(statements, 'write');
    return null;
  } catch (error) {
    const winner = /UNIQUE constraint failed/i.test(String(error?.message || error?.cause?.message || ''))
      ? await findActiveJob(db, testId, type)
      : null;
    if (!winner) throw error;
    return winner;
  }
}

async function assetsForOcr(db, testId) {
  const assets = await db.execute({
    sql: `SELECT kind, COUNT(*) AS count FROM file_assets
          WHERE test_id = ? AND status = 'uploaded'
          GROUP BY kind`,
    args: [testId],
  });
  return Object.fromEntries(assets.rows.map((row) => [row.kind, Number(row.count)]));
}

async function createOcrJob({ db, test, user, force = false }) {
  const counts = await assetsForOcr(db, test.id);
  if (!counts.question_paper || !counts.answer_key || !counts.answer_sheet) {
    const error = new Error('Upload at least one answer sheet, the question paper, and the answer key before OCR.');
    error.statusCode = 409;
    throw error;
  }
  const active = await findActiveJob(db, test.id, OCR_JOB_TYPE);
  if (active) return { job: { id: active.id, testId: test.id, status: active.status }, reused: true };
  const now = new Date().toISOString();
  const jobId = id('job');
  const tenancy = jobTenancy(test, user);
  const winner = await insertSingletonJob(db, [
    { sql: 'INSERT INTO processing_jobs (id, test_id, school, school_id, type, status, payload_json, requested_by, requested_at, progress_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', args: [jobId, test.id, tenancy.school, tenancy.schoolId, OCR_JOB_TYPE, 'queued', JSON.stringify({ asset_counts: counts, force: Boolean(force) }), user.username, now, JSON.stringify({ steps: { validate_inputs: { status: 'queued', detail: 'Awaiting Skyll Mistral OCR worker' } } })] },
    { sql: "UPDATE tests SET status = 'ocr_queued', updated_at = ? WHERE id = ?", args: [now, test.id] },
  ], test.id, OCR_JOB_TYPE);
  if (winner) return { job: { id: winner.id, testId: test.id, status: winner.status }, reused: true };
  return { job: { id: jobId, testId: test.id, status: 'queued' }, reused: false };
}

async function createRubricJob({ db, test, user, force = false }) {
  const ocr = await db.execute({
    sql: `SELECT id FROM processing_jobs
          WHERE test_id = ? AND type = ?
          ORDER BY requested_at DESC LIMIT 1`,
    args: [test.id, OCR_JOB_TYPE],
  });
  const sources = await db.execute({
    sql: `SELECT DISTINCT a.kind
          FROM file_assets a JOIN asset_ocr_runs o ON o.asset_id = a.id
          WHERE a.test_id = ? AND a.status = 'uploaded' AND o.is_active = 1 AND o.status = 'succeeded'
            AND a.kind IN ('question_paper', 'answer_key')`,
    args: [test.id],
  });
  const present = new Set(sources.rows.map((row) => row.kind));
  if (!present.has('question_paper') || !present.has('answer_key')) {
    const error = new Error('The active OCR artifacts for the question paper and answer key are required before building a rubric.');
    error.statusCode = 409;
    throw error;
  }
  const active = await findActiveJob(db, test.id, RUBRIC_JOB_TYPE);
  if (active) return { job: { id: active.id, testId: test.id, status: active.status }, reused: true };
  const now = new Date().toISOString(); const jobId = id('job');
  const tenancy = jobTenancy(test, user);
  const winner = await insertSingletonJob(db, [
    { sql: 'INSERT INTO processing_jobs (id, test_id, school, school_id, type, status, payload_json, requested_by, requested_at, progress_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', args: [jobId, test.id, tenancy.school, tenancy.schoolId, RUBRIC_JOB_TYPE, 'queued', JSON.stringify({ force: Boolean(force), ocr_job_id: ocr.rows[0]?.id || null }), user.username, now, JSON.stringify({ steps: { parse_key: { status: 'queued', detail: 'Awaiting Skyll rubric worker' } } })] },
    { sql: "UPDATE tests SET status = 'rubric_queued', updated_at = ? WHERE id = ?", args: [now, test.id] },
  ], test.id, RUBRIC_JOB_TYPE);
  if (winner) return { job: { id: winner.id, testId: test.id, status: winner.status }, reused: true };
  return { job: { id: jobId, testId: test.id, status: 'queued' }, reused: false };
}

function staleUploadCutoff(now = new Date()) {
  return new Date(now.getTime() - STALE_INCOMPLETE_UPLOAD_AGE_MS).toISOString();
}

export { syncTestUploadStatus } from './uploadStatus.js';

export async function cleanupStaleIncompleteUploads({ db, testId, now = new Date() }) {
  const cutoff = staleUploadCutoff(now);
  const stale = await db.execute({
    sql: `SELECT id, test_student_id, kind, storage_key
          FROM file_assets
          WHERE test_id = ? AND status IN ('registered', 'uploading') AND created_at < ?
          ORDER BY created_at`,
    args: [testId, cutoff],
  });
  if (!stale.rows.length) return { cleaned: false, removedAssetIds: [], cutoff };

  for (const asset of stale.rows) {
    const deletion = await deleteObject({ key: asset.storage_key });
    if (!deletion.ok && deletion.status !== 404) throw new Error(`Could not discard stale upload (${deletion.status})`);
  }

  const removedAssetIds = stale.rows.map((asset) => asset.id);
  const removedStudentIds = [...new Set(stale.rows.filter((asset) => asset.kind === 'answer_sheet' && asset.test_student_id).map((asset) => asset.test_student_id))];
  const statements = [{ sql: `DELETE FROM file_assets WHERE id IN (${removedAssetIds.map(() => '?').join(', ')})`, args: removedAssetIds }];
  for (const testStudentId of removedStudentIds) {
    statements.push({
      sql: `UPDATE test_students SET status = 'expected'
            WHERE id = ? AND NOT EXISTS (
              SELECT 1 FROM file_assets
              WHERE test_id = ? AND test_student_id = ? AND kind = 'answer_sheet' AND status = 'uploaded'
            )`,
      args: [testStudentId, testId, testStudentId],
    });
  }
  await db.batch(statements, 'write');
  await syncTestUploadStatus(db, testId, now.toISOString());
  return { cleaned: true, removedAssetIds, removedStudentIds, cutoff };
}

export default async function handler(req, res) {
  try {
    await ensureAuthTables(); await ensureIntakeTables();
    const user = await requireUser(req, res, ['admin', 'skyll_admin']);
    if (!user) return;
    const db = database();
    if (req.method === 'GET') {
      // The list stays scoped to the session's school for every role (FLKRM-386
      // matrix); cross-school visibility for platform admins is the operations page.
      const result = await db.execute({ sql: 'SELECT * FROM processing_jobs WHERE school = ? ORDER BY requested_at DESC LIMIT 100', args: [user.school] });
      return res.status(200).json({ jobs: result.rows });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { testId, action } = req.body || {};
    if (!testId) return res.status(400).json({ error: 'testId is required' });
    const test = await resolveActionableTest(db, user, testId);
    if (!test) return res.status(404).json({ error: 'Test not found' });
    await cleanupStaleIncompleteUploads({ db, testId });
    const incompleteAssets = await db.execute({
      sql: `SELECT kind, status, COUNT(*) AS count
            FROM file_assets
            WHERE test_id = ? AND status IN ('registered', 'uploading')
            GROUP BY kind, status
            ORDER BY kind, status`,
      args: [testId],
    });
    if (incompleteAssets.rows.length) {
      const pending = incompleteAssets.rows.map((row) => ({
        kind: row.kind,
        status: row.status,
        count: Number(row.count),
      }));
      return res.status(409).json({
        error: 'Finish, retry, or discard every pending upload before processing.',
        pendingUploads: pending,
      });
    }
    const incompletePapers = await db.execute({ sql: incompleteStudentPapersSql(), args: [testId] });
    if (incompletePapers.rows.length) {
      return res.status(409).json({ error: 'Finish every student’s scanned pages before processing.' });
    }
    if (!action || ['start_ocr', 'retry_ocr', 'rerun_ocr'].includes(action)) {
      let created;
      try {
        created = await createOcrJob({ db, test, user, force: action === 'rerun_ocr' });
        // A prior dispatch can fail after the durable row was created. Reusing
        // that queued row must re-dispatch it rather than leaving it stranded.
        if (created.job.status === 'queued') await dispatchOcrJob(created.job.id);
      } catch (error) {
        return res.status(error.statusCode || 502).json({ error: error.message });
      }
      return res.status(created.reused ? 200 : 201).json(created);
    }
    if (['build_rubric', 'retry_rubric', 'rerun_rubric'].includes(action)) {
      let created;
      try {
        created = await createRubricJob({ db, test, user, force: action === 'rerun_rubric' });
        if (created.job.status === 'queued') await dispatchOcrJob(created.job.id);
      } catch (error) {
        return res.status(error.statusCode || 502).json({ error: error.message });
      }
      return res.status(created.reused ? 200 : 201).json(created);
    }
    if (['mark_for_grading', 'start_grading', 'approve_rubric'].includes(action)) {
      try {
        const result = await approveRubricAndMarkForGrading(db, user, { testId, overrideReason: req.body?.overrideReason });
        return res.status(result.reused ? 200 : 201).json(result);
      } catch (error) {
        return res.status(error.statusCode || 500).json({ error: error.message });
      }
    }
    const existing = await findActiveJob(db, testId, PROCESS_JOB_TYPE);
    if (existing) return res.status(200).json({ job: { id: existing.id, testId, status: existing.status }, reused: true });
    const assets = await db.execute({ sql: "SELECT kind, COUNT(*) AS count FROM file_assets WHERE test_id = ? AND status = 'uploaded' GROUP BY kind", args: [testId] });
    const counts = Object.fromEntries(assets.rows.map((row) => [row.kind, Number(row.count)]));
    if (!counts.question_paper || !counts.answer_key || !counts.answer_sheet) {
      return res.status(409).json({ error: 'Upload at least one answer sheet, the question paper, and the answer key before processing' });
    }
    const now = new Date().toISOString(); const jobId = id('job');
    const tenancy = jobTenancy(test, user);
    const winner = await insertSingletonJob(db, [
      { sql: 'INSERT INTO processing_jobs (id, test_id, school, school_id, type, status, payload_json, requested_by, requested_at, progress_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', args: [jobId, testId, tenancy.school, tenancy.schoolId, PROCESS_JOB_TYPE, 'queued', JSON.stringify({ asset_counts: counts }), user.username, now, JSON.stringify({ steps: { validate_inputs: { status: 'queued', detail: 'Awaiting processing worker' } } })] },
      { sql: "UPDATE tests SET status = 'ready_for_processing', updated_at = ? WHERE id = ?", args: [now, testId] },
    ], testId, PROCESS_JOB_TYPE);
    if (winner) return res.status(200).json({ job: { id: winner.id, testId, status: winner.status }, reused: true });
    return res.status(201).json({ job: { id: jobId, testId, status: 'queued' } });
  } catch (error) { return res.status(500).json({ error: error.message }); }
}
