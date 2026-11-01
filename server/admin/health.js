import { database, ensureAuthTables, requireUser } from '../../api/_lib/auth.js';
import { buildSystemHealth, classifyRecentJobService, classifyWorkerFleetHealth, HEALTH_STATUS } from '../../shared/systemHealth.js';
import { probeStorage, STORAGE_PROBE_TIMEOUT_MS } from '../../api/_lib/storage.js';
import { publicHealthProbe } from './healthProbe.js';

function service({ id, name, status, detail, lastCheckedAt = null, source = 'live' }) {
  return { id, name, status, detail, lastCheckedAt, source };
}

function latestJobsByType(rows) {
  const latest = new Map();
  for (const job of rows || []) {
    if (!latest.has(job.type)) latest.set(job.type, job);
  }
  return latest;
}

function queryScope(user, column = 'school') {
  return user.role === 'skyll_admin'
    ? { where: '', args: [] }
    : { where: `WHERE ${column} = ?`, args: [user.school] };
}

/**
 * Live R2 check: one bounded bucket listing. Missing configuration is
 * "unknown" (nothing to probe); a timeout, HTTP error or network failure is
 * "critical". Provider error text never reaches the browser.
 */
export async function storageHealth({ probe = probeStorage, timeoutMs = STORAGE_PROBE_TIMEOUT_MS } = {}) {
  const checkedAt = new Date().toISOString();
  const base = { id: 'r2_storage', name: 'R2 private storage', lastCheckedAt: checkedAt, source: 'live' };
  try {
    const result = await probe({ timeoutMs });
    if (result.ok) return service({ ...base, status: HEALTH_STATUS.HEALTHY, detail: `A one-key bucket listing completed in ${result.elapsedMs} ms.` });
    return service({ ...base, status: HEALTH_STATUS.CRITICAL, detail: `The storage bucket answered HTTP ${result.status} to a one-key listing.` });
  } catch (error) {
    if (error?.code === 'storage_timeout') return service({ ...base, status: HEALTH_STATUS.CRITICAL, detail: `The storage bucket did not answer within ${Math.round(timeoutMs / 1000)} seconds.` });
    if (String(error?.message || '').startsWith('Storage is not configured')) return service({ ...base, status: HEALTH_STATUS.UNKNOWN, detail: 'Storage credentials are not configured for this deployment.', source: 'configuration' });
    return service({ ...base, status: HEALTH_STATUS.CRITICAL, detail: 'The storage bucket could not be reached.' });
  }
}

function isPublicProbe(req) {
  const queryValue = req.query?.probe;
  if (String(Array.isArray(queryValue) ? queryValue[0] : queryValue || '') === '1') return true;
  return new URL(req.url || '/', 'https://skyllai.local').searchParams.get('probe') === '1';
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (isPublicProbe(req)) {
    const result = await publicHealthProbe({ runDatabaseCheck: () => database().execute('SELECT 1 AS ok') });
    return res.status(result.status).json(result.body);
  }

  try {
    await ensureAuthTables();
    const user = await requireUser(req, res, ['admin', 'skyll_admin']);
    if (!user) return;

    const db = database();
    const requestedAt = Date.now();
    const classesScope = queryScope(user, 'b.school');
    const jobsScope = queryScope(user);
    const [databaseCheck, classesResult, workerResult, jobsResult, storageResult] = await Promise.allSettled([
      db.execute('SELECT 1 AS ok'),
      db.execute({
        sql: `SELECT b.id, b.school, b.name, b.grade, b.academic_year, b.status,
                     COUNT(CASE WHEN bs.status = 'active' AND s.status = 'active' THEN bs.student_id END) AS student_count
              FROM batches b
              LEFT JOIN batch_memberships bs ON bs.batch_id = b.id
              LEFT JOIN students s ON s.id = bs.student_id
              ${classesScope.where}
              GROUP BY b.id, b.school, b.name, b.grade, b.academic_year, b.status
              ORDER BY b.school COLLATE NOCASE, b.grade COLLATE NOCASE, b.name COLLATE NOCASE`,
        args: classesScope.args,
      }),
      db.execute({
        sql: "SELECT worker_id, service, version, status, active_job_id, last_seen_at FROM worker_heartbeats WHERE service LIKE 'skyll-worker@%' ORDER BY last_seen_at DESC LIMIT 20",
      }),
      db.execute({
        sql: `SELECT type, status, requested_at, started_at, completed_at
              FROM processing_jobs ${jobsScope.where}
              ORDER BY COALESCE(completed_at, started_at, requested_at) DESC
              LIMIT 200`,
        args: jobsScope.args,
      }),
      storageHealth(),
    ]);

    const elapsedMs = Date.now() - requestedAt;
    const services = [
      service({
        id: 'web_api',
        name: 'Skyll web API',
        status: HEALTH_STATUS.HEALTHY,
        detail: 'The authenticated health endpoint is responding.',
        lastCheckedAt: new Date().toISOString(),
      }),
      databaseCheck.status === 'fulfilled'
        ? service({ id: 'turso', name: 'Primary database (libSQL)', status: HEALTH_STATUS.HEALTHY, detail: `A read query completed in ${elapsedMs} ms.`, lastCheckedAt: new Date().toISOString() })
        : service({ id: 'turso', name: 'Primary database (libSQL)', status: HEALTH_STATUS.CRITICAL, detail: 'The database health query did not complete.', source: 'live' }),
      workerResult.status === 'fulfilled'
        ? classifyWorkerFleetHealth(workerResult.value.rows)
        : service({ id: 'oci_processing_worker', name: 'OCI processing worker', status: HEALTH_STATUS.UNKNOWN, detail: 'Worker state could not be read.', source: 'heartbeat' }),
    ];

    if (jobsResult.status === 'fulfilled') {
      const jobs = latestJobsByType(jobsResult.value.rows);
      services.push(
        classifyRecentJobService({ id: 'mistral_ocr', name: 'Source OCR (Datalab / Mistral)', job: jobs.get('mistral_ocr') }),
        classifyRecentJobService({ id: 'deepseek_rubric', name: 'Rubric generation', job: jobs.get('build_rubric') }),
      );
    } else {
      services.push(
        service({ id: 'mistral_ocr', name: 'Source OCR (Datalab / Mistral)', status: HEALTH_STATUS.UNKNOWN, detail: 'Recent OCR job history could not be read.', source: 'recent_job' }),
        service({ id: 'deepseek_rubric', name: 'Rubric generation', status: HEALTH_STATUS.UNKNOWN, detail: 'Recent rubric job history could not be read.', source: 'recent_job' }),
      );
    }

    services.push(storageResult.status === 'fulfilled'
      ? storageResult.value
      : service({ id: 'r2_storage', name: 'R2 private storage', status: HEALTH_STATUS.UNKNOWN, detail: 'The storage check could not run.', source: 'live' }));

    const classes = classesResult.status === 'fulfilled'
      ? classesResult.value.rows.map((row) => ({
        id: row.id,
        school: row.school,
        name: row.name,
        grade: row.grade,
        academicYear: row.academic_year,
        status: row.status,
        studentCount: Number(row.student_count || 0),
      }))
      : [];

    return res.status(200).json(buildSystemHealth({ classes, services }));
  } catch {
    return res.status(500).json({ error: 'Could not load system health.' });
  }
}
