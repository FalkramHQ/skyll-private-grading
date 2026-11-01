import { createClient } from '@libsql/client/web';
import { documentForAsset, isRetryableMistralStatus, normalizeOcrResult, parseJsonModelResponse, validateRubricPackage } from './ocrProtocol.js';

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };
const workerId = `cf-mistral-ocr-${crypto.randomUUID()}`;

function now() { return new Date().toISOString(); }
function parseJson(value, fallback = {}) { try { return JSON.parse(value || ''); } catch { return fallback; } }
function id(prefix) { return `${prefix}_${crypto.randomUUID()}`; }
function secretMatches(actual, expected) {
  const a = new TextEncoder().encode(String(actual || ''));
  const b = new TextEncoder().encode(String(expected || ''));
  if (!a.length || a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) mismatch |= a[index] ^ b[index];
  return mismatch === 0;
}

function database(env) {
  if (!env.TURSO_DATABASE_URL || !env.TURSO_AUTH_TOKEN) throw new Error('Turso Worker secrets are not configured.');
  return createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
}

async function startStep(db, jobId, step, detail) {
  const row = await db.execute({ sql: 'SELECT progress_json FROM processing_jobs WHERE id = ?', args: [jobId] });
  const progress = parseJson(row.rows[0]?.progress_json, {});
  const steps = progress.steps || {};
  steps[step] = { status: 'running', detail, started_at: now(), completed_at: null };
  await db.execute({ sql: 'UPDATE processing_jobs SET progress_json = ? WHERE id = ?', args: [JSON.stringify({ ...progress, steps }), jobId] });
}

async function completeStep(db, jobId, step, detail) {
  const row = await db.execute({ sql: 'SELECT progress_json FROM processing_jobs WHERE id = ?', args: [jobId] });
  const progress = parseJson(row.rows[0]?.progress_json, {});
  const steps = progress.steps || {};
  steps[step] = { ...(steps[step] || {}), status: 'succeeded', detail, completed_at: now() };
  await db.execute({ sql: 'UPDATE processing_jobs SET progress_json = ? WHERE id = ?', args: [JSON.stringify({ ...progress, steps }), jobId] });
}

// This worker never heartbeats, so the lease outlives a queue consumer's
// 15-minute wall-time limit. If the run dies, the lease lapses and the OCI
// worker's reclaimExpiredJobs requeues the job instead of leaving it 'running'.
const CLAIM_LEASE_MS = 20 * 60_000;

async function claimJob(db, jobId) {
  const claimedAt = now();
  const leaseExpiresAt = new Date(Date.parse(claimedAt) + CLAIM_LEASE_MS).toISOString();
  await db.execute({
    sql: `UPDATE processing_jobs SET status = 'running', started_at = ?, worker_id = ?, error = NULL,
            heartbeat_at = ?, lease_expires_at = ?
          WHERE id = ? AND type IN ('mistral_ocr', 'build_rubric') AND status = 'queued'`,
    args: [claimedAt, workerId, claimedAt, leaseExpiresAt, jobId],
  });
  const result = await db.execute({ sql: 'SELECT * FROM processing_jobs WHERE id = ?', args: [jobId] });
  const job = result.rows[0];
  if (!job || job.status !== 'running' || job.worker_id !== workerId) return null;
  await db.execute({ sql: "UPDATE tests SET status = ?, updated_at = ? WHERE id = ?", args: [job.type === 'build_rubric' ? 'rubric_processing' : 'ocr_processing', claimedAt, job.test_id] });
  return job;
}

async function workerAssets(env, jobId) {
  const response = await fetch(`${String(env.WORKER_CALLBACK_URL).replace(/\/$/, '')}/api/internal/ocr-assets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-skyll-ocr-secret': env.OCR_WORKER_SHARED_SECRET },
    body: JSON.stringify({ jobId }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `OCR asset broker failed (${response.status})`);
  return Array.isArray(payload.assets) ? payload.assets : [];
}

async function requestMistral(env, asset) {
  const response = await fetch('https://api.mistral.ai/v1/ocr', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.MISTRAL_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: env.MISTRAL_OCR_MODEL || 'mistral-ocr-latest',
      document: documentForAsset(asset),
      include_image_base64: false,
      include_blocks: true,
      confidence_scores_granularity: 'page',
      table_format: 'html',
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.message || payload?.error?.message || `Mistral OCR failed (${response.status})`);
    error.retryable = isRetryableMistralStatus(response.status);
    throw error;
  }
  return normalizeOcrResult(payload);
}

async function activeRun(db, asset) {
  const result = await db.execute({
    sql: `SELECT id FROM asset_ocr_runs
          WHERE asset_id = ? AND is_active = 1 AND status = 'succeeded'
            AND COALESCE(asset_checksum, '') = COALESCE(?, '')
          ORDER BY completed_at DESC LIMIT 1`,
    args: [asset.id, asset.checksum || null],
  });
  return result.rows[0] || null;
}

async function recordArtifact(db, { jobId, asset, result, model }) {
  const revisionResult = await db.execute({ sql: 'SELECT COALESCE(MAX(revision), 0) AS revision FROM asset_ocr_runs WHERE asset_id = ?', args: [asset.id] });
  const revision = Number(revisionResult.rows[0]?.revision || 0) + 1;
  const completedAt = now();
  await db.batch([
    { sql: 'UPDATE asset_ocr_runs SET is_active = 0 WHERE asset_id = ? AND is_active = 1', args: [asset.id] },
    { sql: `INSERT INTO asset_ocr_runs (id, asset_id, job_id, engine, model, revision, asset_checksum, status, markdown, pages_json, page_count, usage_json, created_at, completed_at, is_active)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      args: [id('ocr'), asset.id, jobId, 'mistral', result.model || model, revision, asset.checksum || null, 'succeeded', result.markdown, JSON.stringify(result.pages), result.pageCount, JSON.stringify(result.usage), completedAt, completedAt] },
  ], 'write');
}

async function failJob(db, job, error) {
  const completedAt = now();
  const rubric = job.type === 'build_rubric';
  await db.batch([
    { sql: "UPDATE processing_jobs SET status = 'failed_retryable', completed_at = ?, error = ? WHERE id = ?", args: [completedAt, String(error?.message || error), job.id] },
    { sql: "UPDATE tests SET status = ?, updated_at = ? WHERE id = ?", args: [rubric ? 'rubric_failed' : 'ocr_failed', completedAt, job.test_id] },
    { sql: "UPDATE job_steps SET status = 'failed', detail = ?, completed_at = ? WHERE job_id = ? AND step IN ('validate_inputs', 'ocr', 'parse_key') AND status = 'running'", args: [String(error?.message || error), completedAt, job.id] },
  ], 'write');
}

function renderOcrSource(rows) {
  return rows.map((row) => {
    const pages = parseJson(row.pages_json, []);
    const content = pages.map((page) => `--- page ${Number(page.index) + 1} ---\n${page.markdown || ''}`).join('\n\n') || row.markdown || '';
    return `[${row.kind}]\n${content}`;
  }).join('\n\n').slice(0, 150000);
}

async function rubricSources(db, testId) {
  const result = await db.execute({
    sql: `SELECT a.id AS asset_id, a.kind, o.id AS ocr_run_id, o.markdown, o.pages_json
          FROM file_assets a JOIN asset_ocr_runs o ON o.asset_id = a.id
          WHERE a.test_id = ? AND a.status = 'uploaded' AND o.is_active = 1 AND o.status = 'succeeded'
            AND a.kind IN ('question_paper', 'answer_key')
          ORDER BY CASE a.kind WHEN 'question_paper' THEN 0 ELSE 1 END, a.created_at`,
    args: [testId],
  });
  const questionPaper = result.rows.filter((row) => row.kind === 'question_paper');
  const answerKey = result.rows.filter((row) => row.kind === 'answer_key');
  if (!questionPaper.length || !answerKey.length) throw new Error('Active OCR results for both the question paper and answer key are required.');
  return { questionPaper, answerKey };
}

async function requestRubric(env, sources) {
  if (!env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is not configured for rubric generation.');
  const prompt = `You are creating the canonical marking package for one assessment. Use the QUESTION PAPER to establish exact question numbers, wording, marks, sections and optional-choice rules. Use the IDEAL ANSWER KEY to establish correct answers and concrete partial-credit rubrics. Do not invent questions, answers, marks, or optional rules. Preserve a table as information within the question text when it is needed to solve the question.\n\nReturn JSON only in this exact shape:\n{\n  "exam": {"title": "", "total_marks": 0, "optional_rules": "", "instructions": ""},\n  "questions": [{\n    "id": "stable short identifier", "number": "Q1 or Q2(a)", "question_text": "full student-facing question", "marks_allocated": 0, "topic": "",\n    "expected_response_type": "mcq|numerical|short_answer|long_answer|diagram|table|proof|other", "correct_answer_summary": "",\n    "accepted_variations": [""], "marking_rubric": "explicit mark split and what earns/loses each mark", "answer_key_evidence": "key evidence",\n    "question_source_pages": [0], "answer_key_source_pages": [0], "is_optional": false, "selection_group": null, "visual_requirements": null\n  }]\n}\n\nHard rules:\n- Every scorable question or sub-question must be a separate item.\n- For optional questions, identify the selection group and state the rule in exam.optional_rules.\n- A diagram/graph can earn marks from visible requirements; never require prose unless the paper does.\n- For MCQs, preserve both option content and the correct option.\n- Rubrics must explain partial credit concretely, not just say 'partial marks'.\n- Source page indexes are zero-based and must point to the supplied OCR text.\n\nQUESTION PAPER OCR:\n${renderOcrSource(sources.questionPaper)}\n\nIDEAL ANSWER KEY OCR:\n${renderOcrSource(sources.answerKey)}`;
  const response = await fetch(env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/chat/completions', {
    method: 'POST', headers: { authorization: `Bearer ${env.DEEPSEEK_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: env.DEEPSEEK_RUBRIC_MODEL || 'deepseek-v4-flash', temperature: 0, max_tokens: 16000, messages: [{ role: 'system', content: 'Return only valid JSON. Accuracy and exact question alignment matter more than brevity.' }, { role: 'user', content: prompt }] }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || payload?.message || `Rubric model failed (${response.status})`);
  return { rubric: validateRubricPackage(parseJsonModelResponse(payload?.choices?.[0]?.message?.content)), model: payload?.model || env.DEEPSEEK_RUBRIC_MODEL || 'deepseek-v4-flash' };
}

async function processRubricJob(env, jobId) {
  const db = database(env); const job = await claimJob(db, jobId);
  if (!job) return { skipped: true };
  try {
    await startStep(db, job.id, 'parse_key', 'Reading the active question-paper and answer-key OCR artifacts');
    const sources = await rubricSources(db, job.test_id);
    const output = await requestRubric(env, sources);
    const revisionResult = await db.execute({ sql: 'SELECT COALESCE(MAX(version), 0) AS version FROM exam_rubric_versions WHERE test_id = ?', args: [job.test_id] });
    const version = Number(revisionResult.rows[0]?.version || 0) + 1; const completedAt = now();
    const sourceIds = [...sources.questionPaper, ...sources.answerKey].map((row) => row.ocr_run_id);
    await db.batch([
      { sql: 'UPDATE exam_rubric_versions SET is_active = 0 WHERE test_id = ? AND is_active = 1', args: [job.test_id] },
      { sql: `INSERT INTO exam_rubric_versions (id, test_id, job_id, version, status, model, source_ocr_run_ids_json, question_map_json, quality_json, created_at, completed_at, is_active)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`, args: [id('rubric'), job.test_id, job.id, version, 'succeeded', output.model, JSON.stringify(sourceIds), JSON.stringify(output.rubric), JSON.stringify(output.rubric.quality), completedAt, completedAt] },
      { sql: "UPDATE job_steps SET status = 'succeeded', detail = ?, completed_at = ? WHERE job_id = ? AND step = 'parse_key'", args: [`${output.rubric.quality.questionCount} canonical question(s), ${output.rubric.quality.totalMarks} scorable marks`, completedAt, job.id] },
      { sql: "UPDATE processing_jobs SET status = 'succeeded', completed_at = ?, error = NULL, result_json = ? WHERE id = ?", args: [completedAt, JSON.stringify({ rubricVersion: version, ...output.rubric.quality, model: output.model }), job.id] },
      { sql: "UPDATE tests SET status = 'rubric_complete', updated_at = ? WHERE id = ?", args: [completedAt, job.test_id] },
    ], 'write');
    return { version, ...output.rubric.quality };
  } catch (error) { await failJob(db, job, error); throw error; }
}

export async function processOcrJob(env, jobId) {
  const db = database(env);
  const job = await claimJob(db, jobId);
  if (!job) return { skipped: true };
  try {
    await startStep(db, job.id, 'validate_inputs', 'Loading private source files through the signed URL broker');
    const assets = await workerAssets(env, job.id);
    if (!assets.length) throw new Error('No uploaded source files are available for OCR.');
    await completeStep(db, job.id, 'validate_inputs', `${assets.length} uploaded source file(s) verified`);
    await startStep(db, job.id, 'ocr', `Mistral OCR running for ${assets.length} source file(s)`);
    const payload = parseJson(job.payload_json);
    let processed = 0; let reused = 0;
    for (const asset of assets) {
      if (!payload.force && await activeRun(db, asset)) { reused += 1; continue; }
      const result = await requestMistral(env, asset);
      if (!result.markdown) throw new Error(`Mistral OCR returned no readable content for ${asset.kind} (${asset.id}).`);
      await recordArtifact(db, { jobId: job.id, asset, result, model: env.MISTRAL_OCR_MODEL });
      processed += 1;
      await db.execute({ sql: "UPDATE job_steps SET detail = ? WHERE job_id = ? AND step = 'ocr'", args: [`OCR complete for ${processed + reused}/${assets.length} source file(s)`, job.id] });
    }
    await completeStep(db, job.id, 'ocr', `${processed} file(s) processed; ${reused} unchanged artifact(s) reused`);
    const completedAt = now();
    await db.batch([
      { sql: "UPDATE processing_jobs SET status = 'succeeded', completed_at = ?, error = NULL, result_json = ? WHERE id = ?", args: [completedAt, JSON.stringify({ processedAssets: processed, reusedAssets: reused, totalAssets: assets.length, engine: 'mistral', model: env.MISTRAL_OCR_MODEL || 'mistral-ocr-latest' }), job.id] },
      { sql: "UPDATE tests SET status = 'ocr_complete', updated_at = ? WHERE id = ?", args: [completedAt, job.test_id] },
    ], 'write');
    return { processed, reused, total: assets.length };
  } catch (error) {
    await failJob(db, job, error);
    throw error;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') return new Response(JSON.stringify({ ok: true, worker: 'skyll-mistral-ocr' }), { headers: jsonHeaders });
    if (request.method !== 'POST' || url.pathname !== '/dispatch') return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: jsonHeaders });
    if (!secretMatches(request.headers.get('x-skyll-ocr-secret'), env.OCR_WORKER_SHARED_SECRET)) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: jsonHeaders });
    const body = await request.json().catch(() => ({}));
    const jobId = String(body?.jobId || '').trim();
    if (!jobId) return new Response(JSON.stringify({ error: 'jobId is required' }), { status: 400, headers: jsonHeaders });
    await env.OCR_JOBS.send({ jobId });
    return new Response(JSON.stringify({ queued: true, jobId }), { status: 202, headers: jsonHeaders });
  },

  async queue(batch, env, ctx) {
    for (const message of batch.messages) {
      const jobId = String(message.body?.jobId || '').trim();
      if (!jobId) { message.ack(); continue; }
      try {
        const db = database(env);
        const jobResult = await db.execute({ sql: 'SELECT type FROM processing_jobs WHERE id = ?', args: [jobId] });
        if (jobResult.rows[0]?.type === 'build_rubric') await processRubricJob(env, jobId);
        else await processOcrJob(env, jobId);
        message.ack();
      } catch (error) {
        console.error('OCR job failed', { jobId, error: String(error?.message || error) });
        // The database records a retryable failure and the dashboard creates a
        // fresh versioned attempt. Ack to avoid a stale queue delivery claiming
        // the same durable job after its error has already been made visible.
        message.ack();
      }
    }
    ctx.waitUntil(Promise.resolve());
  },
};
