import { createClient } from '@libsql/client';
import { documentForAsset, isRetryableMistralStatus, normalizeOcrResult, validateRubricPackage } from '../../workers/mistral-ocr/src/ocrProtocol.js';
import { assetFilename, ocrWithDatalab, resolveOcrEngine } from './datalabOcr.js';
import { NEAR_OCR_MODEL, ocrWithNearAi, readsStudentWork } from './nearOcr.js';
import { privateInferenceDbSink } from './privateInferenceSink.js';
import { createAlerter } from '../../shared/alerts.js';
import { UNCLEAR_SYMBOLS_TAG } from '../../shared/gradingCalibration.js';
import { createHousekeeper } from './housekeeping.js';
import { createDownloadUrl } from '../../api/_lib/storage.js';
import { loadCohortRun, processCohortRegradeStep } from '../../api/vl-queue.js';
import { refreshTeacherReportModules } from '../../api/_lib/cohortRegrade.js';
import { refreshLearnerDna } from '../../api/_lib/learnerDnaRefresh.js';
import { requireStudentPublicLogin } from './studentIdentity.js';
import { claimJobStatement, createShutdown, errorCode, extendLeaseStatement, leaseExpiresAt, reclaimDecision, releaseOnShutdownStatement, retryAt, startLeaseHeartbeat } from './lifecycle.js';
import { applyScoringPlan } from './scoringPlan.js';
import { checkRubricGate, rubricGateEnabled } from '../../shared/rubricGate.js';
import { buildRubricPrompt, requestRubricPackage } from './rubricBuild.js';
import { applyKeyCheck, checkerFamily, runKeyCheck } from './keyCheck.js';
import { decideOcrOutcome } from './ocrOutcome.js';
import { presentQuestionForReport, reportBlockingCountStatement } from './reportReadiness.js';
import { findScoreMismatches, gradeMarkStatements, reportScoreMismatches, teacherKeptMarks } from './submissionScore.js';
import { sortAnswerSheetRows, sourceOcrText } from './ocrText.js';
import { shouldUseMarkers } from './evidencePipeline.js';
import { evidenceOutcome } from './evidenceAnswers.js';
import { loadAnswerSheetPageTexts } from '../../api/_lib/answerLocationService.js';
import { EvidenceSupervisor } from './evidenceSupervisor.js';
import { extractStudentAnswers } from './evidenceExtract.js';
import { runDeepSignalExtraction } from './deepSignalExtractor.js';
import { listStudentsNeedingSynthesis, runHiveSynthesis } from './hiveSynthesis.js';
import { examForTest, logMirrorFailure, requireMirror, resolveSchoolId, syncCanonicalSubmission, syncExamSetQuestionsFromRubric, syncQuestionReview, syncV2Question } from '../../api/_lib/canonicalSubmissions.js';
import { runMasteryEstimation } from '../../api/_lib/masteryEstimator.js';
import { canonicalExamStatements, ensureSubjectId, currentAcademicYearId, examRowId } from '../../api/_lib/exams.js';
import { normalizeRecommendations, normalizeStrategies } from '../../shared/reportActionItems.js';
import { guardSubjectClaims, marksByQuestion, scoreDimensionsFromMarks } from '../../shared/reportClaims.js';
import { detectAndStoreEarlyWarning } from '../../api/_lib/earlyWarning.js';
import { gradeWithSupervision } from './gradeSupervisor.js';
import { buildMcqBatchGradePrompt, normalizeGradeResult } from './gradeResult.js';
import {
  buildVisualRescuePrompt,
  isReviewerTouchedQuestion,
  rankVisualPages,
  validateVisualRescueDescription,
  visualAnswerAnchor,
} from './visualRescue.js';
import { deepinfraCompatConfig, callDeepinfraModelJson, callGradeJson, callReasoningJson, callReportModulesJson } from './llmGateway.js';
import { nearAiConfig, nearPrivateChatCompletion, nearPrivateEnabledForCurrentJob, runWithInferenceContext, setPrivateInferenceSink } from './nearPrivateInference.js';
import { now, id, parseJson, text, scoreStatus, textList, initialModulesFallback, learningModeIds } from './workerUtils.js';
import { drainPushOutbox, enqueuePush, ensurePushOutboxTable, pushOutboxStatement, PUSH_EVENT_TYPES } from '../../api/_lib/pushOutbox.js';
import { createCommsRunner } from '../../server/comms/worker.js';

const ocrEngine = resolveOcrEngine(process.env);
const required = ['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN', 'S3_ENDPOINT', 'S3_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
if (ocrEngine === 'mistral') required.push('MISTRAL_API_KEY');
else required.push('DATALAB_API_KEY');
for (const name of required) if (!process.env[name]) throw new Error(`Missing ${name}.`);
if (!process.env.PHALA_API_KEY && !process.env.DEEPSEEK_API_KEY && !process.env.DEEPINFRA_API_KEY) {
  throw new Error('Missing PHALA_API_KEY, DEEPSEEK_API_KEY, or DEEPINFRA_API_KEY.');
}

// Tests point WORKER_DB_URL (or TURSO_DATABASE_URL) at a disposable file:
// database to exercise the orchestration functions; a local file takes no
// auth token. Production always uses the Turso/libsql URL plus token.
const dbUrl = process.env.WORKER_DB_URL || process.env.TURSO_DATABASE_URL;
const db = createClient(dbUrl.startsWith('file:') ? { url: dbUrl } : { url: dbUrl, authToken: process.env.TURSO_AUTH_TOKEN });
// Worker instance number from systemd template (default 1 for backward compatibility)
const workerInstance = String(process.env.WORKER_INSTANCE || '1').trim();

const workerId = `oci-${process.env.HOSTNAME || 'worker'}-${workerInstance}-${crypto.randomUUID()}`;
const workerVersion = process.env.SKYLL_WORKER_VERSION || 'unknown';
const pollIntervalMs = Math.max(1000, Number(process.env.POLL_INTERVAL_MS || 3000));
const regradeLeaseMs = Math.max(60_000, Number(process.env.COHORT_REGRADE_LEASE_MS || 10 * 60_000));
// Leases are kept alive by a timer while a job runs (FLKRM-373), so the lease
// only needs to outlast a few missed beats, not the slowest stage. A short lease
// means a crashed worker's job is reclaimed in minutes rather than half an hour.
const jobLeaseMs = Math.max(60_000, Number(process.env.PROCESSING_JOB_LEASE_MS || 5 * 60_000));
const jobHeartbeatMs = Math.min(Math.max(5_000, Number(process.env.PROCESSING_JOB_HEARTBEAT_MS || 30_000)), Math.floor(jobLeaseMs / 3));
// Must stay below the unit's TimeoutStopSec (45s) so release runs before SIGKILL.
const shutdownGraceMs = Math.max(0, Number(process.env.WORKER_SHUTDOWN_GRACE_MS || 30_000));
const maxJobAttempts = Math.max(1, Number(process.env.PROCESSING_JOB_MAX_ATTEMPTS || 3));
const retryBaseMs = Math.max(1_000, Number(process.env.PROCESSING_JOB_RETRY_BASE_MS || 60_000));
const retryMaxMs = Math.max(retryBaseMs, Number(process.env.PROCESSING_JOB_RETRY_MAX_MS || 15 * 60_000));
const workerHeartbeatMs = Math.max(5_000, Number(process.env.WORKER_HEARTBEAT_MS || 30_000));
const pushDrainIntervalMs = Math.max(5_000, Number(process.env.PUSH_DRAIN_INTERVAL_MS || 20_000));

// Per-instance lane restrictions (fallback to base vars for backward compat)
const instanceSuffix = workerInstance === '1' ? '' : `_${workerInstance}`;
const processingSchool = String(process.env[`PROCESSING_SCHOOL${instanceSuffix}`] || process.env.PROCESSING_SCHOOL || '').trim();
const processingTestId = String(process.env[`PROCESSING_TEST_ID${instanceSuffix}`] || process.env.PROCESSING_TEST_ID || '').trim();
const processingJobTypes = String(process.env[`PROCESSING_JOB_TYPES${instanceSuffix}`] || process.env.PROCESSING_JOB_TYPES || '')
  .split(',').map((value) => value.trim()).filter(Boolean);
const workerStartedAt = new Date().toISOString();
let stopping = false;
let activeJob = null;
let processedRegradeLastTick = false;
let lastWorkerHeartbeatAt = 0;
let lastPushDrainAt = 0;
let lastHiveSynthesisQueueAt = 0;
const hiveSynthesisQueueMs = Math.max(60_000, Number(process.env.HIVE_SYNTHESIS_QUEUE_MS || 15 * 60_000));
const hiveSideJobTypes = new Set(['deep_signal_extraction', 'hive_synthesis', 'mastery_estimation']);
const alerts = createAlerter();

// Verified NEAR AI attestations and per-response receipts (migration 091).
setPrivateInferenceSink(privateInferenceDbSink(db));

// Job rows carry a school's display name, which has historical spellings, so opt-in also
// matches on the canonical id. Looked up only once some school is opted in.
async function inferenceSchoolId(school) {
  if (!process.env.NEAR_AI_SCHOOLS || !school) return null;
  return resolveSchoolId(db, school).catch(() => null);
}

async function generateInitialReportModules({ student, subjectName, questions }) {
  const fallback = initialModulesFallback(questions);
  if (String(process.env.REPORT_MODULE_PROVIDER || '').toLowerCase() === 'deterministic') return fallback;
  const scoredQuestions = questions.filter((question) => question.counts_toward_score !== false);
  const score = scoredQuestions.reduce((sum, question) => sum + Number(question.scored_marks_obtained ?? question.marks_obtained ?? 0), 0);
  const total = scoredQuestions.reduce((sum, question) => sum + Number(question.scored_marks_allocated ?? question.marks_total ?? 0), 0);
  const signal = scoredQuestions.map((question) => ({
    id: question.number,
    topic: question.topic || 'General',
    score: `${Number(question.marks_obtained)}/${Number(question.marks_total)}`,
    status: question.status,
    feedback: text(question.missing_or_wrong || question.what_went_correct || question.grading_reason, 500),
  }));
  const prompt = [
    'Create evidence-bound student report modules from one completed assessment.',
    'Never alter marks, claim to see scans, mention AI/OCR/reviewers, diagnose personality, or invent a misconception not supported by the question feedback.',
    'Keep every statement specific, constructive, and useful for the next study session. Use only these Learner DNA mode IDs: architect, pathfinder, maker, cartographer, calibrator, bridgebuilder.',
    'Return at most 3 strengths, 3 misconceptions, 3 recommendations, 3 strategies, and 3 dimensions. Keep every string under 80 words. The entire JSON must be under 1,200 words.',
    'Each Learner DNA dimension score is a 0-100 percentage. Claim full credit only on questions whose score is full.',
    'Use the official scored total below exactly if you mention a score. Do not mention raw marks from excluded optional questions. Base the learner profile only on the scored question evidence.',
    'Return JSON only with this exact shape:',
    '{"subject":{"overall_insights":"","strengths":[""],"misconceptions":[""],"recommendations":[{"topic":"","action":"","priority":"important"}],"root_cause":"","learning_profile":{"core_strength":"","pattern_recognition":"","root_cause_analysis":"","strategies":[{"topic":"","strategy":""}]}},"learner_dna":{"primary_mode":{"mode_id":"","description":"","evidence":""},"growth_edge":{"mode_id":"","action":"","evidence":""},"dimensions":[{"mode_id":"","state":"secure|developing|needs_practice|not_observed","score":0,"evidence_question_ids":[""]}],"next_move":{"title":"","action":""}}}',
    `Student: ${student.name}`,
    `Subject: ${subjectName}`,
    `Official scored total: ${score}/${total}`,
    `Question evidence: ${JSON.stringify(signal)}`,
  ].join('\n');
  try {
    const result = await callReportModulesJson(prompt, 4800);
    const raw = result.value || {};
    const subject = raw.subject && typeof raw.subject === 'object' ? raw.subject : {};
    const dna = raw.learner_dna && typeof raw.learner_dna === 'object' ? raw.learner_dna : {};
    const ids = new Set(questions.map((question) => String(question.number)));
    const dimensions = (Array.isArray(dna.dimensions) ? dna.dimensions : [])
      .filter((dimension) => learningModeIds.has(dimension?.mode_id))
      .map((dimension) => ({ id: dimension.mode_id, state: ['secure', 'developing', 'needs_practice', 'not_observed'].includes(dimension.state) ? dimension.state : 'not_observed', score: Math.max(0, Math.min(100, Number(dimension.score) || 0)), evidence_count: (dimension.evidence_question_ids || []).filter((item) => ids.has(String(item))).length, evidence_question_ids: (dimension.evidence_question_ids || []).map(String).filter((item) => ids.has(item)).slice(0, 5) }));
    if (!dimensions.length) return fallback;
    const marks = marksByQuestion(questions);
    return {
      subject: guardSubjectClaims({
        overall_insights: text(subject.overall_insights, 1200) || fallback.subject.overall_insights,
        strengths: textList(subject.strengths, fallback.subject.strengths),
        misconceptions: textList(subject.misconceptions, fallback.subject.misconceptions),
        recommendations: normalizeRecommendations(subject.recommendations, fallback.subject.recommendations),
        root_cause: text(subject.root_cause, 1200) || fallback.subject.root_cause,
        learning_profile: {
          core_strength: text(subject.learning_profile?.core_strength, 1200) || fallback.subject.learning_profile.core_strength,
          pattern_recognition: text(subject.learning_profile?.pattern_recognition, 1200) || fallback.subject.learning_profile.pattern_recognition,
          root_cause_analysis: text(subject.learning_profile?.root_cause_analysis, 1200) || fallback.subject.learning_profile.root_cause_analysis,
          strategies: normalizeStrategies(subject.learning_profile?.strategies, fallback.subject.learning_profile.strategies),
        },
      }, fallback.subject, marks),
      learnerDna: {
        ...fallback.learnerDna,
        primary_mode: learningModeIds.has(dna.primary_mode?.mode_id) ? { mode_id: dna.primary_mode.mode_id, description: text(dna.primary_mode.description, 1200), evidence: text(dna.primary_mode.evidence, 1000) } : fallback.learnerDna.primary_mode,
        growth_edge: learningModeIds.has(dna.growth_edge?.mode_id) ? { mode_id: dna.growth_edge.mode_id, action: text(dna.growth_edge.action, 1200), evidence: text(dna.growth_edge.evidence, 1000) } : fallback.learnerDna.growth_edge,
        dimensions: scoreDimensionsFromMarks(dimensions, marks),
        next_move: { title: text(dna.next_move?.title, 500) || fallback.learnerDna.next_move.title, action: text(dna.next_move?.action, 1200) || fallback.learnerDna.next_move.action },
      },
      model: result.model,
    };
  } catch (error) {
    // A published report must disclose its real generation path in workflow
    // metadata. Do not silently replace a requested model report with generic
    // prose: retry the job and surface the failure to operations instead.
    throw new Error(`Report-module generation failed for ${student.name}: ${String(error.message || error)}`);
  }
}

async function assertWorkerSchema() {
  const migration = await db.execute({ sql: "SELECT 1 FROM schema_migrations WHERE id = '019_processing_job_hardening' LIMIT 1" });
  if (!migration.rows.length) throw new Error('Database migration 019_processing_job_hardening is required before this OCI worker can start.');
  const leaseMigration = await db.execute({ sql: "SELECT 1 FROM schema_migrations WHERE id = '053_worker_lease_reclaim_count' LIMIT 1" });
  if (!leaseMigration.rows.length) throw new Error('Database migration 053_worker_lease_reclaim_count is required before this OCI worker can start.');
  const regradeLeaseMigration = await db.execute({ sql: "SELECT 1 FROM schema_migrations WHERE id = '071_regrade_item_lease' LIMIT 1" });
  if (!regradeLeaseMigration.rows.length) throw new Error('Database migration 071_regrade_item_lease is required before this OCI worker can start.');
  // syncCanonicalSubmission writes submissions.graded_at on every report build.
  const gradedAtMigration = await db.execute({ sql: "SELECT 1 FROM schema_migrations WHERE id = '072_submission_graded_at' LIMIT 1" });
  if (!gradedAtMigration.rows.length) throw new Error('Database migration 072_submission_graded_at is required before this OCI worker can start.');
  // Report builds read exams.released_at to decide whether to notify students.
  const releaseMigration = await db.execute({ sql: "SELECT 1 FROM schema_migrations WHERE id = '089_exam_release' LIMIT 1" });
  if (!releaseMigration.rows.length) throw new Error('Database migration 089_exam_release is required before this OCI worker can start.');
  const tables = await db.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('processing_jobs', 'worker_heartbeats', 'regrade_runs')");
  if (tables.rows.length !== 3) throw new Error('Canonical worker tables are missing. Apply the documented database migrations before starting OCI.');
}

async function claimNextCohortRegrade() {
  const leaseExpiredAt = new Date(Date.now() - regradeLeaseMs).toISOString();
  await db.execute({
    sql: `UPDATE regrade_runs
          SET status = 'queued', worker_id = NULL
          WHERE status = 'running' AND (heartbeat_at IS NULL OR heartbeat_at < ?)`,
    args: [leaseExpiredAt],
  });
  // Keep claiming the run already leased by this worker. A run remains
  // `running` between question-level model calls, so selecting only `queued`
  // rows would make a healthy worker wait for its own lease to expire before
  // it could process the next question.
  const candidate = await db.execute({
    sql: `SELECT id FROM regrade_runs
          WHERE status = 'queued' OR (status = 'running' AND worker_id = ?)
          ORDER BY requested_at LIMIT 1`,
    args: [workerId],
  });
  const runId = candidate.rows[0]?.id;
  if (!runId) return null;
  const claimedAt = now();
  await db.execute({
    sql: `UPDATE regrade_runs
          SET status = 'running', started_at = COALESCE(started_at, ?), worker_id = ?, heartbeat_at = ?, attempt_count = COALESCE(attempt_count, 0) + 1, error = NULL
          WHERE id = ? AND (status = 'queued' OR (status = 'running' AND worker_id = ?))`,
    args: [claimedAt, workerId, claimedAt, runId, workerId],
  });
  const run = await loadCohortRun(db, runId);
  return run?.status === 'running' && run.worker_id === workerId ? run : null;
}

async function processCohortRegrade() {
  const run = await claimNextCohortRegrade();
  if (!run) return false;
  const scope = JSON.parse(run.scope || '{}');
  console.log(JSON.stringify({ event: 'cohort_regrade_claimed', runId: run.id, testId: scope.test_id }));
  try {
    const result = await runWithInferenceContext({ jobId: run.id, jobType: 'cohort_regrade', school: scope.school || '', schoolId: await inferenceSchoolId(scope.school), testId: scope.test_id || null }, () => processCohortRegradeStep(db, { username: 'oci_worker', role: 'skyll_admin', school: scope.school || '' }, run));
    await db.execute({ sql: 'UPDATE regrade_runs SET heartbeat_at = ? WHERE id = ?', args: [now(), run.id] });
    console.log(JSON.stringify({ event: 'cohort_regrade_step_completed', runId: run.id, status: result.run.status }));
  } catch (error) {
    await db.execute({ sql: "UPDATE regrade_runs SET status = 'failed', completed_at = ?, error = ?, heartbeat_at = ? WHERE id = ?", args: [now(), String(error?.message || error), now(), run.id] });
    console.error(JSON.stringify({ event: 'cohort_regrade_failed', runId: run.id, error: String(error?.message || error) }));
  }
  return true;
}

async function startStep(jobId, step, detail) {
  const row = await db.execute({ sql: 'SELECT progress_json FROM processing_jobs WHERE id = ?', args: [jobId] });
  const progress = JSON.parse(row.rows[0]?.progress_json || '{}');
  const steps = progress.steps || {};
  steps[step] = { status: 'running', detail, started_at: now(), completed_at: null };
  await db.execute({ sql: 'UPDATE processing_jobs SET progress_json = ? WHERE id = ?', args: [JSON.stringify({ ...progress, steps }), jobId] });
}

async function completeStep(jobId, step, detail) {
  const row = await db.execute({ sql: 'SELECT progress_json FROM processing_jobs WHERE id = ?', args: [jobId] });
  const progress = JSON.parse(row.rows[0]?.progress_json || '{}');
  const steps = progress.steps || {};
  steps[step] = { ...(steps[step] || {}), status: 'succeeded', detail, completed_at: now() };
  await db.execute({ sql: 'UPDATE processing_jobs SET progress_json = ? WHERE id = ?', args: [JSON.stringify({ ...progress, steps }), jobId] });
}

async function failStep(jobId, step, detail) {
  const row = await db.execute({ sql: 'SELECT progress_json FROM processing_jobs WHERE id = ?', args: [jobId] });
  const progress = JSON.parse(row.rows[0]?.progress_json || '{}');
  const steps = progress.steps || {};
  steps[step] = { ...(steps[step] || {}), status: 'failed', detail, completed_at: now() };
  await db.execute({ sql: 'UPDATE processing_jobs SET progress_json = ? WHERE id = ?', args: [JSON.stringify({ ...progress, steps }), jobId] });
}

async function updateStepDetail(jobId, step, detail) {
  const row = await db.execute({ sql: 'SELECT progress_json FROM processing_jobs WHERE id = ?', args: [jobId] });
  const progress = JSON.parse(row.rows[0]?.progress_json || '{}');
  const steps = progress.steps || {};
  if (steps[step]) { steps[step].detail = detail; }
  await db.execute({ sql: 'UPDATE processing_jobs SET progress_json = ? WHERE id = ?', args: [JSON.stringify({ ...progress, steps }), jobId] });
}

async function recordWorkerHeartbeat(activeJob = null, force = false) {
  const current = Date.now();
  if (!force && current - lastWorkerHeartbeatAt < workerHeartbeatMs) return;
  lastWorkerHeartbeatAt = current;
  const seenAt = now();
  const serviceName = `skyll-worker@${workerInstance}`;
  await db.execute({
    sql: `INSERT INTO worker_heartbeats (worker_id, service, version, status, active_job_id, details_json, last_seen_at, started_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(worker_id) DO UPDATE SET status=excluded.status, active_job_id=excluded.active_job_id,
            details_json=excluded.details_json, last_seen_at=excluded.last_seen_at, version=excluded.version`,
    args: [workerId, serviceName, workerVersion, stopping ? 'stopping' : 'healthy', activeJob?.id || null, JSON.stringify({ activeJobType: activeJob?.type || null, pollIntervalMs, jobLeaseMs, maxJobAttempts }), seenAt, workerStartedAt],
  });
}

async function heartbeatJob(job, progress = null) {
  const seenAt = now();
  await db.execute({
    sql: `UPDATE processing_jobs
          SET heartbeat_at = ?, lease_expires_at = ?,
            progress_json = json_set(COALESCE(progress_json, '{}'), '$.phase', ?, '$.updatedAt', ?)
          WHERE id = ? AND status = 'running' AND worker_id = ?`,
    args: [seenAt, leaseExpiresAt({ leaseMs: jobLeaseMs }), progress || job.type, seenAt, job.id, workerId],
  });
  await recordWorkerHeartbeat(job);
}

async function extendJobLease(job) {
  const result = await db.execute(extendLeaseStatement({ jobId: job.id, workerId, at: now(), leaseExpiresAt: leaseExpiresAt({ leaseMs: jobLeaseMs }) }));
  if (!result.rowsAffected) console.warn(JSON.stringify({ event: 'job_lease_lost', jobId: job.id }));
  await recordWorkerHeartbeat(job);
}

async function releaseJobOnShutdown(job) {
  const at = now();
  const ops = [releaseOnShutdownStatement({ jobId: job.id, workerId, at })];
  if (!hiveSideJobTypes.has(job.type)) {
    // Only move the test back to queued if this worker actually released the job.
    ops.push({
      sql: `UPDATE tests SET status = ?, updated_at = ? WHERE id = ?
              AND EXISTS (SELECT 1 FROM processing_jobs WHERE id = ? AND status = 'queued' AND json_extract(progress_json, '$.phase') = 'released_on_shutdown')`,
      args: [retryTestStatus[job.type] || 'processing_queued', at, job.test_id, job.id],
    });
  }
  await db.batch(ops, 'write');
}

async function reclaimExpiredJobs() {
  const expiredBefore = now();
  const stranded = await db.execute({
    sql: `SELECT id, type, test_id, attempt_count, lease_reclaim_count FROM processing_jobs
          WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?
          ORDER BY lease_expires_at ASC LIMIT 50`,
    args: [expiredBefore],
  });
  for (const row of stranded.rows) {
    // Reclaims are counted separately from retry attempts (FLKRM-157). A slow but
    // healthy job that outlives its lease must not burn the retry budget that is
    // reserved for real failures, so the stuck-job safety valve keys off
    // lease_reclaim_count rather than attempt_count.
    const { reclaims, exhausted } = reclaimDecision({ leaseReclaimCount: row.lease_reclaim_count, maxReclaims: maxJobAttempts });
    const nextAttemptAt = exhausted ? null : retryAt(reclaims, { baseMs: retryBaseMs, maxMs: retryMaxMs });
    await db.execute({
      sql: `UPDATE processing_jobs
            SET status = ?, worker_id = NULL, heartbeat_at = NULL, lease_expires_at = NULL,
              lease_reclaim_count = ?,
              next_attempt_at = ?, completed_at = CASE WHEN ? THEN ? ELSE NULL END,
              last_error_code = CASE WHEN ? THEN 'worker_lease_expired' ELSE NULL END,
              error = CASE WHEN ? THEN 'Worker lease expired after maximum reclaims.' ELSE 'Worker lease expired; retry scheduled.' END,
              progress_json = json_set(COALESCE(progress_json, '{}'), '$.phase', 'reclaimed', '$.is_reclaim', 1, '$.reclaim_count', ?, '$.updatedAt', ?)
            WHERE id = ? AND status = 'running' AND lease_expires_at < ? AND lease_reclaim_count = ?`,
      args: [exhausted ? 'failed_retryable' : 'queued', reclaims, nextAttemptAt, exhausted ? 1 : 0, expiredBefore, exhausted ? 1 : 0, exhausted ? 1 : 0, reclaims, expiredBefore, row.id, expiredBefore, Number(row.lease_reclaim_count || 0)],
    });
    if (exhausted) {
      if (!hiveSideJobTypes.has(row.type)) {
        await db.execute({
          sql: `UPDATE tests SET status = ?, updated_at = ?
                WHERE id = ? AND EXISTS (SELECT 1 FROM processing_jobs WHERE id = ? AND status = 'failed_retryable')`,
          args: [failedTestStatus[row.type] || 'processing_failed', expiredBefore, row.test_id, row.id],
        }).catch((error) => console.warn(JSON.stringify({ event: 'test_status_update_failed', jobId: row.id, error: String(error?.message || error) })));
      }
      console.warn(JSON.stringify({ event: 'job_lease_exhausted', jobId: row.id, type: row.type, reclaimCount: reclaims, nextAttemptAt }));
      alerts.send('job_lease_exhausted', { jobId: row.id, type: row.type, testId: row.test_id, reclaimCount: reclaims }).catch(() => {});
    } else {
      console.warn(JSON.stringify({ event: 'job_lease_reclaimed', jobId: row.id, reclaimCount: reclaims, attemptCount: Number(row.attempt_count || 0), nextAttemptAt }));
    }
  }
  return stranded.rows.length;
}

async function claimNextJob() {
  const claimAt = now();
  const schoolClause = processingSchool ? ' AND school = ?' : '';
  const testClause = processingTestId ? ' AND test_id = ?' : '';
  const typeClause = processingJobTypes.length ? ` AND type IN (${processingJobTypes.map(() => '?').join(', ')})` : '';
  const candidateArgs = [claimAt];
  if (processingSchool) candidateArgs.push(processingSchool);
  if (processingTestId) candidateArgs.push(processingTestId);
  candidateArgs.push(...processingJobTypes);
  const candidate = await db.execute({
    sql: `SELECT id FROM processing_jobs
          WHERE status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
            AND type IN ('mistral_ocr', 'build_rubric', 'materialize_evidence', 'visual_rescue', 'grade_submission', 'build_reports', 'deep_signal_extraction', 'hive_synthesis', 'mastery_estimation')${schoolClause}${testClause}${typeClause}
          ORDER BY requested_at ASC LIMIT 1`,
    args: candidateArgs,
  });
  const jobId = candidate.rows[0]?.id;
  if (!jobId) return null;
  await db.execute(claimJobStatement({ jobId, workerId, at: claimAt, leaseExpiresAt: leaseExpiresAt({ leaseMs: jobLeaseMs }) }));
  const claimed = await db.execute({ sql: 'SELECT * FROM processing_jobs WHERE id = ?', args: [jobId] });
  const job = claimed.rows[0];
  if (!job || job.status !== 'running' || job.worker_id !== workerId) return null;
  // Side jobs must not regress a finished assessment's lifecycle status.
  // Background answer-sheet OCR (after QP+key already built a rubric) must
  // also leave rubric_ready_for_review / grading statuses alone.
  if (!hiveSideJobTypes.has(job.type)) {
    const testStatus = { mistral_ocr: 'ocr_processing', build_rubric: 'rubric_processing', materialize_evidence: 'evidence_processing', visual_rescue: 'visual_rescue_processing', grade_submission: 'grading_processing', build_reports: 'report_processing' }[job.type] || 'processing';
    if (job.type === 'mistral_ocr') {
      await db.execute({
        sql: `UPDATE tests SET status = ?, updated_at = ?
              WHERE id = ? AND status IN ('uploading', 'ocr_queued', 'ocr_processing', 'ocr_succeeded')`,
        args: [testStatus, claimAt, job.test_id],
      });
    } else {
      await db.execute({ sql: 'UPDATE tests SET status = ?, updated_at = ? WHERE id = ?', args: [testStatus, claimAt, job.test_id] });
    }
  }
  return job;
}

async function assetsForOcr(testId) {
  const result = await db.execute({
    sql: `SELECT a.id, a.kind, a.mime_type, a.storage_key, a.checksum, a.byte_size, ts.student_name
          FROM file_assets a
          LEFT JOIN test_students ts ON ts.id = a.test_student_id
          WHERE a.test_id = ? AND a.status = 'uploaded'
          ORDER BY CASE a.kind WHEN 'question_paper' THEN 0 WHEN 'answer_key' THEN 1 ELSE 2 END, a.created_at`,
    args: [testId],
  });
  return result.rows.map((asset) => ({
    id: asset.id,
    kind: asset.kind,
    student: asset.student_name || null,
    mimeType: asset.mime_type || 'application/octet-stream',
    checksum: asset.checksum || null,
    byteSize: Number(asset.byte_size || 0),
    documentType: /^image\/(png|jpe?g|avif|webp)$/i.test(String(asset.mime_type || '')) ? 'image_url' : 'document_url',
    storageKey: asset.storage_key,
  }));
}

// Presign at use time. A 199-sheet Datalab run takes longer than any sane
// URL lifetime, and URLs minted up front expired mid-run (403 on every
// remaining answer sheet, silently skipped as "optional").
function freshDownloadUrl(asset, expiresIn = 900) {
  return createDownloadUrl({ key: asset.storageKey || asset.storage_key, expiresIn });
}

async function callMistral(asset) {
  const response = await fetch('https://api.mistral.ai/v1/ocr', {
    method: 'POST', headers: { authorization: `Bearer ${process.env.MISTRAL_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: process.env.MISTRAL_OCR_MODEL || 'mistral-ocr-latest', document: documentForAsset({ ...asset, downloadUrl: freshDownloadUrl(asset) }), include_image_base64: false, include_blocks: true, confidence_scores_granularity: 'page', table_format: 'html' }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.message || payload?.error?.message || `Mistral OCR failed (${response.status})`);
    error.retryable = isRetryableMistralStatus(response.status); throw error;
  }
  return normalizeOcrResult(payload);
}

async function downloadAssetBytes(asset) {
  const response = await fetch(freshDownloadUrl(asset));
  if (!response.ok) {
    const error = new Error(`Failed to download OCR source (${response.status})`);
    // 403 on a freshly signed URL for an uploaded asset is a transient
    // signing/clock problem far more often than a real permission change.
    error.retryable = response.status === 403 || response.status === 408 || response.status === 429 || response.status >= 500;
    throw error;
  }
  return Buffer.from(await response.arrayBuffer());
}

async function callDatalab(asset) {
  const buffer = await downloadAssetBytes(asset);
  return ocrWithDatalab({
    buffer,
    filename: assetFilename(asset),
    mimeType: asset.mimeType,
    apiKey: process.env.DATALAB_API_KEY,
    mode: process.env.DATALAB_OCR_MODE || 'accurate',
  });
}

async function callNearOcr(asset) {
  return ocrWithNearAi({ buffer: await downloadAssetBytes(asset), mimeType: asset.mimeType });
}

async function runOcrEngine(asset, engine) {
  if (engine === 'near_vl') return callNearOcr(asset);
  return engine === 'mistral' ? callMistral(asset) : callDatalab(asset);
}

async function hasActiveArtifact(asset) {
  if (asset.checksum) {
    const result = await db.execute({ sql: "SELECT id FROM asset_ocr_runs WHERE asset_id = ? AND is_active = 1 AND status = 'succeeded' AND asset_checksum = ? LIMIT 1", args: [asset.id, asset.checksum] });
    return Boolean(result.rows[0]);
  }
  // No checksum — fall back to checking by asset_id alone
  const result = await db.execute({ sql: "SELECT id FROM asset_ocr_runs WHERE asset_id = ? AND is_active = 1 AND status = 'succeeded' LIMIT 1", args: [asset.id] });
  return Boolean(result.rows[0]);
}

async function saveArtifact(jobId, asset, result, { engine = 'mistral', model, active = true } = {}) {
  const resolvedModel = model || result.model || process.env.MISTRAL_OCR_MODEL || 'mistral-ocr-latest';
  const max = await db.execute({ sql: 'SELECT COALESCE(MAX(revision), 0) AS revision FROM asset_ocr_runs WHERE asset_id = ?', args: [asset.id] });
  const completedAt = now();
  const statements = [];
  if (active) statements.push({ sql: 'UPDATE asset_ocr_runs SET is_active = 0 WHERE asset_id = ? AND is_active = 1', args: [asset.id] });
  statements.push({ sql: `INSERT INTO asset_ocr_runs (id, asset_id, job_id, engine, model, revision, asset_checksum, status, markdown, pages_json, page_count, usage_json, created_at, completed_at, is_active)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, args: [id('ocr'), asset.id, jobId, engine, resolvedModel, Number(max.rows[0]?.revision || 0) + 1, asset.checksum || null, 'succeeded', result.markdown, JSON.stringify(result.pages), result.pageCount || result.pages?.length || 0, JSON.stringify(result.usage || {}), completedAt, completedAt, active ? 1 : 0] });
  await db.batch(statements, 'write');
}

// Returns 'active' (a build is queued/running), 'built' (rubric already
// succeeded; nothing queued) or 'queued' (a new build_rubric job was inserted).
async function queueRubric(testId, school, requestedBy) {
  const active = await db.execute({ sql: "SELECT id FROM processing_jobs WHERE test_id = ? AND type = 'build_rubric' AND status IN ('queued', 'running') LIMIT 1", args: [testId] });
  if (active.rows.length) return 'active';
  const alreadyBuilt = await db.execute({ sql: "SELECT id FROM processing_jobs WHERE test_id = ? AND type = 'build_rubric' AND status = 'succeeded' LIMIT 1", args: [testId] });
  if (alreadyBuilt.rows.length) return 'built';
  const requestedAt = now(); const jobId = id('job');
  await db.batch([
    { sql: 'INSERT INTO processing_jobs (id, test_id, school, type, status, payload_json, requested_by, requested_at, progress_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', args: [jobId, testId, school, 'build_rubric', 'queued', JSON.stringify({ source: 'ocr_complete' }), requestedBy || 'oci_worker', requestedAt, JSON.stringify({ steps: { parse_key: { status: 'queued', detail: 'Awaiting OCI rubric worker' } } })] },
    { sql: "UPDATE tests SET status = 'rubric_queued', updated_at = ? WHERE id = ?", args: [requestedAt, testId] },
  ], 'write');
  return 'queued';
}

async function queueJob({ testId, school, type, payload, requestedBy, step, detail }) {
  // Per-question / per-submission / per-student work must fan out. Test-level stages remain deduplicated.
  // Targeted materialize_evidence retries (payload.studentIds) must also fan out — otherwise a retry
  // queued while the parent job is still running is deduped to the parent and never inserted.
  const targetedEvidenceRetry = type === 'materialize_evidence'
    && Array.isArray(payload?.studentIds)
    && payload.studentIds.length > 0;
  if (targetedEvidenceRetry) {
    const active = await db.execute({
      sql: "SELECT id, payload_json FROM processing_jobs WHERE test_id = ? AND type = ? AND status IN ('queued', 'running')",
      args: [testId, type],
    });
    const want = [...payload.studentIds].map(String).sort().join(',');
    const same = active.rows.find((row) => {
      const parsed = parseJson(row.payload_json);
      if (!Array.isArray(parsed.studentIds) || !parsed.studentIds.length) return false;
      return [...parsed.studentIds].map(String).sort().join(',') === want
        && Number(parsed.retryCount || 0) === Number(payload.retryCount || 0);
    });
    if (same) return same.id;
  } else if (!['visual_rescue', 'grade_submission', 'deep_signal_extraction', 'hive_synthesis', 'mastery_estimation'].includes(type)) {
    const active = await db.execute({ sql: "SELECT id FROM processing_jobs WHERE test_id = ? AND type = ? AND status IN ('queued', 'running') LIMIT 1", args: [testId, type] });
    if (active.rows.length) return active.rows[0].id;
  } else if (type === 'deep_signal_extraction') {
    const active = await db.execute({ sql: "SELECT id, payload_json FROM processing_jobs WHERE test_id = ? AND type = ? AND status IN ('queued', 'running')", args: [testId, type] });
    const sameSubmission = active.rows.find((row) => parseJson(row.payload_json).submissionId === payload?.submissionId);
    if (sameSubmission) return sameSubmission.id;
  } else if (type === 'hive_synthesis') {
    const active = await db.execute({ sql: "SELECT id, payload_json FROM processing_jobs WHERE type = ? AND status IN ('queued', 'running')", args: [type] });
    const sameStudent = active.rows.find((row) => parseJson(row.payload_json).studentId === payload?.studentId);
    if (sameStudent) return sameStudent.id;
  } else if (type === 'mastery_estimation') {
    const active = await db.execute({ sql: "SELECT id, payload_json FROM processing_jobs WHERE type = ? AND status IN ('queued', 'running')", args: [type] });
    const sameStudent = active.rows.find((row) => parseJson(row.payload_json).studentId === payload?.studentId);
    if (sameStudent) return sameStudent.id;
  } else {
    const active = await db.execute({ sql: "SELECT id, payload_json FROM processing_jobs WHERE test_id = ? AND type = ? AND status IN ('queued', 'running')", args: [testId, type] });
    if (type === 'grade_submission' && payload?.submissionId && !payload?.submissionQuestionId) {
      const sameSubmission = active.rows.find((row) => {
        const parsed = parseJson(row.payload_json);
        return parsed.submissionId === payload.submissionId && !parsed.submissionQuestionId;
      });
      if (sameSubmission) return sameSubmission.id;
    } else {
      const sameQuestion = active.rows.find((row) => parseJson(row.payload_json).submissionQuestionId === payload?.submissionQuestionId);
      if (sameQuestion) return sameQuestion.id;
    }
  }
  const jobId = id('job'); const requestedAt = now();
  await db.batch([
    { sql: 'INSERT INTO processing_jobs (id, test_id, school, type, status, payload_json, requested_by, requested_at, progress_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', args: [jobId, testId, school, type, 'queued', JSON.stringify(payload || {}), requestedBy || 'oci_worker', requestedAt, JSON.stringify({ steps: { [step]: { status: 'queued', detail } } })] },
  ], 'write');
  return jobId;
}

async function isDeepSignalsEnabled(schoolName) {
  const schoolId = await resolveSchoolId(db, schoolName);
  if (!schoolId) return false;
  const result = await db.execute({
    sql: `SELECT enabled FROM school_feature_flags
          WHERE school_id = ? AND feature_key = 'deep_signals' LIMIT 1`,
    args: [schoolId],
  }).catch(() => ({ rows: [] }));
  return Number(result.rows[0]?.enabled) === 1;
}

async function activeRubric(testId) {
  const result = await db.execute({ sql: "SELECT * FROM exam_rubric_versions WHERE test_id = ? AND is_active = 1 AND status = 'succeeded' ORDER BY version DESC LIMIT 1", args: [testId] });
  const row = result.rows[0];
  if (!row) throw new Error('An active marking rubric is required.');
  const rubric = parseJson(row.question_map_json, null);
  if (!rubric?.questions?.length) throw new Error('The active marking rubric has no questions.');
  return { row, rubric };
}

// normalizeEvidenceAnswers + evidenceOutcome now live in ./evidenceAnswers.js
// (extracted for unit-testability; see FLKRM-152).

async function findSubmission(testId, studentId) {
  const existing = await db.execute({ sql: 'SELECT * FROM test_submissions WHERE test_id = ? AND student_id = ?', args: [testId, studentId] });
  return existing.rows[0] || null;
}

function isMcqResponseType(value) {
  return String(value || '').toLowerCase() === 'mcq';
}


async function reconcileEvidenceGradeJobs(testId, school, requestedBy) {
  const pending = await db.execute({
    sql: `SELECT question.id, question.submission_id, question.rubric_json, question.student_name, question.payload_json
          FROM submission_questions question
          JOIN test_submissions submission ON submission.id = question.submission_id
          WHERE submission.test_id = ? AND question.status = 'evidence_ready'`,
    args: [testId],
  });
  // Questions with a visual rescue still in flight, or whose rescue produced
  // nothing usable, stay evidence_ready on purpose so a reviewer can resolve
  // them. Grading them here would score placeholder OCR text.
  const visualPending = await db.execute({
    sql: `SELECT payload_json FROM processing_jobs
          WHERE test_id = ? AND type = 'visual_rescue' AND status IN ('queued', 'running')`,
    args: [testId],
  });
  const visualHeld = new Set(visualPending.rows.map((row) => parseJson(row.payload_json, {}).submissionQuestionId).filter(Boolean));
  const gradable = pending.rows.filter((question) => {
    if (visualHeld.has(question.id)) return false;
    const tags = parseJson(question.payload_json, {}).reviewTags;
    return !(Array.isArray(tags) && tags.includes('visual_evidence_unverified'));
  });
  const held = pending.rows.length - gradable.length;
  if (held) console.log(JSON.stringify({ event: 'reconcile_held_visual_questions', testId, held }));
  const bySubmission = new Map();
  for (const question of gradable) {
    const list = bySubmission.get(question.submission_id) || [];
    list.push(question);
    bySubmission.set(question.submission_id, list);
  }
  for (const [submissionId, questions] of bySubmission) {
    const allMcq = questions.every((question) => isMcqResponseType(parseJson(question.rubric_json, {}).expected_response_type));
    if (allMcq) {
      await queueJob({
        testId,
        school,
        type: 'grade_submission',
        payload: { submissionId },
        requestedBy,
        step: 'grade',
        detail: `Awaiting batch MCQ grading for ${questions[0]?.student_name || submissionId}`,
      });
    } else {
      for (const question of questions) {
        await queueJob({ testId, school, type: 'grade_submission', payload: { submissionQuestionId: question.id }, requestedBy, step: 'grade', detail: 'Awaiting per-question grading for reconciled evidence' });
      }
    }
  }
  return gradable.length;
}

// Questions that still hold build_reports back. Terminal statuses such as
// evidence_blocked and regraded no longer count (see reportReadiness.js);
// a single blocked MCQ used to park a test at grading_processing forever.
async function ungradedQuestionCount(testId) {
  const result = await db.execute(reportBlockingCountStatement(testId));
  return Number(result.rows[0]?.count || 0);
}

async function queueReportsWhenComplete(job) {
  await reconcileEvidenceGradeJobs(job.test_id, job.school, job.requested_by);
  const [outstanding, ungraded] = await Promise.all([
    db.execute({ sql: "SELECT id FROM processing_jobs WHERE test_id = ? AND type IN ('visual_rescue', 'grade_submission') AND status IN ('queued', 'running') LIMIT 1", args: [job.test_id] }),
    ungradedQuestionCount(job.test_id),
  ]);
  if (!outstanding.rows.length && ungraded === 0) {
    await queueJob({ testId: job.test_id, school: job.school, type: 'build_reports', payload: {}, requestedBy: job.requested_by, step: 'build_reports', detail: 'Awaiting first-pass student and cohort report materialization' });
  }
}

async function hasCompleteEvidence(testId, studentId, questionCount) {
  const result = await db.execute({
    sql: `SELECT COUNT(*) AS count
          FROM submission_questions question
          JOIN test_submissions submission ON submission.id = question.submission_id
          WHERE submission.test_id = ? AND submission.student_id = ?
            AND question.status IN ('evidence_ready', 'evidence_blocked', 'graded', 'ready_for_review')`,
    args: [testId, studentId],
  });
  return Number(result.rows[0]?.count || 0) >= questionCount;
}

async function processEvidence(job) {
  await startStep(job.id, 'evidence', 'Aligning each student answer sheet to the canonical question map');
  const jobPayload = parseJson(job.payload_json, {});
  const force = jobPayload.force === true;
  const requestedStudentIds = new Set(Array.isArray(jobPayload.studentIds)
    ? jobPayload.studentIds.map((value) => String(value || '').trim()).filter(Boolean)
    : []);
  const { rubric } = await activeRubric(job.test_id);
  const testMetaResult = await db.execute({ sql: 'SELECT subject, grade FROM tests WHERE id = ?', args: [job.test_id] });
  const testMeta = testMetaResult.rows[0] || {};
  const students = await db.execute({ sql: `SELECT ts.id AS test_student_id, ts.student_id, ts.student_name, ts.batch_id,
      a.id AS asset_id, a.storage_key, o.id AS ocr_run_id, o.engine, o.model, o.markdown, o.pages_json, o.is_active
      FROM test_students ts JOIN file_assets a ON a.test_student_id = ts.id
      JOIN asset_ocr_runs o ON o.asset_id = a.id AND o.status = 'succeeded'
      WHERE ts.test_id = ? AND a.kind = 'answer_sheet' AND a.status = 'uploaded'
      ORDER BY ts.student_name, a.created_at, o.is_active DESC`, args: [job.test_id] });
  const grouped = new Map();
  for (const row of students.rows) {
    if (!grouped.has(row.test_student_id)) grouped.set(row.test_student_id, { ...row, assets: [] });
    grouped.get(row.test_student_id).assets.push(row);
  }
  for (const student of grouped.values()) student.assets = sortAnswerSheetRows(student.assets);
  if (!grouped.size) throw new Error('No OCR-complete student answer sheets are available.');
  console.log(JSON.stringify({ event: 'evidence_students_loaded', students: grouped.size, rows: students.rows.length }));

  // ─── Supervisor setup ───────────────────────────────────────────────────────
  const supervisor = new EvidenceSupervisor(rubric.questions);
  const classification = supervisor.classification;
  const chunks = supervisor.chunks;
  // Issue FLKRM-156: math/physics papers must use marker-based extraction (never
  // keyword-only), and their question markers must be preserved through OCR cleaning.
  const subject = testMeta.subject || '';
  const useMarkers = shouldUseMarkers(rubric.questions, subject);
  console.log(JSON.stringify({ event: 'evidence_pipeline_init', classification, subject, useMarkers, chunks: chunks.map((c) => ({ label: c.label, questions: c.questions.length })) }));

  let completed = 0;
  const failedStudentIds = [];
  const blockedStudentIds = [];
  // Subset of blocked students whose block traces to a presence shortfall
  // (truncation / chunk drop) — only these are eligible for a re-extraction retry.
  const retryEligibleBlockedStudents = [];
  for (const student of grouped.values()) {
    if (requestedStudentIds.size && !requestedStudentIds.has(String(student.student_id))) continue;
    const evidenceIndex = completed + failedStudentIds.length;
    await heartbeatJob(job, `materialize_evidence:${evidenceIndex + 1}/${grouped.size}`);
    if (!force && await hasCompleteEvidence(job.test_id, student.student_id, rubric.questions.length)) {
      completed += 1;
      await updateStepDetail(job.id, 'evidence', `Question evidence materialized for ${completed}/${grouped.size} student(s)`);
      continue;
    }

    try {
      const extracted = await extractStudentAnswers({
        assets: student.assets,
        rubric,
        subject,
        supervisor,
        callJson: callReasoningJson,
        loadSheetPages: () => loadAnswerSheetPageTexts(db, job.test_id, student.test_student_id),
        studentName: student.student_name,
        studentId: student.student_id,
      });
      const { answers, ocrIncomplete, duplicateOf, studentHadPresenceGap, paperIsAllMcq, duplicatePageAssetIds } = extracted;
      let submission = await findSubmission(job.test_id, student.student_id);
      const timestamp = now();
      if (!submission) {
        submission = { id: id('submission') };
        await db.execute({ sql: `INSERT INTO test_submissions (id, test_id, student_id, batch_id, status, review_status, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'evidence_ready', 'pending', ?, ?)`, args: [submission.id, job.test_id, student.student_id, student.batch_id || null, timestamp, timestamp] });
        await syncCanonicalSubmission(db, submission.id, timestamp).catch((error) => logMirrorFailure('submission', error));
      }
      let queuedBatchGrade = false;
      let studentHasBlocked = false;
      for (const answer of answers) {
        const question = answer.question;
        // A low-confidence blank is not evidence that a student left the question blank.
        // Hold it for evidence repair/review rather than silently turning it into zero.
        const outcome = evidenceOutcome(answer, { ocrIncomplete });
        const evidenceBlocked = outcome.blocked;
        const evidence = { schema_version: 1, duplicate_of: duplicateOf.get(question.number) || undefined, duplicate_page_asset_ids: duplicatePageAssetIds.length ? duplicatePageAssetIds : undefined, ocr_run_ids: student.assets.map((asset) => asset.ocr_run_id), source_pages: answer.sourcePages, student_answer: answer.studentAnswer, final_answer: answer.finalAnswer, crossed_out_work: answer.crossedOutWork, extraction_confidence: answer.confidence, needs_visual_rescue: answer.needsVisualRescue, visual_reason: answer.visualReason };
        const payload = { testId: job.test_id, school: job.school, subject: testMeta.subject || '', studentId: student.student_id, studentName: student.student_name, gradeLevel: testMeta.grade || '', questionNumber: question.number, questionText: question.question_text, correctAnswer: question.correct_answer_summary, markingRubric: question.marking_rubric, marksAllocated: question.marks_allocated, studentAnswer: { attempted: answer.attempted, studentWrote: answer.studentAnswer, finalAnswer: answer.finalAnswer, crossedOutWork: answer.crossedOutWork, confidence: answer.confidence, sourcePages: answer.sourcePages }, grade: { marks: 0, allocated: question.marks_allocated, status: evidenceBlocked ? 'evidence_blocked' : answer.attempted ? 'pending' : 'not_attempted', confidence: answer.confidence }, gradeRationale: {}, isFlagged: outcome.flagged, reviewPriority: outcome.flagged ? 'flagged' : 'normal', reviewTags: evidenceBlocked ? (ocrIncomplete ? ['evidence_capture_incomplete', 'ocr_input_truncated'] : ['evidence_capture_incomplete']) : answer.needsVisualRescue ? ['visual_evidence_required'] : answer.confidence === 'low' ? ['low_extraction_confidence'] : [], question: { question_text: question.question_text, correct_answer: question.correct_answer_summary, marking_rubric: question.marking_rubric, marks_total: question.marks_allocated, status: evidenceBlocked ? 'evidence_blocked' : 'pending' } };
        const existing = await db.execute({ sql: 'SELECT id, review_revision, status FROM submission_questions WHERE submission_id = ? AND question_id = ?', args: [submission.id, question.id] });
        const questionId = existing.rows[0]?.id || id('submission_question');
        const storedRubric = { ...question, scoring_plan: rubric.exam?.scoring_plan || { groups: [] } };
        if (!existing.rows.length) await db.execute({ sql: `INSERT INTO submission_questions (id, submission_id, question_id, question_number, question_text, answer_key_text, rubric_json, evidence_json, source_asset_ids_json, ai_marks, approved_marks, marks_total, status, created_at, updated_at, school, subject, student_name, payload_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`, args: [questionId, submission.id, question.id, question.number, question.question_text, question.correct_answer_summary, JSON.stringify(storedRubric), JSON.stringify(evidence), JSON.stringify(student.assets.map((asset) => asset.asset_id)), question.marks_allocated, evidenceBlocked ? 'evidence_blocked' : 'evidence_ready', timestamp, timestamp, job.school, testMeta.subject || '', student.student_name, JSON.stringify(payload)] });
        else if (!Number(existing.rows[0].review_revision || 0) && (force || !['graded', 'ready_for_review'].includes(existing.rows[0].status))) {
          // The DB trigger `submission_questions_prevent_grade_downgrade` silently ignores
          // updates that transition status from 'graded'/'ready_for_review' → 'evidence_ready'.
          // When force-updating an already-graded row, preserve its status to bypass the trigger.
          const newStatus = (force && ['graded', 'ready_for_review'].includes(existing.rows[0].status))
            ? existing.rows[0].status
            : (evidenceBlocked ? 'evidence_blocked' : 'evidence_ready');
          await db.execute({ sql: `UPDATE submission_questions SET question_text = ?, answer_key_text = ?, rubric_json = ?, evidence_json = ?, source_asset_ids_json = ?, ai_marks = NULL, approved_marks = NULL, marks_total = ?, status = ?, payload_json = ?, updated_at = ? WHERE id = ?`, args: [question.question_text, question.correct_answer_summary, JSON.stringify(storedRubric), JSON.stringify(evidence), JSON.stringify(student.assets.map((asset) => asset.asset_id)), question.marks_allocated, newStatus, JSON.stringify(payload), timestamp, questionId] });
        }
        await db.execute({ sql: `INSERT INTO review_decisions (submission_question_id, state, revision, updated_at) VALUES (?, 'pending', 0, ?) ON CONFLICT(submission_question_id) DO NOTHING`, args: [questionId, timestamp] });
        await syncV2Question(db, questionId, timestamp).catch((error) => logMirrorFailure('v2_question', error));
        await syncQuestionReview(db, questionId, timestamp).catch((error) => logMirrorFailure('question_review', error));
        if (evidenceBlocked) { studentHasBlocked = true; continue; }
        if (answer.needsVisualRescue) {
          await queueJob({ testId: job.test_id, school: job.school, type: 'visual_rescue', payload: { submissionQuestionId: questionId, skipReportQueue: force }, requestedBy: job.requested_by, step: 'visual_rescue', detail: `Visual evidence required for ${student.student_name} ${question.number}` });
          continue;
        }
        if (paperIsAllMcq) {
          if (!queuedBatchGrade) {
            await queueJob({
              testId: job.test_id,
              school: job.school,
              type: 'grade_submission',
              payload: { submissionId: submission.id, skipReportQueue: force, includeNullMarks: force },
              requestedBy: job.requested_by,
              step: 'grade',
              detail: `Awaiting batch MCQ grading for ${student.student_name}`,
            });
            queuedBatchGrade = true;
          }
        } else {
          await queueJob({ testId: job.test_id, school: job.school, type: 'grade_submission', payload: { submissionQuestionId: questionId, skipReportQueue: force }, requestedBy: job.requested_by, step: 'grade', detail: `Awaiting per-question grading for ${student.student_name} ${question.number}` });
        }
      }
      if (studentHasBlocked) blockedStudentIds.push(String(student.student_id));
      // A blocked student is only retried when the block traces to a presence
      // shortfall (truncation / chunk drop) that a re-extract can recover.
      // Genuine low-confidence blanks/skips are NOT re-extracted (FLKRM-152
      // review #2) — retrying them would re-run the whole script to no avail.
      if (studentHasBlocked && studentHadPresenceGap) retryEligibleBlockedStudents.push(String(student.student_id));
      completed += 1;
      await updateStepDetail(job.id, 'evidence', `Question evidence materialized for ${completed}/${grouped.size} student(s)`);
    } catch (error) {
      // One bad JSON parse must not abort the whole exam — skip and retry later.
      if (/Supervisor halted/i.test(String(error?.message || error))) throw error;
      failedStudentIds.push(String(student.student_id));
      console.log(JSON.stringify({
        event: 'evidence_student_failed',
        student: student.student_name,
        studentId: student.student_id,
        error: String(error?.message || error),
      }));
      await updateStepDetail(
        job.id,
        'evidence',
        `Question evidence materialized for ${completed}/${grouped.size} student(s); ${failedStudentIds.length} failed`,
      );
    }
  }
  if (failedStudentIds.length && completed === 0 && !requestedStudentIds.size) {
    throw new Error(`Evidence extraction failed for all remaining students (e.g. ${failedStudentIds.slice(0, 3).join(', ')})`);
  }
  const evidenceRetryCount = Number(jobPayload.retryCount || 0);
  let queuedRetry = false;
  // Only failed students and blocked students whose block traces to a presence
  // shortfall (truncation / chunk drop) are re-attempted within the bounded
  // budget. A genuine low-confidence blank/skip is NOT re-extracted — retrying
  // it would re-run the whole script to no avail (FLKRM-152 review #2). A
  // recovered presence-gap question is graded; a still-missing one keeps
  // confidence 'low' -> evidence_blocked -> flagged for review.
  const retryStudentIds = [...new Set([...failedStudentIds, ...retryEligibleBlockedStudents])];
  if (retryStudentIds.length) {
    if (evidenceRetryCount >= 2) {
      console.log(JSON.stringify({
        event: 'evidence_retry_budget_exhausted',
        testId: job.test_id,
        failedStudents: failedStudentIds.length,
        blockedStudents: blockedStudentIds.length,
        retryEligibleBlockedStudents: retryEligibleBlockedStudents.length,
        retryCount: evidenceRetryCount,
        sample: retryStudentIds.slice(0, 5),
      }));
    } else {
      const retryJobId = await queueJob({
        testId: job.test_id,
        school: job.school,
        type: 'materialize_evidence',
        payload: { studentIds: retryStudentIds, retryCount: evidenceRetryCount + 1, force: true },
        requestedBy: job.requested_by,
        step: 'evidence',
        detail: `Retrying evidence for ${retryStudentIds.length} student(s) after partial failure (attempt ${evidenceRetryCount + 1})`,
      });
      queuedRetry = Boolean(retryJobId) && retryJobId !== job.id;
      console.log(JSON.stringify({
        event: 'evidence_retry_queued',
        testId: job.test_id,
        retryJobId,
        parentJobId: job.id,
        queuedRetry,
        failedStudents: failedStudentIds.length,
        blockedStudents: blockedStudentIds.length,
        retryEligibleBlockedStudents: retryEligibleBlockedStudents.length,
        retryCount: evidenceRetryCount + 1,
      }));
    }
  }
  await reconcileEvidenceGradeJobs(job.test_id, job.school, job.requested_by);
  const supervisorReport = supervisor.postRunReport();
  console.log(JSON.stringify({ event: 'evidence_supervisor_report', ...supervisorReport, failedStudents: failedStudentIds.length }));
  const finished = now();
  await db.batch([
    { sql: "UPDATE processing_jobs SET progress_json = json_set(COALESCE(progress_json, '{}'), '$.steps.evidence', json_object('status', 'succeeded', 'detail', ?, 'completed_at', ?)) WHERE id = ?", args: [`Question evidence materialized for ${completed} student(s)${failedStudentIds.length ? (queuedRetry ? `; ${failedStudentIds.length} queued for retry` : `; ${failedStudentIds.length} failed (no retry queued)`) : ''}`, finished, job.id] },
    { sql: "UPDATE processing_jobs SET status = 'succeeded', completed_at = ?, result_json = ? WHERE id = ?", args: [finished, JSON.stringify({ students: completed, failedStudents: failedStudentIds.length, queuedRetry, questions: completed * rubric.questions.length, supervisor: supervisorReport }), job.id] },
    { sql: "UPDATE tests SET status = 'grading_queued', updated_at = ? WHERE id = ?", args: [finished, job.test_id] },
  ], 'write');
}

async function hasRequiredSourceOcr(testId) {
  const sources = await db.execute({
    sql: `SELECT DISTINCT a.kind
          FROM file_assets a JOIN asset_ocr_runs o ON o.asset_id = a.id
          WHERE a.test_id = ? AND a.status = 'uploaded' AND o.is_active = 1 AND o.status = 'succeeded'
            AND a.kind IN ('question_paper', 'answer_key')`,
    args: [testId],
  });
  const present = new Set(sources.rows.map((row) => row.kind));
  return present.has('question_paper') && present.has('answer_key');
}

async function processOcr(job) {
  await startStep(job.id, 'validate_inputs', 'Loading private source files directly from R2');
  const assets = await assetsForOcr(job.test_id); if (!assets.length) throw new Error('No uploaded source files are available for OCR.');
  await completeStep(job.id, 'validate_inputs', `${assets.length} uploaded source file(s) verified`);
  const privateJob = nearPrivateEnabledForCurrentJob();
  const engineFor = (asset) => (privateJob && readsStudentWork(asset.kind) ? 'near_vl' : ocrEngine);
  const engineLabel = privateJob ? 'Private' : { datalab: 'Datalab', mistral: 'Mistral' }[ocrEngine];
  await startStep(job.id, 'ocr', `${engineLabel} OCR running for ${assets.length} source file(s)`);
  const payload = parseJson(job.payload_json); let processed = 0; let reused = 0;
  const requiredKinds = new Set(['question_paper', 'answer_key']);
  const failedRequired = [];
  const failedOptional = [];
  let rubricQueued = false;
  const maybeQueueRubricEarly = async () => {
    if (rubricQueued) return;
    if (!(await hasRequiredSourceOcr(job.test_id))) return;
    await queueRubric(job.test_id, job.school, job.requested_by);
    rubricQueued = true;
  };
  await maybeQueueRubricEarly();
  for (const asset of assets) {
    await heartbeatJob(job, `ocr:${processed + reused + 1}/${assets.length}`);
    if (!payload.force && await hasActiveArtifact(asset)) {
      reused += 1;
      await maybeQueueRubricEarly();
      continue;
    }
    const engine = engineFor(asset);
    let result;
    try { result = await runOcrEngine(asset, engine); }
    catch (err) {
      console.warn(JSON.stringify({ event: 'ocr_asset_failed', assetId: asset.id, kind: asset.kind, student: asset.student, retryable: err?.retryable !== false, error: err.message }));
      (requiredKinds.has(asset.kind) ? failedRequired : failedOptional).push({ id: asset.id, kind: asset.kind, student: asset.student, reason: err.message, retryable: err?.retryable });
      continue;
    }
    if (!result.markdown) {
      console.warn(JSON.stringify({ event: 'ocr_asset_empty', assetId: asset.id, kind: asset.kind, student: asset.student }));
      // Empty text from a real scan is far more often a transient engine
      // problem than a blank sheet; retry it rather than drop the student.
      (requiredKinds.has(asset.kind) ? failedRequired : failedOptional).push({ id: asset.id, kind: asset.kind, student: asset.student, reason: 'OCR returned no readable content', retryable: true });
      continue;
    }
    await saveArtifact(job.id, asset, result, { engine, model: result.model }); processed += 1;
    await updateStepDetail(job.id, 'ocr', `OCR complete for ${processed + reused}/${assets.length} source file(s)`);
    await maybeQueueRubricEarly();
  }
  // No silent student loss: any asset that failed or returned empty text fails
  // the job. Required sources (question paper / answer key) would otherwise
  // produce a rubric built from garbage; an answer sheet would otherwise drop
  // that student from evidence, grading and reports without a trace. The job
  // retries (hasActiveArtifact skips the assets that already succeeded) and,
  // once attempts are exhausted, ends failed_retryable / tests.ocr_failed with
  // the students and assets named in the error for the admin retry path.
  const outcome = decideOcrOutcome({ processed, reused, totalAssets: assets.length, failedRequired, failedOptional });
  if (!outcome.ok) {
    await failStep(job.id, 'ocr', outcome.stepDetail);
    const error = new Error(outcome.error);
    error.retryable = outcome.retryable;
    error.code = outcome.code;
    error.failedAssets = outcome.failedAssets;
    throw error;
  }
  await completeStep(job.id, 'ocr', outcome.stepDetail);
  const completedAt = now();
  await db.execute({ sql: "UPDATE processing_jobs SET status = 'succeeded', completed_at = ?, error = NULL, result_json = ? WHERE id = ?", args: [completedAt, JSON.stringify({ ...outcome.result, engine: ocrEngine }), job.id] });
  const rubric = await queueRubric(job.test_id, job.school, job.requested_by);
  // A sheet-only rerun (after a failed attempt, or an admin retry) finds the
  // rubric already built and queues nothing. The test must not stay parked in
  // an OCR status: hand it back to the rubric review gate, where an admin
  // marks it for grading and the recovered student is picked up by evidence.
  if (rubric === 'built') {
    await db.execute({
      sql: `UPDATE tests SET status = 'rubric_ready_for_review', updated_at = ?
            WHERE id = ? AND status IN ('uploading', 'ocr_queued', 'ocr_processing', 'ocr_succeeded', 'ocr_failed')`,
      args: [completedAt, job.test_id],
    });
  }
}

async function processRubric(job) {
  await startStep(job.id, 'parse_key', 'Reading the active question-paper and answer-key OCR artifacts');
  const sources = await db.execute({ sql: `SELECT a.kind, o.id AS ocr_run_id, o.markdown, o.pages_json FROM file_assets a JOIN asset_ocr_runs o ON o.asset_id = a.id WHERE a.test_id = ? AND a.status = 'uploaded' AND o.is_active = 1 AND o.status = 'succeeded' AND a.kind IN ('question_paper', 'answer_key') ORDER BY CASE a.kind WHEN 'question_paper' THEN 0 ELSE 1 END, a.created_at`, args: [job.test_id] });
  const paper = sources.rows.filter((row) => row.kind === 'question_paper'); const key = sources.rows.filter((row) => row.kind === 'answer_key');
  if (!paper.length || !key.length) throw new Error('Active OCR for both the question paper and answer key is required.');
  const testRow = (await db.execute({ sql: 'SELECT school, school_id FROM tests WHERE id = ?', args: [job.test_id] })).rows[0] || {};
  // Rubric gate (fix plan phase 1): per-school, off unless RUBRIC_GATE_SCHOOLS names the school.
  const gate = rubricGateEnabled({ school: testRow.school || job.school, schoolId: testRow.school_id });
  const prompt = buildRubricPrompt({ paper, key });
  const { parsed, model: rubricModelUsed, payload } = await requestRubricPackage(prompt, { testId: job.test_id });
  let rubric = validateRubricPackage(parsed, { gate });
  if (gate) {
    // Independent key check by the family that did not build the rubric. A failure is
    // recorded as a warning rather than failing the build or blocking approval.
    const checker = checkerFamily(rubricModelUsed) === 'qwen'
      ? (p, maxTokens) => callDeepinfraModelJson(process.env.KEY_CHECK_QWEN_MODEL || 'Qwen/Qwen3.8-Flash', p, maxTokens)
      : (p, maxTokens) => callReasoningJson(p, maxTokens);
    try {
      rubric = applyKeyCheck(rubric, await runKeyCheck({ rubric, paperText: sourceOcrText(paper), callJson: checker, now }));
    } catch (error) {
      rubric.key_check = { error: String(error.message || error).slice(0, 300), ran_at: now() };
    }
    // Errors stay on the package for Rubric Review to show; approval is blocked until
    // they are fixed or overridden with a reason (api/_lib/rubricReviewService.js).
    const { errors, warnings } = checkRubricGate(rubric);
    rubric.quality = { ...rubric.quality, gate: true, errors, gateWarnings: warnings };
  }
  const max = await db.execute({ sql: 'SELECT COALESCE(MAX(version), 0) AS version FROM exam_rubric_versions WHERE test_id = ?', args: [job.test_id] });
  const completedAt = now(); const version = Number(max.rows[0]?.version || 0) + 1;
  await db.batch([
    { sql: 'UPDATE exam_rubric_versions SET is_active = 0 WHERE test_id = ? AND is_active = 1', args: [job.test_id] },
    { sql: `INSERT INTO exam_rubric_versions (id, test_id, job_id, version, status, model, source_ocr_run_ids_json, question_map_json, quality_json, created_at, completed_at, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`, args: [id('rubric'), job.test_id, job.id, version, 'succeeded', payload?.model || rubricModelUsed, JSON.stringify(sources.rows.map((row) => row.ocr_run_id)), JSON.stringify(rubric), JSON.stringify(rubric.quality), completedAt, completedAt] },
    { sql: "UPDATE processing_jobs SET progress_json = json_set(COALESCE(progress_json, '{}'), '$.steps.parse_key', json_object('status', 'succeeded', 'detail', ?, 'completed_at', ?)) WHERE id = ?", args: [`${rubric.quality.questionCount} canonical question(s), ${rubric.quality.totalMarks} scorable marks`, completedAt, job.id] },
    { sql: "UPDATE processing_jobs SET status = 'succeeded', completed_at = ?, error = NULL, result_json = ? WHERE id = ?", args: [completedAt, JSON.stringify({ rubricVersion: version, ...rubric.quality, awaitingRubricReview: true }), job.id] },
    { sql: "UPDATE tests SET status = 'rubric_ready_for_review', updated_at = ? WHERE id = ?", args: [completedAt, job.test_id] },
  ], 'write');
  // The paper now lives once per exam set; per-student rows only carry evidence/marks.
  await syncExamSetQuestionsFromRubric(db, { testId: job.test_id, rubric, at: completedAt })
    .catch((error) => logMirrorFailure('exam_set_questions', error));
  // Human gate: do not auto-queue evidence/grading until an admin marks for grading.
}

async function loadSubmissionQuestion(idValue) {
  const result = await db.execute({ sql: `SELECT q.*, s.test_id, s.student_id, t.grade, t.subject AS test_subject, t.title AS test_title
    FROM submission_questions q JOIN test_submissions s ON s.id = q.submission_id
    JOIN tests t ON t.id = s.test_id WHERE q.id = ?`, args: [idValue] });
  return result.rows[0] || null;
}

async function loadAnswerSheetPages(question) {
  let assetIds = parseJson(question.source_asset_ids_json, []);
  if ((!assetIds.length || !Array.isArray(assetIds)) && question.test_id && question.student_id) {
    const fallback = await db.execute({
      sql: `SELECT a.id FROM file_assets a
        JOIN test_students ts ON ts.id = a.test_student_id
        WHERE ts.test_id = ? AND ts.student_id = ? AND a.kind = 'answer_sheet' AND a.status = 'uploaded'
        ORDER BY a.created_at`,
      args: [question.test_id, question.student_id],
    });
    assetIds = fallback.rows.map((row) => row.id);
  }
  if (!assetIds.length) return { orderedAssetIds: [], pagesById: {}, sourcePages: [] };

  const placeholders = assetIds.map(() => '?').join(', ');
  const rows = await db.execute({
    sql: `SELECT a.id, a.storage_key, COALESCE(o.markdown, '') AS markdown
      FROM file_assets a
      LEFT JOIN asset_ocr_runs o ON o.asset_id = a.id AND o.is_active = 1 AND o.status = 'succeeded'
      WHERE a.id IN (${placeholders}) AND a.status = 'uploaded'`,
    args: assetIds,
  });
  const byId = new Map(rows.rows.map((row) => [row.id, row]));
  const orderedAssetIds = [];
  const pagesById = {};
  for (const assetId of assetIds) {
    const row = byId.get(assetId);
    if (!row) continue;
    if (!pagesById[assetId]) {
      orderedAssetIds.push(assetId);
      pagesById[assetId] = row;
    }
  }
  // Prefer chronological student pages when source_asset_ids_json was a messy duplicate bag.
  if (question.test_id && question.student_id) {
    const chronological = await db.execute({
      sql: `SELECT a.id, a.storage_key, COALESCE(o.markdown, '') AS markdown
        FROM file_assets a
        JOIN test_students ts ON ts.id = a.test_student_id
        LEFT JOIN asset_ocr_runs o ON o.asset_id = a.id AND o.is_active = 1 AND o.status = 'succeeded'
        WHERE ts.test_id = ? AND ts.student_id = ? AND a.kind = 'answer_sheet' AND a.status = 'uploaded'
        ORDER BY a.created_at`,
      args: [question.test_id, question.student_id],
    });
    if (chronological.rows.length) {
      for (const row of chronological.rows) pagesById[row.id] = row;
      return {
        orderedAssetIds: chronological.rows.map((row) => row.id),
        pagesById,
        sourcePages: parseJson(question.evidence_json, {}).source_pages || [],
      };
    }
  }
  return {
    orderedAssetIds,
    pagesById,
    sourcePages: parseJson(question.evidence_json, {}).source_pages || [],
  };
}

async function visualCandidateUrls(question, { maxPages = 3 } = {}) {
  const { orderedAssetIds, pagesById, sourcePages } = await loadAnswerSheetPages(question);
  const pageMarkdownByAssetId = Object.fromEntries(
    Object.entries(pagesById).map(([id, row]) => [id, row.markdown || '']),
  );
  const ranked = rankVisualPages({
    orderedAssetIds,
    sourcePages,
    pageMarkdownByAssetId,
    questionNumber: question.question_number,
  });
  const selected = ranked.slice(0, Math.max(1, maxPages));
  return selected.map((row) => {
    const asset = pagesById[row.assetId];
    return {
      assetId: row.assetId,
      score: row.score,
      mentionsTarget: row.mentionsTarget,
      sourceHit: row.sourceHit,
      labels: row.labels,
      url: createDownloadUrl({ key: asset.storage_key, expiresIn: 900 }),
    };
  }).filter((row) => row.url);
}

async function resolveVisionImageDataUrls(urls) {
  return Promise.all(urls.map(async (url) => {
    if (String(url || '').startsWith('data:')) return url;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`Could not read visual evidence (${response.status}).`);
      const mimeType = response.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
      const bytes = Buffer.from(await response.arrayBuffer()).toString('base64');
      return `data:${mimeType};base64,${bytes}`;
    } catch (error) {
      if (controller.signal.aborted) throw new Error('Timed out while reading visual evidence from R2.');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }));
}

async function callDeepinfraVision(question, rubric, urls) {
  const endpoint = deepinfraCompatConfig({ purpose: 'vision' });
  if (!endpoint?.apiKey) throw new Error('DEEPINFRA_API_KEY is not configured.');
  const images = await resolveVisionImageDataUrls(urls);
  const promptText = buildVisualRescuePrompt(question, rubric);
  const controller = new AbortController();
  const timeoutMs = Math.max(10_000, Number(process.env.DEEPINFRA_VISION_TIMEOUT_MS || 120_000));
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(endpoint.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${endpoint.apiKey}`, 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: endpoint.model,
        temperature: 0,
        max_tokens: 1800,
        messages: [{
          role: 'user',
          content: [
            ...images.map((image) => ({ type: 'image_url', image_url: { url: image } })),
            { type: 'text', text: promptText },
          ],
        }],
      }),
    });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`DeepInfra Gemma visual rescue timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  const body = await response.json().catch(() => ({}));
  const content = body?.choices?.[0]?.message?.content;
  const description = Array.isArray(content)
    ? content.map((part) => typeof part === 'string' ? part : part?.text || '').filter(Boolean).join('\n')
    : typeof content === 'string' ? content : '';
  if (!response.ok || !description) throw new Error(body?.error?.message || body?.message || `DeepInfra Gemma visual rescue failed (${response.status})`);
  return {
    attempted: true,
    usable: true,
    description: text(description, 12000),
    model: body?.model || endpoint.model,
    reason: '',
  };
}

async function callDashscopeVision(question, rubric, urls) {
  const apiKey = process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY;
  if (!apiKey) throw new Error('DASHSCOPE_API_KEY is not configured.');
  const baseUrl = (process.env.DASHSCOPE_BASE_URL || process.env.QWEN_BASE_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, '');
  // Qwen VL models are only served through compatible-mode /chat/completions;
  // the native /services/aigc path 404s under a compatible-mode base URL.
  const compatibleMode = baseUrl.includes('/compatible-mode');
  const model = process.env.DASHSCOPE_VISION_MODEL || 'qwen3.7-flash';
  const images = await resolveVisionImageDataUrls(urls);
  const promptText = buildVisualRescuePrompt(question, rubric);
  const endpoint = compatibleMode ? `${baseUrl}/chat/completions` : `${baseUrl}/services/aigc/multimodal-generation/generation`;
  const requestBody = compatibleMode
    ? { model, messages: [{ role: 'user', content: [...images.map((image) => ({ type: 'image_url', image_url: { url: image } })), { type: 'text', text: promptText }] }], max_tokens: 1800, temperature: 0 }
    : { model, input: { messages: [{ role: 'user', content: [...images.map((image) => ({ image })), { text: promptText }] }] }, parameters: { result_format: 'message' } };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(10_000, Number(process.env.DASHSCOPE_VISION_TIMEOUT_MS || 120_000)));
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify(requestBody),
    });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`DashScope Qwen visual rescue timed out after ${Math.round(Number(process.env.DASHSCOPE_VISION_TIMEOUT_MS || 120_000) / 1000)} seconds.`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  const body = await response.json().catch(() => ({}));
  const content = compatibleMode ? body?.choices?.[0]?.message?.content : body?.output?.choices?.[0]?.message?.content;
  const description = Array.isArray(content)
    ? content.map((part) => typeof part === 'string' ? part : part?.text || '').filter(Boolean).join('\n')
    : typeof content === 'string' ? content : '';
  if (!response.ok || !description) throw new Error(body?.error?.message || body?.message || body?.code || `DashScope Qwen visual rescue failed (${response.status})`);
  return {
    attempted: true,
    usable: true,
    description: text(description, 12000),
    model: body?.model || model,
    reason: '',
  };
}

async function callGlmVision(question, rubric, urls) {
  if (!process.env.GLM_API_KEY) throw new Error('GLM_API_KEY is not configured.');
  const response = await fetch(process.env.GLM_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4/chat/completions', {
    method: 'POST', headers: { authorization: `Bearer ${process.env.GLM_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: process.env.GLM_VISION_MODEL || 'glm-4.5v', temperature: 0, max_tokens: 1800, messages: [{ role: 'user', content: [{ type: 'text', text: buildVisualRescuePrompt(question, rubric) }, ...urls.map((url) => ({ type: 'image_url', image_url: { url } }))] }] }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.choices?.[0]?.message?.content) throw new Error(body?.error?.message || `GLM visual rescue failed (${response.status})`);
  return { attempted: true, usable: true, description: text(body.choices[0].message.content, 12000), model: body.model || process.env.GLM_VISION_MODEL || 'glm-4.5v', reason: '' };
}

// The worker fetches the page and sends its bytes, so no signed storage URL leaves us.
async function callNearVision(question, rubric, urls) {
  const config = nearAiConfig({ model: process.env.NEAR_AI_VISION_MODEL || process.env.NEAR_AI_OCR_MODEL || NEAR_OCR_MODEL });
  const images = await resolveVisionImageDataUrls(urls);
  const { ok, status, body } = await nearPrivateChatCompletion(config, {
    temperature: 0,
    max_tokens: 1800,
    messages: [{
      role: 'user',
      content: [
        ...images.map((image) => ({ type: 'image_url', image_url: { url: image } })),
        { type: 'text', text: buildVisualRescuePrompt(question, rubric) },
      ],
    }],
  });
  const description = body?.choices?.[0]?.message?.content;
  if (!ok || !description) throw new Error(body?.error?.message || `Private visual rescue failed (${status})`);
  return { attempted: true, usable: true, description: text(description, 12000), model: body.model || config.model, reason: '' };
}

async function describeVisualEvidence(question, rubric, urls, job) {
  // No fallback for an opted-in school: a failure retries, then goes to teacher review.
  if (nearPrivateEnabledForCurrentJob()) {
    try {
      return await callNearVision(question, rubric, urls);
    } catch (error) {
      if (Number(job.attempt_count || 1) < maxJobAttempts) throw error;
      return { attempted: true, usable: false, description: '', model: null, reason: String(error.message || error) };
    }
  }
  let visual = { attempted: true, usable: false, description: '', model: null, reason: 'No vision provider is configured.' };
  const failures = [];
  if (process.env.DEEPINFRA_API_KEY) {
    try {
      return await callDeepinfraVision(question, rubric, urls);
    } catch (gemmaError) {
      failures.push(`DeepInfra Gemma rescue failed: ${String(gemmaError.message || gemmaError)}`);
    }
  }
  try {
    visual = await callDashscopeVision(question, rubric, urls);
    return visual;
  } catch (qwenError) {
    failures.push(`DashScope Qwen rescue failed: ${String(qwenError.message || qwenError)}`);
    if (process.env.GLM_API_KEY) {
      try {
        visual = await callGlmVision(question, rubric, urls);
        return visual;
      } catch (glmError) {
        failures.push(`GLM fallback failed: ${String(glmError.message || glmError)}`);
      }
    }
  }
  const failure = failures.join('; ') || visual.reason;
  if (!visual.usable) {
    if (Number(job.attempt_count || 1) < maxJobAttempts) throw new Error(failure);
    visual.reason = failure;
  }
  return visual;
}

async function processVisualRescue(job) {
  const payload = parseJson(job.payload_json);
  const question = await loadSubmissionQuestion(payload.submissionQuestionId);
  if (!question) throw new Error('Question evidence no longer exists.');
  await startStep(job.id, 'visual_rescue', `Checking visual evidence for ${question.question_number}`);

  const reviewRow = await db.execute({
    sql: `SELECT COALESCE(qr.state, rd.state) AS state,
            COALESCE(qr.reviewer_id, rd.reviewer_id) AS reviewer_id
         FROM submission_questions q
         LEFT JOIN question_reviews qr ON qr.submission_question_id = q.id
         LEFT JOIN review_decisions rd ON rd.submission_question_id = q.id
         WHERE q.id = ? LIMIT 1`,
    args: [question.id],
  });
  if (isReviewerTouchedQuestion({
    reviewRevision: question.review_revision,
    reviewState: reviewRow.rows[0]?.state,
    reviewerId: reviewRow.rows[0]?.reviewer_id,
  })) {
    const completed = now();
    const skipped = {
      attempted: false,
      usable: false,
      description: '',
      model: null,
      reason: 'Skipped visual rescue: reviewer already edited or approved this question.',
      skipped_reviewer_touched: true,
    };
    await db.batch([
      { sql: "UPDATE processing_jobs SET progress_json = json_set(COALESCE(progress_json, '{}'), '$.steps.visual_rescue', json_object('status', 'succeeded', 'detail', ?, 'completed_at', ?)) WHERE id = ?", args: [skipped.reason, completed, job.id] },
      { sql: "UPDATE processing_jobs SET status = 'succeeded', completed_at = ?, result_json = ? WHERE id = ?", args: [completed, JSON.stringify(skipped), job.id] },
    ], 'write');
    return;
  }

  const evidence = parseJson(question.evidence_json, {});
  const rubric = parseJson(question.rubric_json, {});
  let visual = { attempted: true, usable: false, description: '', model: null, reason: 'No vision provider is configured.' };
  const candidates = await visualCandidateUrls(question, { maxPages: 3 });
  const attempts = [];
  if (!candidates.length) {
    visual.reason = 'No question-linked source scan pages were available for visual rescue.';
  } else {
    // Try highest-ranked page first (OCR label match), then next candidates.
    // Never accept a description that admits it looked at a different question.
    for (const candidate of candidates) {
      await heartbeatJob(job, `visual_rescue:${question.question_number}`);
      // A page the OCR reader linked to this answer, with no label on it, is
      // searched by the answer's opening text instead of the question number.
      const anchor = candidate.sourceHit && !candidate.mentionsTarget ? visualAnswerAnchor(evidence.student_answer) : '';
      const target = anchor ? { ...question, visual_answer_anchor: anchor } : question;
      const pageVisual = await describeVisualEvidence(target, rubric, [candidate.url], job);
      const check = validateVisualRescueDescription(pageVisual.description, question.question_number, { anchored: Boolean(anchor) });
      attempts.push({
        assetId: candidate.assetId,
        score: candidate.score,
        mentionsTarget: candidate.mentionsTarget,
        anchored: Boolean(anchor),
        usable: Boolean(pageVisual.usable && check.ok),
        reason: check.ok ? pageVisual.reason : check.reason,
        model: pageVisual.model,
      });
      if (pageVisual.usable && check.ok) {
        visual = {
          ...pageVisual,
          page_asset_id: candidate.assetId,
          page_rank_score: candidate.score,
          targeting: { mentions_target: candidate.mentionsTarget, labels: candidate.labels, attempts },
        };
        break;
      }
      visual = {
        attempted: true,
        usable: false,
        description: pageVisual.description || '',
        model: pageVisual.model,
        reason: check.ok ? (pageVisual.reason || 'Visual rescue did not verify the target question.') : check.reason,
        page_asset_id: candidate.assetId,
        targeting: { mentions_target: candidate.mentionsTarget, labels: candidate.labels, attempts },
      };
    }
  }
  evidence.visual_rescue = visual;
  // Keep prior OCR text; VL only supplements. Clear stale wrong-page descriptions
  // from the review payload when the rescue is unusable.
  const stored = parseJson(question.payload_json, {});
  stored.visualReview = { usable: visual.usable, visualAnswer: visual.usable ? visual.description : '', model: visual.model, reason: visual.reason };
  if (!visual.usable) {
    stored.isFlagged = true; stored.reviewPriority = 'flagged';
    stored.reviewTags = [...new Set([...(stored.reviewTags || []), 'visual_evidence_unverified'])];
  } else {
    stored.reviewTags = (stored.reviewTags || []).filter((tag) => tag !== 'visual_evidence_unverified');
  }
  const completed = now();
  const usable = Boolean(visual.usable);
  // A visual rescue that produced nothing usable is NOT a success: it must not be
  // counted as one and must never trigger auto-grading. The question stays
  // `evidence_ready` with the `visual_evidence_unverified` tag so a reviewer can
  // resolve it before grading (instead of grading against placeholder text).
  await db.batch([
    { sql: 'UPDATE submission_questions SET evidence_json = ?, payload_json = ?, updated_at = ? WHERE id = ?', args: [JSON.stringify(evidence), JSON.stringify(stored), completed, question.id] },
    { sql: 'UPDATE submission_questions_v2 SET evidence_json = ?, render_json = ?, updated_at = ? WHERE id = ?', args: [JSON.stringify(evidence), JSON.stringify(stored), completed, question.id] },
    usable
      ? { sql: "UPDATE processing_jobs SET progress_json = json_set(COALESCE(progress_json, '{}'), '$.steps.visual_rescue', json_object('status', 'succeeded', 'detail', ?, 'completed_at', ?)) WHERE id = ?", args: [`Visual evidence described by ${visual.model}`, completed, job.id] }
      : { sql: "UPDATE processing_jobs SET progress_json = json_set(COALESCE(progress_json, '{}'), '$.steps.visual_rescue', json_object('status', 'blocked', 'detail', ?, 'completed_at', ?)) WHERE id = ?", args: [visual.reason || 'Visual evidence unverified', completed, job.id] },
    usable
      ? { sql: "UPDATE processing_jobs SET status = 'succeeded', completed_at = ?, result_json = ? WHERE id = ?", args: [completed, JSON.stringify(visual), job.id] }
      : { sql: "UPDATE processing_jobs SET status = 'failed_retryable', completed_at = ?, error = ?, last_error_code = ?, result_json = ? WHERE id = ?", args: [completed, `Visual rescue produced no usable evidence: ${visual.reason || 'unverified'}`, 'visual_evidence_unverified', JSON.stringify(visual), job.id] },
  ], 'write');
  if (!usable) {
    await db.execute({ sql: "UPDATE tests SET status = 'visual_rescue_failed', updated_at = ? WHERE id = ?", args: [completed, job.test_id] });
  }
  await requireMirror('v2_question', syncV2Question(db, question.id, completed));
  if (!usable) return;
  const responseType = parseJson(question.rubric_json, {}).expected_response_type || '';
  if (isMcqResponseType(responseType)) {
    await queueJob({
      testId: job.test_id,
      school: job.school,
      type: 'grade_submission',
      payload: { submissionId: question.submission_id },
      requestedBy: job.requested_by,
      step: 'grade',
      detail: `Awaiting batch MCQ grading for ${question.student_name}`,
    });
  } else {
    await queueJob({ testId: job.test_id, school: job.school, type: 'grade_submission', payload: { submissionQuestionId: question.id }, requestedBy: job.requested_by, step: 'grade', detail: `Awaiting per-question grading for ${question.student_name} ${question.question_number}` });
  }
}

async function applyGradeToQuestion(question, grade, supervisedMeta = {}) {
  const completed = now();
  const rubric = parseJson(question.rubric_json, {});
  const stored = parseJson(question.payload_json, {});
  const evidence = parseJson(question.evidence_json, {});
  evidence.final_answer = '';
  const reviewed = stored.studentAnswer || {};
  const reviewedWrote = text(reviewed.studentWrote || '', 30000);
  const preservedAnswer = reviewedWrote || evidence.student_answer || '';
  const responseType = rubric.expected_response_type || stored.expectedResponseType || '';
  // A teacher-reviewed question keeps the teacher's mark: a re-grade refreshes
  // ai_marks and the AI feedback, never approved_marks. The shown mark stays the
  // teacher's; the new AI mark is kept in workflow.ai_regrade.
  const teacherMarks = teacherKeptMarks(question);
  const shownMarks = teacherMarks ?? grade.marks;
  const shownStatus = teacherMarks == null ? grade.status : scoreStatus(teacherMarks, question.marks_total, grade.status !== 'not_attempted');
  stored.grade = { marks: shownMarks, allocated: Number(question.marks_total), status: shownStatus, confidence: grade.confidence };
  stored.gradeRationale = { whatWentCorrect: grade.whatWentCorrect, missingOrWrong: grade.needsAttention, reasoning: grade.reasoning, nextStep: grade.nextStep };
  stored.gradeCriteria = grade.criteria || [];
  // Structured sub-part grades for compound questions (canonical display source).
  // Null/empty when the model did not produce parts — legacy prose fallback applies.
  stored.gradeParts = grade.parts || [];
  // An unclear symbol-heavy answer is flagged and sorted ahead of other flags.
  const urgent = grade.reviewReasons?.includes(UNCLEAR_SYMBOLS_TAG);
  stored.isFlagged = grade.needsReview || urgent; stored.reviewPriority = urgent ? 'urgent' : grade.needsReview ? 'flagged' : 'normal';
  stored.reviewTags = grade.reviewReasons;
  stored.isHarshZero = grade.isHarshZero;
  stored.expectedResponseType = responseType || stored.expectedResponseType || '';
  stored.workflow = {
    ...(stored.workflow || {}),
    grade_supervisor: supervisedMeta,
    ...(teacherMarks == null ? {} : { ai_regrade: { marks: grade.marks, status: grade.status, at: completed, kept_teacher_marks: teacherMarks } }),
  };
  stored.question = { ...(stored.question || {}), marks_obtained: shownMarks, marks_total: Number(question.marks_total), status: shownStatus, student_answer: preservedAnswer, what_went_correct: grade.whatWentCorrect, missing_or_wrong: grade.needsAttention, grading_reason: grade.reasoning, next_step: grade.nextStep };
  await db.batch(gradeMarkStatements({ questionId: question.id, aiMarks: grade.marks, payloadJson: JSON.stringify(stored), completed }), 'write');
  await requireMirror('v2_question', syncV2Question(db, question.id, completed));
  return completed;
}

async function processMcqBatchGrade(job, payload) {
  const submissionId = payload.submissionId;
  const includeNullMarks = payload.includeNullMarks === true || payload.forceRegrade === true;
  const rows = await db.execute({
    sql: `SELECT q.*, s.test_id, s.student_id, t.grade, t.subject AS test_subject, t.title AS test_title
          FROM submission_questions q
          JOIN test_submissions s ON s.id = q.submission_id
          JOIN tests t ON t.id = s.test_id
          WHERE q.submission_id = ?
            AND (
              q.status = 'evidence_ready'
              OR (? = 1 AND q.ai_marks IS NULL AND q.status IN ('graded', 'ready_for_review', 'evidence_ready'))
            )
          ORDER BY q.question_number`,
    args: [submissionId, includeNullMarks ? 1 : 0],
  });
  if (!rows.rows.length) {
    const completed = now();
    await db.execute({
      sql: "UPDATE processing_jobs SET status = 'succeeded', completed_at = ?, result_json = ? WHERE id = ?",
      args: [completed, JSON.stringify({ skipped: true, reason: 'no_evidence_ready_questions' }), job.id],
    });
    if (!payload.skipReportQueue) await queueReportsWhenComplete(job);
    return;
  }

  const studentName = rows.rows[0].student_name || submissionId;
  await startStep(job.id, 'grade', `Batch MCQ grading ${studentName} (${rows.rows.length} questions)`);

  const items = rows.rows.map((question) => {
    const rubric = parseJson(question.rubric_json, {});
    const stored = parseJson(question.payload_json, {});
    const evidence = parseJson(question.evidence_json, {});
    evidence.final_answer = '';
    const reviewed = stored.studentAnswer || {};
    const reviewedWrote = text(reviewed.studentWrote || '', 30000);
    if (reviewedWrote) evidence.student_answer = reviewedWrote;
    if (reviewed.attempted === false || reviewed.attempted === 0) evidence.attempted = false;
    else if (reviewed.attempted === true || reviewedWrote) evidence.attempted = true;
    if (reviewed.optionLetter) evidence.option_letter = reviewed.optionLetter;
    const visualAnswer = stored.visualReview?.usable ? text(stored.visualReview.visualAnswer || '', 30000) : '';
    const textIsPlaceholder = /(?:\[?image placeholders?\]?|\[img-[^\]]+\]|\[unread region\])/i.test(evidence.student_answer || '');
    if (visualAnswer && (textIsPlaceholder || !evidence.student_answer)) {
      evidence.student_answer = visualAnswer;
      evidence.attempted = true;
    }
    return { question, rubric, evidence, stored };
  });

  const prompt = buildMcqBatchGradePrompt({
    items: items.map((item) => ({
      question: item.question,
      rubric: item.rubric,
      evidence: item.evidence,
    })),
    subject: rows.rows[0].test_subject || '',
  });
  const response = await callGradeJson(prompt, Math.min(12000, 400 * items.length + 2000));
  const gradesByNumber = new Map();
  for (const entry of (Array.isArray(response.value?.grades) ? response.value.grades : [])) {
    const key = String(entry?.question_number || '').trim().toLowerCase();
    if (key) gradesByNumber.set(key, entry);
  }

  let graded = 0;
  let flagged = 0;
  for (const item of items) {
    await heartbeatJob(job, `mcq_batch_grade:${graded + 1}/${items.length}`);
    const key = String(item.question.question_number || '').trim().toLowerCase();
    // A question the model omitted from the batch response must not silently
    // score zero (with negative marking that is worse than a blank). Flag it
    // for review as an absent-answer signal instead.
    const missing = !gradesByNumber.has(key);
    const raw = missing ? { needs_review: true, review_reasons: ['missing_from_batch_response'] } : gradesByNumber.get(key);
    const grade = normalizeGradeResult(raw, item.question, item.evidence, item.rubric.expected_response_type || 'mcq', {
      markingRubric: item.rubric.marking_rubric || '',
      subject: item.question.test_subject || rows.rows[0].test_subject || '',
      language: 'english',
    });
    await applyGradeToQuestion(item.question, grade, {
      mode: 'mcq_batch',
      action: 'ok',
      model: response.model || null,
    });
    graded += 1;
    if (grade.needsReview) flagged += 1;
  }

  const completed = now();
  await db.batch([
    { sql: "UPDATE test_submissions SET status = 'graded', updated_at = ? WHERE id = ?", args: [completed, submissionId] },
    { sql: "UPDATE processing_jobs SET progress_json = json_set(COALESCE(progress_json, '{}'), '$.steps.grade', json_object('status', 'succeeded', 'detail', ?, 'completed_at', ?)) WHERE id = ?", args: [`Batch graded ${graded} MCQ(s); ${flagged} flagged`, completed, job.id] },
    { sql: "UPDATE processing_jobs SET status = 'succeeded', completed_at = ?, result_json = ? WHERE id = ?", args: [completed, JSON.stringify({ mode: 'mcq_batch', graded, flagged, model: response.model || null }), job.id] },
  ], 'write');
  await requireMirror('submission', syncCanonicalSubmission(db, submissionId, completed));
  if (!payload.skipReportQueue) await queueReportsWhenComplete(job);
}

async function processGrade(job) {
  const payload = parseJson(job.payload_json);
  if (payload.submissionId && !payload.submissionQuestionId) {
    await processMcqBatchGrade(job, payload);
    return;
  }
  const question = await loadSubmissionQuestion(payload.submissionQuestionId);
  if (!question) throw new Error('Question evidence no longer exists.');
  await startStep(job.id, 'grade', `Grading ${question.student_name} ${question.question_number}`);
  const rubric = parseJson(question.rubric_json, {});
  const stored = parseJson(question.payload_json, {});
  const evidence = parseJson(question.evidence_json, {});
  // Never grade from invented "final answer" polish — only student_answer / OCR / VL text.
  evidence.final_answer = '';
  // Reviewer OCR edits live on payload.studentAnswer, not always mirrored into evidence_json.
  // Prefer that text so regrades keep reviewer corrections while refreshing marks.
  const reviewed = stored.studentAnswer || {};
  const reviewedWrote = text(reviewed.studentWrote || '', 30000);
  if (reviewedWrote) evidence.student_answer = reviewedWrote;
  if (reviewed.attempted === false || reviewed.attempted === 0) evidence.attempted = false;
  else if (reviewed.attempted === true || reviewedWrote) evidence.attempted = true;
  if (reviewed.optionLetter) evidence.option_letter = reviewed.optionLetter;
  // Prefer accepted visual transcription when raw OCR is still a placeholder.
  const visualAnswer = stored.visualReview?.usable ? text(stored.visualReview.visualAnswer || '', 30000) : '';
  const textIsPlaceholder = /(?:\[?image placeholders?\]?|\[img-[^\]]+\]|\[unread region\])/i.test(evidence.student_answer || '');
  if (visualAnswer && (textIsPlaceholder || !evidence.student_answer)) {
    evidence.student_answer = visualAnswer;
    evidence.attempted = true;
    evidence.visual_rescue = {
      ...(evidence.visual_rescue || {}),
      usable: true,
      description: visualAnswer,
    };
  }
  await heartbeatJob(job, `grade:${question.student_name} ${question.question_number}`);
  const supervised = await gradeWithSupervision({
    question,
    rubric,
    evidence,
    subject: question.test_subject || '',
    callJson: (prompt, maxTokens = 8000) => callGradeJson(prompt, maxTokens),
  });
  const grade = supervised.grade;
  const completed = await applyGradeToQuestion(question, grade, supervised.supervisor);
  await db.batch([
    { sql: "UPDATE test_submissions SET status = 'graded', updated_at = ? WHERE id = ?", args: [completed, question.submission_id] },
    { sql: "UPDATE processing_jobs SET progress_json = json_set(COALESCE(progress_json, '{}'), '$.steps.grade', json_object('status', 'succeeded', 'detail', ?, 'completed_at', ?)) WHERE id = ?", args: [`${grade.marks}/${question.marks_total}; ${grade.needsReview ? 'flagged for review' : 'ready for review'}`, completed, job.id] },
    { sql: "UPDATE processing_jobs SET status = 'succeeded', completed_at = ?, result_json = ? WHERE id = ?", args: [completed, JSON.stringify({ marks: grade.marks, total: question.marks_total, review: grade.needsReview, model: supervised.model, supervisor: supervised.supervisor }), job.id] },
  ], 'write');
  await requireMirror('submission', syncCanonicalSubmission(db, question.submission_id, completed));
  if (!payload.skipReportQueue) await queueReportsWhenComplete(job);
}

/**
 * Guardrail: ensures a canonical exam exists for a test before reports are published.
 * If examForTest returns null, creates the exam on the spot so report_versions.exam_id is NEVER null.
 */
async function ensureExamForTest(db, testId, test) {
  const existing = await examForTest(db, testId).catch(() => null);
  if (existing?.examId) return existing;
  // No canonical exam exists — create one now.
  console.warn(JSON.stringify({ event: 'exam_id_guardrail_triggered', testId, school: test.school, reason: 'No canonical exam found; creating on-the-fly before report publish' }));
  try {
    const schoolId = await resolveSchoolId(db, test.school);
    if (!schoolId) throw new Error(`Cannot resolve school_id for "${test.school}"`);
    const ts = now();
    const subjectId = await ensureSubjectId(db, schoolId, test.subject, ts);
    const academicYearId = await currentAcademicYearId(db, schoolId);
    const examId = examRowId('exam');
    const roster = (await db.execute({ sql: 'SELECT student_id, batch_id FROM test_students WHERE test_id = ?', args: [testId] })).rows;
    const batchIds = [...new Set(roster.map((r) => r.batch_id).filter(Boolean))];
    const stmts = canonicalExamStatements({
      examId, schoolId, subjectId, academicYearId: academicYearId || null,
      name: test.title || 'Untitled', examDate: test.created_at || ts,
      examType: 'subjective', status: 'in_review', sourceTestId: testId,
      createdBy: 'oci_worker_guardrail', batchIds, sets: null, roster, now: ts,
    });
    await db.batch(stmts, 'write');
    const created = await examForTest(db, testId);
    if (!created?.examId) throw new Error('Exam creation succeeded but examForTest still returns null');
    console.warn(JSON.stringify({ event: 'exam_id_guardrail_resolved', testId, examId: created.examId }));
    return created;
  } catch (err) {
    // Log loudly but don't block reports — fallback to null (backward compat)
    console.error(JSON.stringify({ event: 'exam_id_guardrail_failed', testId, error: String(err?.message || err) }));
    return null;
  }
}

async function processReports(job) {
  await startStep(job.id, 'build_reports', 'Materializing first-pass student reports from graded question records');
  const test = (await db.execute({ sql: 'SELECT * FROM tests WHERE id = ?', args: [job.test_id] })).rows[0];
  if (!test) throw new Error('Test no longer exists.');
  const rubricPackage = await activeRubric(job.test_id);
  const scoringPlan = rubricPackage.rubric.exam?.scoring_plan || { groups: [] };
  const payload = parseJson(job.payload_json, {});
  const submissionIds = Array.isArray(payload.submissionIds) ? [...new Set(payload.submissionIds.map((value) => String(value || '').trim()).filter(Boolean))] : [];
  const submissionClause = submissionIds.length ? ` AND s.id IN (${submissionIds.map(() => '?').join(', ')})` : '';
  const result = await db.execute({ sql: `SELECT s.id AS submission_id, s.student_id, ts.student_name, q.* FROM test_submissions s
    JOIN test_students ts ON ts.test_id = s.test_id AND ts.student_id = s.student_id
    JOIN submission_questions q ON q.submission_id = s.id WHERE s.test_id = ?${submissionClause} ORDER BY ts.student_name, q.question_number`, args: [job.test_id, ...submissionIds] });
  const submissions = new Map();
  for (const row of result.rows) {
    if (!submissions.has(row.submission_id)) submissions.set(row.submission_id, { studentId: row.student_id, name: row.student_name, rows: [] });
    submissions.get(row.submission_id).rows.push(row);
  }
  if (!submissions.size) throw new Error('No graded question records are available.');
  const canonicalExam = await ensureExamForTest(db, job.test_id, test);
  // Students hear about a report only once a teacher has released the test
  // (exams.released_at); "Release to students" sends the push for every report then.
  const releasedToStudents = canonicalExam?.examId
    ? Boolean((await db.execute({ sql: 'SELECT released_at FROM exams WHERE id = ?', args: [canonicalExam.examId] })).rows[0]?.released_at)
    : true;
  let count = 0;
  let holdCount = 0;
  const scoreChecks = [];
  // After each write, confirm the stored score (both tables and the report)
  // equals the total just computed; a gap means a write or mirror was lost.
  const checkScore = async (submissionId, score, total) => {
    const expected = { score, total };
    const mismatches = await findScoreMismatches(db, submissionId, expected).catch((error) => {
      console.warn(JSON.stringify({ event: 'score_check_failed', submissionId, error: String(error?.message || error) }));
      return [];
    });
    scoreChecks.push({ submissionId, expected, mismatches });
  };
  for (const [submissionId, student] of submissions) {
    await heartbeatJob(job, `building_report_modules:${count + 1}/${submissions.size}`);
    const rawQuestions = student.rows.map((row) => {
      const payload = parseJson(row.payload_json, {}); const evidence = parseJson(row.evidence_json, {}); const grade = payload.grade || {};
      // An evidence_blocked question renders as not attempted with a visible
      // review flag and zero marks; it must neither crash the report nor be
      // scored as a graded answer (reportReadiness.js).
      const presented = presentQuestionForReport({
        gradeStatus: grade.status,
        marks: row.approved_marks ?? row.ai_marks ?? 0,
        total: row.marks_total,
        attempted: evidence.attempted !== false,
        gradingReason: payload.gradeRationale?.reasoning || '',
        scoreStatus,
        teacherMarks: teacherKeptMarks(row),
      });
      return { number: row.question_number, question: row.question_text || '', summary: row.question_text || '', topic: parseJson(row.rubric_json, {}).topic || 'General', marks_obtained: presented.marks_obtained, scored_marks_obtained: presented.marks_obtained, marks_total: Number(row.marks_total || 0), scored_marks_allocated: Number(row.marks_total || 0), status: presented.status, flagged: presented.flagged, review_flag: presented.review_flag, evidence_blocked: presented.evidence_blocked, student_answer: evidence.student_answer || '', student_answer_raw: evidence.student_answer || '', correct_answer: row.answer_key_text || '', what_went_correct: payload.gradeRationale?.whatWentCorrect || '', missing_or_wrong: payload.gradeRationale?.missingOrWrong || (presented.evidence_blocked ? presented.grading_reason : ''), grading_reason: presented.grading_reason, thinking_trace: payload.gradeRationale?.reasoning || '', next_step: payload.gradeRationale?.nextStep || '', source_pages: evidence.source_pages || [], parts: Array.isArray(payload.gradeParts) ? payload.gradeParts : [] };
    });
    const scoring = applyScoringPlan(rawQuestions, scoringPlan);
    const questions = scoring.questions;
    const score = scoring.score; const total = scoring.total;
    const primaryLogin = (await db.execute({ sql: `SELECT credential.login_id FROM student_user_links link JOIN user_credentials credential ON credential.user_id = link.user_id WHERE link.student_id = ? AND credential.is_primary = 1 AND credential.status = 'active' LIMIT 1`, args: [student.studentId] }).catch(() => ({ rows: [] }))).rows[0]?.login_id;
    const login = requireStudentPublicLogin(primaryLogin, student.studentId);
    // ── GUARDRAILS: reject incomplete reports before publishing ──
    const reportErrors = [];
    if (!questions.length) reportErrors.push('no questions');
    if (questions.some((q) => !q.grading_reason && q.status !== 'not_attempted')) reportErrors.push(`missing grading_reason on ${questions.filter((q) => !q.grading_reason && q.status !== 'not_attempted').length}/${questions.length} attempted questions`);
    if (!login) reportErrors.push('no public login resolved');
    const linkedAssets = await db.execute({ sql: "SELECT count(*) as c FROM file_assets WHERE test_id = ? AND test_student_id IN (SELECT id FROM test_students WHERE test_id = ? AND student_id = ?) AND kind = 'answer_sheet' AND status = 'uploaded'", args: [job.test_id, job.test_id, student.studentId] });
    if (!Number(linkedAssets.rows[0]?.c)) reportErrors.push('no answer sheet file_assets linked');
    if (reportErrors.length) {
      // Report guardrails are blocking: never publish a report that is known to be
      // incomplete. Hold it for explicit review instead of warning and continuing.
      console.log(JSON.stringify({ event: 'report_guardrail_blocked', student: student.name, login, submissionId, errors: reportErrors }));
      // A held report still gets its current total, so the teacher dashboard
      // never shows a score from before the latest marks.
      await db.batch([
        { sql: "UPDATE test_submissions SET status = 'report_blocked', score = ?, max_marks = ?, updated_at = ? WHERE id = ?", args: [score, total, now(), submissionId] },
        { sql: "UPDATE tests SET status = 'report_blocked', updated_at = ? WHERE id = ?", args: [now(), job.test_id] },
      ], 'write');
      await requireMirror('submission', syncCanonicalSubmission(db, submissionId, now())).catch((error) => logMirrorFailure('submission', error));
      await checkScore(submissionId, score, total);
      holdCount += 1;
      continue;
    }
    const [prior, versionState] = await Promise.all([
      db.execute({ sql: "SELECT id, version FROM report_versions WHERE submission_id = ? AND status = 'published' ORDER BY version DESC LIMIT 1", args: [submissionId] }),
      db.execute({ sql: 'SELECT COALESCE(MAX(version), 0) AS version FROM report_versions WHERE submission_id = ?', args: [submissionId] }),
    ]);
    const timestamp = now();
    const modules = await generateInitialReportModules({ student, subjectName: test.subject, questions });
    const subject = {
      id: String(test.subject).toLowerCase().replace(/[^a-z0-9]+/g, '_'), name: test.subject, score, total, scoring_plan: scoringPlan, scoring_notes: scoring.notes,
      status: score / Math.max(total, 1) >= 0.75 ? 'strong' : score / Math.max(total, 1) >= 0.45 ? 'developing' : 'needs_work',
      questions, ...modules.subject,
    };
    const report = {
      schema_version: 2,
      public_username: login,
      student: { name: student.name, class: test.grade, school: test.school, submission_id: submissionId },
      exams: [{ id: job.test_id, name: test.title, date: test.created_at }],
      term1: {
        overall_insights: {
          strongest_area: subject.strengths?.[0] || '',
          focus_needed: subject.misconceptions || [],
          pattern: subject.learning_profile?.pattern_recognition || subject.overall_insights || '',
        },
        subjects: [subject],
      },
      learner_dna: modules.learnerDna,
      workflow: {
        test_id: job.test_id, worker: 'oci-processing-v2', report_model: modules.model || 'deterministic-fallback', generated_at: timestamp,
        // Questions published without gradable evidence, so reviewers and
        // operators can see at a glance which marks are provisional.
        evidence_blocked_questions: questions.filter((question) => question.evidence_blocked).map((question) => String(question.number)),
      },
    };
    // Superseded revisions are retained for audit history, so allocating from
    // the currently published revision alone can collide with an older
    // superseded version. The next report revision must advance the complete
    // per-submission history.
    const version = Number(versionState.rows[0]?.version || 0) + 1; const ops = [];
    if (prior.rows[0]) ops.push({ sql: "UPDATE report_versions SET status = 'superseded', superseded_at = ? WHERE id = ?", args: [timestamp, prior.rows[0].id] });
    ops.push({ sql: "INSERT INTO report_versions (id, submission_id, version, status, workflow_run_id, generated_at, published_at, payload_json, username, school, exam_id, student_id) VALUES (?, ?, ?, 'published', ?, ?, ?, ?, ?, ?, ?, ?)", args: [id('report'), submissionId, version, job.id, timestamp, timestamp, JSON.stringify(report), login, test.school, canonicalExam?.examId || null, student.studentId] }, { sql: "UPDATE test_submissions SET status = 'ready_for_review', score = ?, max_marks = ?, updated_at = ? WHERE id = ?", args: [score, total, timestamp, submissionId] });
    if (releasedToStudents) ops.push(pushOutboxStatement({ school: test.school, username: login, eventType: PUSH_EVENT_TYPES.REPORT_PUBLISHED, title: 'Your report is ready', body: `${test.title}: you scored ${score} out of ${total} in ${test.subject}. Tap to open your report.`, data: { screen: 'student', submissionId, subject: test.subject, testId: job.test_id }, createdAt: timestamp }));
    await db.batch(ops, 'write'); count += 1;
    await requireMirror('submission', syncCanonicalSubmission(db, submissionId, timestamp));
    await checkScore(submissionId, score, total);

    const schoolIdForWarning = await resolveSchoolId(db, test.school).catch(() => null);
    if (schoolIdForWarning && student.studentId) {
      await detectAndStoreEarlyWarning(db, {
        schoolId: schoolIdForWarning,
        studentId: student.studentId,
        examId: canonicalExam?.examId || null,
        submissionId,
        username: login,
        studentName: student.name,
        report,
        at: timestamp,
      }).catch((error) => {
        console.warn(JSON.stringify({ event: 'early_warning_failed', submissionId, error: String(error?.message || error) }));
      });
    }

    // When deep_signals is on, Hive extract→synthesize owns DNA writes.
    // Otherwise keep the immediate longitudinal refresh path.
    if (await isDeepSignalsEnabled(test.school)) {
      const studentId = student.studentId || null;
      if (studentId) {
        await queueJob({
          testId: job.test_id,
          school: test.school,
          type: 'deep_signal_extraction',
          payload: {
            submissionId,
            username: login,
            studentId,
            examId: canonicalExam?.examId || null,
            source: 'report_publish',
          },
          requestedBy: workerId,
          step: 'extract_signals',
          detail: 'Awaiting deep signal extraction',
        }).catch((error) => {
          console.warn(JSON.stringify({ event: 'deep_signal_enqueue_failed', submissionId, error: String(error?.message || error) }));
        });
      }
    } else {
      await refreshLearnerDna(db, login).catch((error) => {
        console.warn(JSON.stringify({ event: 'learner_dna_refresh_failed', username: login, error: String(error?.message || error) }));
      });
    }
  }
  await reportScoreMismatches({ alerts, school: test.school, testId: job.test_id, source: 'build_reports', items: scoreChecks });
  if (count > 0) {
    await enqueuePush(db, { school: test.school, role: 'admin', eventType: PUSH_EVENT_TYPES.PROCESSING_COMPLETE, title: 'Reports ready', body: `${test.title}: ${count} student report${count === 1 ? '' : 's'} published${holdCount ? `, ${holdCount} held for review` : ''}.`, data: { screen: 'home', testId: job.test_id } }).catch((error) => console.warn(JSON.stringify({ event: 'push_enqueue_failed', testId: job.test_id, error: String(error?.message || error) })));
  }
  const teacherRefresh = await refreshTeacherReportModules(db, {
    id: job.id,
    school: test.school,
    grade: test.grade,
    subject: test.subject,
  }).catch((error) => {
    console.warn(JSON.stringify({ event: 'teacher_report_refresh_failed', testId: test.id, error: String(error?.message || error) }));
    return { updated: 0, warning: 'teacher_refresh_failed' };
  });
  const completed = now();
  const finalTestStatus = holdCount > 0 ? 'report_blocked' : 'ready_for_review';
  await db.batch([{ sql: "UPDATE processing_jobs SET progress_json = json_set(COALESCE(progress_json, '{}'), '$.steps.build_reports', json_object('status', 'succeeded', 'detail', ?, 'completed_at', ?)), status='succeeded', completed_at=?, result_json=? WHERE id=?", args: [`Published ${count} first-pass student report(s); held ${holdCount} report(s) for review (guardrail); refreshed ${teacherRefresh.updated || 0} teacher projection(s)`, completed, completed, JSON.stringify({ reports: count, held_for_review: holdCount, teacher_projections: teacherRefresh.updated || 0 }), job.id] }, { sql: "UPDATE tests SET status=?, updated_at=? WHERE id=?", args: [finalTestStatus, completed, job.test_id] }], 'write');
}

async function processDeepSignals(job) {
  const payload = parseJson(job.payload_json);
  const submissionId = payload.submissionId;
  const studentId = payload.studentId;
  if (!submissionId || !studentId) throw new Error('deep_signal_extraction requires submissionId and studentId');

  const schoolId = await resolveSchoolId(db, job.school);
  if (!schoolId) throw new Error(`Could not resolve school_id for ${job.school}`);

  const test = await db.execute({ sql: 'SELECT subject, title FROM tests WHERE id = ?', args: [job.test_id] });
  const subject = test.rows[0]?.subject || '';
  const examId = payload.examId || (await examForTest(db, job.test_id))?.examId || null;

  await heartbeatJob(job, 'extract_signals');
  const result = await runDeepSignalExtraction(db, {
    submissionId,
    schoolId,
    studentId,
    examId,
    school: job.school,
    subject,
    studentName: payload.studentName || payload.username || '',
  });

  if (process.env.MASTERY_ESTIMATION_ENABLED === '1') {
    await queueJob({
      testId: job.test_id,
      school: job.school,
      type: 'mastery_estimation',
      payload: { studentId, username: payload.username || null, schoolId },
      requestedBy: job.requested_by || workerId,
      step: 'estimate_mastery',
      detail: 'Beta-Binomial mastery update pending',
    }).catch((error) => {
      console.warn(JSON.stringify({ event: 'mastery_enqueue_failed', studentId, error: String(error?.message || error) }));
    });
  }

  await queueJob({
    testId: job.test_id,
    school: job.school,
    type: 'hive_synthesis',
    payload: {
      studentId,
      username: payload.username || null,
      schoolId,
      triggerSource: 'deep_signal',
      sourceSubmissionId: submissionId,
    },
    requestedBy: workerId,
    step: 'synthesize_dna',
    detail: 'Awaiting Hive DNA synthesis',
  }).catch((error) => {
    console.warn(JSON.stringify({ event: 'hive_synthesis_enqueue_failed', studentId, error: String(error?.message || error) }));
  });

  const completed = now();
  await db.execute({
    sql: `UPDATE processing_jobs
          SET progress_json = json_set(COALESCE(progress_json, '{}'), '$.steps.extract_signals', json_object('status', 'succeeded', 'detail', ?, 'completed_at', ?)),
              status = 'succeeded', completed_at = ?, result_json = ?
          WHERE id = ?`,
    args: [
      result.skipped
        ? `Skipped deep signals (${result.reason || 'no_work'})`
        : `Extracted ${result.extracted} signal(s) from ${result.questionCount} question(s)`,
      completed,
      completed,
      JSON.stringify(result),
      job.id,
    ],
  });
}

async function processMastery(job) {
  const payload = parseJson(job.payload_json);
  const studentId = payload.studentId;
  if (!studentId) throw new Error('mastery_estimation requires studentId');
  const schoolId = payload.schoolId || await resolveSchoolId(db, job.school);
  if (!schoolId) throw new Error(`Could not resolve school_id for ${job.school}`);

  await heartbeatJob(job, 'estimate_mastery');
  const kcRows = (await db.execute({
    sql: `SELECT DISTINCT je.value AS kc
          FROM evidence_signals es, json_each(es.kc_ids_json) je
          WHERE es.school_id = ? AND es.student_id = ? AND es.status = 'active'
            AND es.kc_ids_json IS NOT NULL`,
    args: [schoolId, studentId],
  })).rows;
  let count = 0;
  for (const row of kcRows) {
    if (!row.kc) continue;
    await runMasteryEstimation(db, { schoolId, studentId, kcId: row.kc });
    count += 1;
  }

  const completed = now();
  await db.execute({
    sql: `UPDATE processing_jobs
          SET progress_json = json_set(COALESCE(progress_json, '{}'), '$.steps.estimate_mastery', json_object('status', 'succeeded', 'detail', ?, 'completed_at', ?)),
              status = 'succeeded', completed_at = ?, result_json = ?
          WHERE id = ?`,
    args: [`${count} KC(s) estimated`, completed, completed, JSON.stringify({ estimated: count }), job.id],
  });
}

async function processHiveSynthesis(job) {
  const payload = parseJson(job.payload_json);
  const studentId = payload.studentId;
  if (!studentId) throw new Error('hive_synthesis requires studentId');
  const schoolId = payload.schoolId || await resolveSchoolId(db, job.school);
  if (!schoolId) throw new Error(`Could not resolve school_id for ${job.school}`);

  await heartbeatJob(job, 'synthesize_dna');
  const result = await runHiveSynthesis(db, {
    schoolId,
    studentId,
    username: payload.username || null,
    triggerSource: payload.triggerSource || 'worker',
  });

  const completed = now();
  await db.execute({
    sql: `UPDATE processing_jobs
          SET progress_json = json_set(COALESCE(progress_json, '{}'), '$.steps.synthesize_dna', json_object('status', 'succeeded', 'detail', ?, 'completed_at', ?)),
              status = 'succeeded', completed_at = ?, result_json = ?
          WHERE id = ?`,
    args: [
      result.skipped
        ? `Skipped Hive synthesis (${result.reason || 'no_work'})`
        : `Synthesized DNA from ${result.signalCount} signal(s)`,
      completed,
      completed,
      JSON.stringify({
        skipped: result.skipped,
        reason: result.reason || null,
        runId: result.runId,
        signalCount: result.signalCount || 0,
        diff: result.diff || null,
        model: result.model || null,
      }),
      job.id,
    ],
  });
}

async function maybeQueueNightlyHiveSynthesis() {
  const stamp = Date.now();
  if (stamp - lastHiveSynthesisQueueAt < hiveSynthesisQueueMs) return 0;
  lastHiveSynthesisQueueAt = stamp;

  let schoolId = null;
  if (processingSchool) {
    schoolId = await resolveSchoolId(db, processingSchool);
    if (!schoolId) return 0;
    const enabled = await db.execute({
      sql: `SELECT enabled FROM school_feature_flags WHERE school_id = ? AND feature_key = 'deep_signals' LIMIT 1`,
      args: [schoolId],
    }).catch(() => ({ rows: [] }));
    if (Number(enabled.rows[0]?.enabled) !== 1) return 0;
  }

  const due = await listStudentsNeedingSynthesis(db, { schoolId, limit: 10 }).catch(() => []);
  let queued = 0;
  for (const row of due) {
    if (processingSchool) {
      const schoolName = (await db.execute({ sql: 'SELECT display_name FROM schools WHERE id = ?', args: [row.school_id] })).rows[0]?.display_name;
      if (schoolName !== processingSchool) continue;
    }
    const testLookup = await db.execute({
      sql: `SELECT ts.test_id, sc.display_name AS school
            FROM evidence_signals es
            JOIN test_submissions ts ON ts.id = es.submission_id
            JOIN schools sc ON sc.id = es.school_id
            WHERE es.student_id = ?
            ORDER BY es.extracted_at DESC LIMIT 1`,
      args: [row.student_id],
    });
    const testId = testLookup.rows[0]?.test_id;
    const school = testLookup.rows[0]?.school;
    if (!testId || !school) continue;
    const jobId = await queueJob({
      testId,
      school,
      type: 'hive_synthesis',
      payload: {
        studentId: row.student_id,
        schoolId: row.school_id,
        triggerSource: 'nightly',
      },
      requestedBy: workerId,
      step: 'synthesize_dna',
      detail: 'Nightly Hive DNA synthesis',
    });
    if (jobId) queued += 1;
  }
  if (queued) console.log(JSON.stringify({ event: 'hive_synthesis_nightly_queued', count: queued }));
  return queued;
}

const retryTestStatus = {
  mistral_ocr: 'ocr_queued', build_rubric: 'rubric_queued', materialize_evidence: 'evidence_queued',
  visual_rescue: 'visual_rescue_queued', grade_submission: 'grading_queued', build_reports: 'report_queued',
};

const failedTestStatus = {
  mistral_ocr: 'ocr_failed', build_rubric: 'rubric_failed', materialize_evidence: 'evidence_failed',
  visual_rescue: 'visual_rescue_failed', grade_submission: 'grading_failed', build_reports: 'report_failed',
};

async function failJob(job, error) {
  const completedAt = now();
  const attempts = Number(job.attempt_count || 1);
  const retryable = error?.retryable !== false && attempts < maxJobAttempts;
  const failedTestStatusForJob = failedTestStatus[job.type] || 'processing_failed';
  const ops = [
    { sql: `UPDATE processing_jobs
            SET status = ?, completed_at = ?, error = ?, last_error_code = ?,
              heartbeat_at = NULL, lease_expires_at = NULL, worker_id = NULL,
              next_attempt_at = ?
            WHERE id = ? AND worker_id = ?`, args: [retryable ? 'queued' : 'failed_retryable', retryable ? null : completedAt, String(error?.message || error), errorCode(error), retryable ? retryAt(attempts, { baseMs: retryBaseMs, maxMs: retryMaxMs }) : null, job.id, workerId] },
    { sql: "UPDATE processing_jobs SET progress_json = json_set(COALESCE(progress_json, '{}'), '$.steps.error', json_object('status', 'failed', 'detail', ?, 'completed_at', ?)) WHERE id = ?", args: [`${String(error?.message || error)}${retryable ? ' Retrying automatically.' : ''}`, completedAt, job.id] },
  ];
  if (!hiveSideJobTypes.has(job.type)) {
    if (job.type === 'mistral_ocr' && retryable) {
      // A retrying OCR job must not drag a test whose rubric is already built
      // (or being graded) back to ocr_queued; the test only re-enters the OCR
      // family if it is still there. Exhausted retries always mark ocr_failed.
      ops.splice(1, 0, {
        sql: `UPDATE tests SET status = ?, updated_at = ? WHERE id = ?
                AND status IN ('uploading', 'ocr_queued', 'ocr_processing', 'ocr_succeeded', 'ocr_failed')`,
        args: [retryTestStatus.mistral_ocr, completedAt, job.test_id],
      });
    } else {
      ops.splice(1, 0, { sql: 'UPDATE tests SET status = ?, updated_at = ? WHERE id = ?', args: [retryable ? (retryTestStatus[job.type] || 'processing_queued') : failedTestStatusForJob, completedAt, job.test_id] });
    }
  }
  await db.batch(ops, 'write');
  return { retryable, attempts };
}

async function releaseCompletedJob(job) {
  await db.execute({
    sql: `UPDATE processing_jobs
          SET heartbeat_at = NULL, lease_expires_at = NULL, worker_id = NULL,
            progress_json = ?
          WHERE id = ? AND status = 'succeeded' AND worker_id = ?`,
    args: [JSON.stringify({ phase: 'completed', updatedAt: now() }), job.id, workerId],
  });
}

async function drainPushNotifications() {
  if (Date.now() - lastPushDrainAt < pushDrainIntervalMs) return;
  lastPushDrainAt = Date.now();
  try {
    const stats = await drainPushOutbox(db);
    if (stats.claimed) console.log(JSON.stringify({ event: 'push_drain', ...stats }));
  } catch (error) {
    console.error(JSON.stringify({ event: 'push_drain_failed', error: String(error?.message || error) }));
  }
}

// CRM WhatsApp messages (CRM M2 phase 2): planners, dispatcher and health
// probe. On their own timer, so a long grading job never delays a message.
let commsTick = null;
let commsRunning = false;
async function runComms() {
  if (commsRunning || stopping) return;
  commsRunning = true;
  try {
    commsTick ||= createCommsRunner(db, { workerId });
    await commsTick();
  } catch (error) {
    console.error(JSON.stringify({ event: 'comms_tick_failed', error: String(error?.message || error) }));
  } finally {
    commsRunning = false;
  }
}

async function tick() {
  await recordWorkerHeartbeat();
  await drainPushNotifications();
  await reclaimExpiredJobs();
  if (!processedRegradeLastTick) {
    const regradeWorked = await processCohortRegrade();
    if (regradeWorked) { processedRegradeLastTick = true; return true; }
  }
  const job = await claimNextJob();
  if (!job) {
    processedRegradeLastTick = false;
    await maybeQueueNightlyHiveSynthesis();
    return false;
  }
  processedRegradeLastTick = false;
  console.log(JSON.stringify({ event: 'job_claimed', jobId: job.id, type: job.type, testId: job.test_id }));
  activeJob = job;
  const stopLeaseHeartbeat = startLeaseHeartbeat(() => extendJobLease(job), {
    intervalMs: jobHeartbeatMs,
    onError: (error) => console.warn(JSON.stringify({ event: 'job_lease_extend_failed', jobId: job.id, error: String(error?.message || error) })),
  });
  try {
    await heartbeatJob(job, 'processing');
    await runWithInferenceContext({ jobId: job.id, jobType: job.type, school: job.school, schoolId: await inferenceSchoolId(job.school), testId: job.test_id }, async () => {
      if (job.type === 'mistral_ocr') await processOcr(job);
      else if (job.type === 'build_rubric') await processRubric(job);
      else if (job.type === 'materialize_evidence') await processEvidence(job);
      else if (job.type === 'visual_rescue') await processVisualRescue(job);
      else if (job.type === 'grade_submission') await processGrade(job);
      else if (job.type === 'build_reports') await processReports(job);
      else if (job.type === 'deep_signal_extraction') await processDeepSignals(job);
      else if (job.type === 'hive_synthesis') await processHiveSynthesis(job);
      else if (job.type === 'mastery_estimation') await processMastery(job);
      else throw new Error(`Unsupported job type: ${job.type}`);
    });
    await releaseCompletedJob(job);
    const outcome = await db.execute({ sql: 'SELECT status, last_error_code FROM processing_jobs WHERE id = ?', args: [job.id] }).catch(() => ({ rows: [] }));
    const finalStatus = outcome.rows[0]?.status || 'succeeded';
    console.log(JSON.stringify(finalStatus === 'succeeded'
      ? { event: 'job_succeeded', jobId: job.id }
      : { event: 'job_blocked', jobId: job.id, type: job.type, status: finalStatus, code: outcome.rows[0]?.last_error_code || null }));
  }
  catch (error) {
    const result = await failJob(job, error);
    console.error(JSON.stringify({ event: result.retryable ? 'job_retry_scheduled' : 'job_failed', jobId: job.id, attempts: result.attempts, error: String(error?.message || error) }));
    if (!result.retryable) {
      alerts.send('job_failed', { jobId: job.id, type: job.type, testId: job.test_id, school: job.school, attempts: result.attempts, error: String(error?.message || error) }).catch(() => {});
    }
  }
  finally {
    stopLeaseHeartbeat();
    activeJob = null;
  }
  return true;
}

async function run() {
  await assertWorkerSchema();
  await ensurePushOutboxTable(db).catch((error) => console.warn(JSON.stringify({ event: 'push_outbox_init_failed', error: String(error?.message || error) })));
  await recordWorkerHeartbeat(null, true);
  console.log(JSON.stringify({ event: 'worker_started', workerId, workerVersion, pollIntervalMs, jobLeaseMs, jobHeartbeatMs, shutdownGraceMs, maxJobAttempts, alerts: alerts.enabled }));
  alerts.send('worker_started', { workerId, workerVersion }, { key: workerId }).catch(() => {});
  const housekeeping = createHousekeeper(db);
  const commsTimer = setInterval(runComms, 5_000);
  commsTimer.unref?.();
  while (!stopping) {
    const didWork = await tick().catch((error) => {
      console.error(JSON.stringify({ event: 'poll_failed', error: String(error?.message || error) }));
      alerts.send('poll_failed', { error: String(error?.message || error) }, { key: 'poll' }).catch(() => {});
      return false;
    });
    if (!didWork) {
      await housekeeping();
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
  clearInterval(commsTimer);
  await recordWorkerHeartbeat(null, true).catch(() => {});
}

// Orchestration surface for tests (src/test/worker-orchestration.test.js).
// Importing this module with WORKER_AUTOSTART=0 performs the env checks and
// opens the database but neither installs signal handlers nor starts polling.
export {
  assertWorkerSchema,
  claimNextJob,
  db,
  failJob,
  heartbeatJob,
  queueJob,
  reclaimExpiredJobs,
  reconcileEvidenceGradeJobs,
  releaseCompletedJob,
  ungradedQuestionCount,
  workerId,
};

// systemd runs this file directly with WORKER_AUTOSTART unset, so the worker
// starts exactly as before; only an explicit '0' (tests) disables autostart.
// An env flag rather than an argv/import.meta.url comparison: /opt/skyll is a
// symlink to the release directory and Node resolves the main module's real
// path, so a URL comparison would silently fail in production.
if (process.env.WORKER_AUTOSTART !== '0') {
  const shutdown = createShutdown({
    graceMs: shutdownGraceMs,
    activeJob: () => activeJob,
    releaseJob: releaseJobOnShutdown,
    exit: () => process.exit(0),
    log: (entry) => console.log(JSON.stringify({ ...entry, workerId })),
  });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { stopping = true; shutdown.request(signal); });
  run().catch((error) => { console.error(error); process.exitCode = 1; });
}
