import { database, ensureAuthTables, requireUser } from '../../api/_lib/auth.js';
import { ensureIntakeTables } from '../../api/_lib/intake.js';
import { projectOperationsAssessment } from './assessmentLifecycleProjection.js';

function number(value) {
  return Number(value || 0);
}

function emptyCounts() {
  return { queued: 0, running: 0, succeeded: 0, failed: 0 };
}

function addJobCount(counts, job) {
  const count = number(job.job_count);
  if (job.status === 'queued') counts.queued += count;
  else if (job.status === 'running') counts.running += count;
  else if (job.status === 'succeeded') counts.succeeded += count;
  else if (String(job.status || '').startsWith('failed')) counts.failed += count;
  return counts;
}

// processing.stages keys used by projectProcessingTelemetry.
const STAGE_KEYS = {
  mistral_ocr: 'ocr',
  build_rubric: 'rubric',
  materialize_evidence: 'evidence',
  visual_rescue: 'visual',
  grade_submission: 'grading',
  build_reports: 'reports',
};

/**
 * The projection counts stage jobs by filtering the rows it is given. Those
 * rows are one representative per (type, status), so restore the real counts
 * from the per-group aggregate; the stage status it picked stays as is.
 */
export function withStageCounts(assessment, countsByType = new Map()) {
  const stages = assessment?.processing?.stages;
  if (!stages) return assessment;
  for (const [type, key] of Object.entries(STAGE_KEYS)) {
    if (stages[key] && countsByType.has(type)) Object.assign(stages[key], countsByType.get(type));
  }
  return assessment;
}

const REGRADE_RETRYABLE_STATUSES = new Set(['partial', 'failed']);

/**
 * Browser-safe view of a cohort regrade run. The worker's error string is
 * trimmed; it is an operator message, not a stack trace.
 */
export function projectRegradeSummary(run) {
  const items = {
    queued: number(run.queued_items),
    processing: number(run.processing_items),
    completed: number(run.completed_items),
    failed: number(run.failed_items),
  };
  const total = items.queued + items.processing + items.completed + items.failed;
  return {
    runId: run.id,
    status: run.status,
    requestedAt: run.requested_at || null,
    startedAt: run.started_at || null,
    completedAt: run.completed_at || null,
    error: run.error ? String(run.error).slice(0, 200) : null,
    questionCount: number(run.question_count),
    studentCount: number(run.student_count),
    items,
    total,
    retryable: REGRADE_RETRYABLE_STATUSES.has(String(run.status || '')) && items.failed > 0,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    await ensureAuthTables();
    await ensureIntakeTables();
    const user = await requireUser(req, res, ['admin', 'skyll_admin']);
    if (!user) return;

    const db = database();
    const isSkyllAdmin = user.role === 'skyll_admin';
    const scope = isSkyllAdmin ? { where: '', args: [] } : { where: 'WHERE t.school = ?', args: [user.school] };

    const cursor = req.query.cursor ? String(req.query.cursor).trim() : null;
    const testScopeWhere = cursor
      ? (isSkyllAdmin ? 'WHERE t.updated_at < ?' : 'WHERE t.school = ? AND t.updated_at < ?')
      : scope.where;
    const testScopeArgs = cursor
      ? (isSkyllAdmin ? [cursor] : [user.school, cursor])
      : scope.args;

    // Regrade runs carry the canonical school_id, so school admins are scoped by
    // id here rather than by display name.
    const regradeScope = isSkyllAdmin ? { where: '', args: [] } : { where: 'WHERE r.school_id = ?', args: [user.school_id || null] };

    // Page the tests first, then aggregate each child table on its own for just
    // that page: joining test_students and file_assets together multiplied
    // every student by every asset before COUNT(DISTINCT) folded it back.
    const pageResult = db.execute({
      sql: `WITH page AS (
              SELECT t.id, t.school, t.title, t.subject, t.grade, t.status, t.created_at, t.updated_at
              FROM tests t
              ${testScopeWhere}
              ORDER BY t.updated_at DESC
              LIMIT 100
            ),
            roster AS (
              SELECT ts.test_id, COUNT(*) AS expected_students,
                     SUM(CASE WHEN ts.status = 'uploaded' THEN 1 ELSE 0 END) AS uploaded_students
              FROM test_students ts WHERE ts.test_id IN (SELECT id FROM page)
              GROUP BY ts.test_id
            ),
            assets AS (
              SELECT a.test_id,
                     SUM(CASE WHEN a.kind = 'answer_sheet' AND a.status = 'uploaded' THEN 1 ELSE 0 END) AS answer_sheets,
                     SUM(CASE WHEN a.kind = 'question_paper' AND a.status = 'uploaded' THEN 1 ELSE 0 END) AS question_papers,
                     SUM(CASE WHEN a.kind = 'answer_key' AND a.status = 'uploaded' THEN 1 ELSE 0 END) AS answer_keys,
                     SUM(CASE WHEN a.status IN ('registered', 'uploading') THEN 1 ELSE 0 END) AS pending_uploads
              FROM file_assets a WHERE a.test_id IN (SELECT id FROM page)
              GROUP BY a.test_id
            )
            SELECT page.*,
                   COALESCE(roster.expected_students, 0) AS expected_students,
                   COALESCE(roster.uploaded_students, 0) AS uploaded_students,
                   COALESCE(assets.answer_sheets, 0) AS answer_sheets,
                   COALESCE(assets.question_papers, 0) AS question_papers,
                   COALESCE(assets.answer_keys, 0) AS answer_keys,
                   COALESCE(assets.pending_uploads, 0) AS pending_uploads
            FROM page
            LEFT JOIN roster ON roster.test_id = page.id
            LEFT JOIN assets ON assets.test_id = page.id
            ORDER BY page.updated_at DESC`,
      args: testScopeArgs,
    });

    const [[testsResult, jobsResult, publicationsResult], heartbeatResult, scanRemovalEvents, regradeResult] = await Promise.all([
      pageResult.then(async (tests) => {
        const testIds = tests.rows.map((test) => test.id);
        if (!testIds.length) return [tests, { rows: [] }, { rows: [] }];
        const ids = testIds.map(() => '?').join(', ');
        // Restricting to the page's test ids is the tenancy scope for jobs and
        // publications: the ids come from the school-scoped page above.
        const [jobs, publications] = await Promise.all([
          // Grade jobs are per question (thousands per test), so a global
          // "latest N jobs" starved most tests. Count jobs per (test, type,
          // status) and keep only the newest job of each group; that row set
          // still answers every "newest running / queued / failed / overall"
          // question the projections ask. progress_json stays server-side.
          db.execute({
            sql: `WITH groups AS (
                    SELECT test_id, type, status, COUNT(*) AS job_count
                    FROM processing_jobs WHERE test_id IN (${ids})
                    GROUP BY test_id, type, status
                  ),
                  picked AS (
                    SELECT g.job_count,
                           (SELECT j.id FROM processing_jobs j
                            WHERE j.test_id = g.test_id AND j.type = g.type AND j.status = g.status
                            ORDER BY j.requested_at DESC LIMIT 1) AS job_id
                    FROM groups g
                  )
                  SELECT j.id, j.test_id, j.school, j.type, j.status, j.requested_at, j.started_at, j.completed_at, j.heartbeat_at,
                         j.lease_expires_at, j.attempt_count, j.next_attempt_at, j.last_error_code, j.progress_json, j.error, picked.job_count
                  FROM picked JOIN processing_jobs j ON j.id = picked.job_id
                  ORDER BY j.requested_at DESC`,
            args: testIds,
          }),
          // Canonical submissions (not legacy test_submissions) for the page only.
          db.execute({
            sql: `SELECT e.source_test_id AS test_id,
                         COUNT(DISTINCT s.id) AS submission_count,
                         COUNT(DISTINCT report.submission_id) AS published_report_count,
                         MAX(report.published_at) AS published_at
                  FROM exams e
                  JOIN submissions s ON s.exam_id = e.id AND s.status != 'archived'
                  LEFT JOIN report_versions report ON report.submission_id = s.id AND report.status = 'published'
                  WHERE e.source_test_id IN (${ids})
                  GROUP BY e.source_test_id`,
            args: testIds,
          }),
        ]);
        return [tests, jobs, publications];
      }),
      db.execute({ sql: "SELECT worker_id, service, version, status, active_job_id, last_seen_at FROM worker_heartbeats WHERE service LIKE 'skyll-worker@%' ORDER BY last_seen_at DESC LIMIT 20" }),
      db.execute({
        sql: `SELECT e.test_id, e.status, COUNT(*) AS count, COALESCE(SUM(e.page_count), 0) AS pages, MAX(e.created_at) AS latest_at
              FROM intake_asset_events e JOIN tests t ON t.id = e.test_id
              ${scope.where}${scope.where ? ' AND' : ' WHERE'} e.event_type = 'answer_sheet_removed'
              GROUP BY e.test_id, e.status`,
        args: scope.args,
      }).catch(() => ({ rows: [] })),
      // Latest cohort regrade per test. The run's test is the exam's source
      // test, falling back to the test_id recorded in the run scope.
      db.execute({
        sql: `SELECT r.id, r.status, r.requested_at, r.started_at, r.completed_at, r.error, r.question_count, r.student_count,
                     COALESCE(e.source_test_id, json_extract(r.scope, '$.test_id')) AS test_id,
                     SUM(CASE WHEN i.state = 'queued' THEN 1 ELSE 0 END) AS queued_items,
                     SUM(CASE WHEN i.state = 'processing' THEN 1 ELSE 0 END) AS processing_items,
                     SUM(CASE WHEN i.state = 'completed' THEN 1 ELSE 0 END) AS completed_items,
                     SUM(CASE WHEN i.state = 'failed' THEN 1 ELSE 0 END) AS failed_items
              FROM regrade_runs r
              LEFT JOIN exams e ON e.id = r.exam_id
              LEFT JOIN regrade_items i ON i.run_id = r.id
              ${regradeScope.where}
              GROUP BY r.id
              ORDER BY r.requested_at DESC
              LIMIT 300`,
        args: regradeScope.args,
      }).catch(() => ({ rows: [] })),
    ]);

    const regradeByTest = new Map();
    for (const run of regradeResult.rows) {
      if (!run.test_id || regradeByTest.has(run.test_id)) continue;
      regradeByTest.set(run.test_id, projectRegradeSummary(run));
    }

    const activeStepByJob = new Map();
    for (const job of jobsResult.rows) {
      const progress = JSON.parse(job.progress_json || '{}');
      const steps = progress.steps || {};
      const entries = Object.entries(steps);
      const running = entries.find(([, s]) => s.status === 'running');
      const latest = entries[entries.length - 1];
      const pick = running || latest;
      if (pick) activeStepByJob.set(job.id, { job_id: job.id, step: pick[0], status: pick[1].status, detail: pick[1].detail, started_at: pick[1].started_at, completed_at: pick[1].completed_at });
    }

    const latestJobByTest = new Map();
    const latestOcrJobByTest = new Map();
    const latestRubricJobByTest = new Map();
    const latestEvidenceJobByTest = new Map();
    const latestReportJobByTest = new Map();
    const jobsByTest = new Map();
    const publicationByTest = new Map(publicationsResult.rows.map((row) => [row.test_id, row]));
    const gradingByTest = new Map();
    const stageCountsByTest = new Map();
    const scanRemovalByTest = new Map();
    for (const event of scanRemovalEvents.rows) {
      const current = scanRemovalByTest.get(event.test_id) || { succeeded: 0, failed: 0, pagesRemoved: 0, lastEventAt: null };
      if (event.status === 'succeeded') {
        current.succeeded += number(event.count);
        current.pagesRemoved += number(event.pages);
      } else if (event.status === 'failed') current.failed += number(event.count);
      if (!current.lastEventAt || event.latest_at > current.lastEventAt) current.lastEventAt = event.latest_at;
      scanRemovalByTest.set(event.test_id, current);
    }
    for (const job of jobsResult.rows) {
      const jobs = jobsByTest.get(job.test_id) || [];
      jobs.push(job);
      jobsByTest.set(job.test_id, jobs);
      if (!latestJobByTest.has(job.test_id)) latestJobByTest.set(job.test_id, job);
      if (job.type === 'mistral_ocr' && !latestOcrJobByTest.has(job.test_id)) latestOcrJobByTest.set(job.test_id, job);
      if (job.type === 'build_rubric' && !latestRubricJobByTest.has(job.test_id)) latestRubricJobByTest.set(job.test_id, job);
      if (job.type === 'materialize_evidence' && !latestEvidenceJobByTest.has(job.test_id)) latestEvidenceJobByTest.set(job.test_id, job);
      if (job.type === 'build_reports' && !latestReportJobByTest.has(job.test_id)) latestReportJobByTest.set(job.test_id, job);
      // Each row stands for job_count jobs of its (type, status) group.
      const counts = stageCountsByTest.get(job.test_id) || new Map();
      addJobCount(counts.get(job.type) || counts.set(job.type, emptyCounts()).get(job.type), job);
      stageCountsByTest.set(job.test_id, counts);
      if (['grade_submission', 'visual_rescue'].includes(job.type)) {
        const current = gradingByTest.get(job.test_id) || emptyCounts();
        addJobCount(current, job);
        gradingByTest.set(job.test_id, current);
      }
    }
    const tests = testsResult.rows.map((test) => {
      const job = latestJobByTest.get(test.id);
      const ocrJob = latestOcrJobByTest.get(test.id);
      const rubricJob = latestRubricJobByTest.get(test.id);
      const evidenceJob = latestEvidenceJobByTest.get(test.id);
      const reportJob = latestReportJobByTest.get(test.id);
      const assessment = withStageCounts(
        projectOperationsAssessment(test, jobsByTest.get(test.id), publicationByTest.get(test.id), activeStepByJob),
        stageCountsByTest.get(test.id),
      );
      return {
        id: test.id,
        school: test.school,
        title: test.title,
        subject: test.subject,
        grade: test.grade,
        testStatus: test.status,
        jobStatus: job?.status || null,
        jobRequestedAt: job?.requested_at || null,
        jobStartedAt: job?.started_at || null,
        jobCompletedAt: job?.completed_at || null,
        jobHeartbeatAt: job?.heartbeat_at || null,
        jobLeaseExpiresAt: job?.lease_expires_at || null,
        jobAttemptCount: number(job?.attempt_count),
        jobNextAttemptAt: job?.next_attempt_at || null,
        jobLastErrorCode: job?.last_error_code || null,
        ocrJob: ocrJob ? {
          id: ocrJob.id,
          status: ocrJob.status,
          requestedAt: ocrJob.requested_at,
          startedAt: ocrJob.started_at,
          completedAt: ocrJob.completed_at,
        } : null,
        rubricJob: rubricJob ? {
          id: rubricJob.id,
          status: rubricJob.status,
          requestedAt: rubricJob.requested_at,
          startedAt: rubricJob.started_at,
          completedAt: rubricJob.completed_at,
        } : null,
        evidenceJob: evidenceJob ? { id: evidenceJob.id, status: evidenceJob.status, requestedAt: evidenceJob.requested_at, startedAt: evidenceJob.started_at, completedAt: evidenceJob.completed_at } : null,
        grading: gradingByTest.get(test.id) || emptyCounts(),
        scanRemoval: scanRemovalByTest.get(test.id) || { succeeded: 0, failed: 0, pagesRemoved: 0, lastEventAt: null },
        reportJob: reportJob ? { id: reportJob.id, status: reportJob.status, requestedAt: reportJob.requested_at, startedAt: reportJob.started_at, completedAt: reportJob.completed_at } : null,
        regrade: regradeByTest.get(test.id) || null,
        assessment,
        expectedStudents: number(test.expected_students),
        uploadedStudents: number(test.uploaded_students),
        answerSheets: number(test.answer_sheets),
        updatedAt: job?.requested_at || test.updated_at || test.created_at,
        // Raw tests.updated_at: the pagination cursor must match the column the
        // next page filters on, not the job-derived activity time above.
        cursorAt: test.updated_at || test.created_at,
      };
    });
    const freshAfter = Date.now() - (2 * 60 * 1000);
    const workers = heartbeatResult.rows.filter((worker) => new Date(worker.last_seen_at || 0).getTime() >= freshAfter);
    const worker = workers[0] || null;
    const nextCursor = tests.length === 100 ? tests[tests.length - 1].cursorAt : null;
    return res.status(200).json({
      tests,
      workers: {
        healthy: workers.filter((item) => item.status === 'healthy').length,
        active: workers.filter((item) => item.active_job_id).length,
        lastSeenAt: worker?.last_seen_at || null,
      },
      nextCursor
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Could not load operations data' });
  }
}
