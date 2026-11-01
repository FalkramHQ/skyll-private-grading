export const HEALTH_STATUS = Object.freeze({
  HEALTHY: 'healthy',
  WARNING: 'warning',
  CRITICAL: 'critical',
  UNKNOWN: 'unknown',
  INACTIVE: 'inactive',
});

export const WORKER_HEALTH_THRESHOLDS_MS = Object.freeze({
  warning: 90_000,
  critical: 180_000,
});

export const RECENT_JOB_WINDOW_MS = 24 * 60 * 60 * 1_000;

const STATUS_RANK = Object.freeze({
  [HEALTH_STATUS.HEALTHY]: 0,
  [HEALTH_STATUS.UNKNOWN]: 1,
  [HEALTH_STATUS.INACTIVE]: 1,
  [HEALTH_STATUS.WARNING]: 2,
  [HEALTH_STATUS.CRITICAL]: 3,
});

function timestampMs(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function newestTimestamp(job) {
  return job?.completed_at || job?.started_at || job?.requested_at || null;
}

function service({ id, name, status, detail, lastCheckedAt = null, source = 'live' }) {
  return { id, name, status, detail, lastCheckedAt, source };
}

export function classifyClassHealth(batch) {
  const status = String(batch?.status || 'active').toLowerCase();
  const studentCount = Number(batch?.studentCount ?? batch?.student_count ?? 0);
  const name = String(batch?.name || 'Unnamed class');
  const grade = String(batch?.grade || '').trim();
  const academicYear = String(batch?.academicYear ?? batch?.academic_year ?? '').trim();

  if (status !== 'active') {
    return {
      id: batch?.id || null,
      school: batch?.school || null,
      name,
      grade: grade || null,
      academicYear: academicYear || null,
      studentCount,
      status: HEALTH_STATUS.INACTIVE,
      detail: 'This class is inactive and is not counted as an operational failure.',
    };
  }

  if (studentCount === 0) {
    return {
      id: batch?.id || null,
      school: batch?.school || null,
      name,
      grade: grade || null,
      academicYear: academicYear || null,
      studentCount,
      status: HEALTH_STATUS.CRITICAL,
      detail: 'This active class has no active students.',
    };
  }

  if (!grade || !academicYear) {
    return {
      id: batch?.id || null,
      school: batch?.school || null,
      name,
      grade: grade || null,
      academicYear: academicYear || null,
      studentCount,
      status: HEALTH_STATUS.WARNING,
      detail: `This active class is missing ${[!grade && 'a grade', !academicYear && 'an academic year'].filter(Boolean).join(' and ')}.`,
    };
  }

  return {
    id: batch?.id || null,
    school: batch?.school || null,
    name,
    grade,
    academicYear,
    studentCount,
    status: HEALTH_STATUS.HEALTHY,
    detail: 'Class roster and required metadata are present.',
  };
}

export function classifyWorkerHealth(worker, { now = Date.now() } = {}) {
  if (!worker) {
    return service({
      id: 'oci_processing_worker',
      name: 'OCI processing worker',
      status: HEALTH_STATUS.UNKNOWN,
      detail: 'No worker heartbeat has been recorded yet.',
      source: 'heartbeat',
    });
  }

  const lastSeenAt = worker.last_seen_at || worker.lastSeenAt || null;
  const seenAt = timestampMs(lastSeenAt);
  if (seenAt === null) {
    return service({
      id: 'oci_processing_worker',
      name: 'OCI processing worker',
      status: HEALTH_STATUS.UNKNOWN,
      detail: 'The worker heartbeat does not include a valid timestamp.',
      lastCheckedAt: lastSeenAt,
      source: 'heartbeat',
    });
  }

  const age = Math.max(0, now - seenAt);
  const workerStatus = String(worker.status || '').toLowerCase();
  if (age > WORKER_HEALTH_THRESHOLDS_MS.critical) {
    return service({
      id: 'oci_processing_worker',
      name: 'OCI processing worker',
      status: HEALTH_STATUS.CRITICAL,
      detail: 'The latest worker heartbeat is more than three minutes old.',
      lastCheckedAt: lastSeenAt,
      source: 'heartbeat',
    });
  }
  if (age > WORKER_HEALTH_THRESHOLDS_MS.warning || workerStatus === 'stopping') {
    return service({
      id: 'oci_processing_worker',
      name: 'OCI processing worker',
      status: HEALTH_STATUS.WARNING,
      detail: workerStatus === 'stopping' ? 'The worker is stopping.' : 'The worker heartbeat is older than 90 seconds.',
      lastCheckedAt: lastSeenAt,
      source: 'heartbeat',
    });
  }
  return service({
    id: 'oci_processing_worker',
    name: 'OCI processing worker',
    status: HEALTH_STATUS.HEALTHY,
    detail: worker.active_job_id || worker.activeJobId ? 'The worker is healthy and processing work.' : 'The worker is healthy and waiting for work.',
    lastCheckedAt: lastSeenAt,
    source: 'heartbeat',
  });
}

export const WORKER_FLEET_WINDOW_MS = 2 * 60 * 1_000;

/**
 * Health of the worker fleet from its heartbeat rows (newest first or not).
 * The newest heartbeat with status 'healthy' seen within the last two minutes
 * represents the fleet, and the detail counts how many healthy workers were
 * seen in that window. With no fresh healthy worker, the newest row of any
 * status is classified instead, so a lone stopping or stale worker still
 * surfaces as warning / critical rather than being hidden by an older peer.
 */
export function classifyWorkerFleetHealth(rows, { now = Date.now() } = {}) {
  const heartbeats = (rows || []).filter(Boolean).map((row) => ({ row, seenAt: timestampMs(row.last_seen_at || row.lastSeenAt) }));
  if (!heartbeats.length) return classifyWorkerHealth(null, { now });
  const byNewest = [...heartbeats].sort((left, right) => (right.seenAt ?? -1) - (left.seenAt ?? -1));
  const fresh = byNewest.filter(({ seenAt }) => seenAt !== null && now - seenAt <= WORKER_FLEET_WINDOW_MS);
  const freshHealthy = fresh.filter(({ row }) => String(row.status || '').toLowerCase() === 'healthy');
  const chosen = freshHealthy[0] || byNewest[0];
  const result = classifyWorkerHealth(chosen.row, { now });
  if (freshHealthy.length) {
    const active = freshHealthy.filter(({ row }) => row.active_job_id || row.activeJobId).length;
    const count = freshHealthy.length;
    result.detail = `${count} healthy worker${count === 1 ? '' : 's'} seen in the last 2 minutes${active ? `, ${active} processing work` : ', all waiting for work'}.`;
  }
  result.workers = { healthy: freshHealthy.length, seen: fresh.length };
  return result;
}

export function classifyRecentJobService({ id, name, job, now = Date.now() }) {
  if (!job) {
    return service({ id, name, status: HEALTH_STATUS.UNKNOWN, detail: 'No recent job result is available.', source: 'recent_job' });
  }
  const lastCheckedAt = newestTimestamp(job);
  const completedAt = timestampMs(lastCheckedAt);
  if (completedAt === null || now - completedAt > RECENT_JOB_WINDOW_MS) {
    return service({ id, name, status: HEALTH_STATUS.UNKNOWN, detail: 'No job result is available from the last 24 hours.', lastCheckedAt, source: 'recent_job' });
  }
  const status = String(job.status || '').toLowerCase();
  if (status.startsWith('failed')) {
    return service({ id, name, status: HEALTH_STATUS.CRITICAL, detail: 'The most recent processing job failed.', lastCheckedAt, source: 'recent_job' });
  }
  if (status === 'succeeded') {
    return service({ id, name, status: HEALTH_STATUS.HEALTHY, detail: 'The most recent processing job succeeded.', lastCheckedAt, source: 'recent_job' });
  }
  return service({ id, name, status: HEALTH_STATUS.UNKNOWN, detail: 'The latest processing job has not completed yet.', lastCheckedAt, source: 'recent_job' });
}

export function overallHealthStatus(items) {
  const activeItems = (items || []).filter((item) => item?.status !== HEALTH_STATUS.INACTIVE);
  if (!activeItems.length) return HEALTH_STATUS.UNKNOWN;
  return activeItems.reduce((worst, item) => (STATUS_RANK[item.status] > STATUS_RANK[worst] ? item.status : worst), HEALTH_STATUS.HEALTHY);
}

export function healthSummary(items) {
  return (items || []).reduce((summary, item) => {
    const status = item?.status || HEALTH_STATUS.UNKNOWN;
    summary[status] = (summary[status] || 0) + 1;
    return summary;
  }, {
    [HEALTH_STATUS.HEALTHY]: 0,
    [HEALTH_STATUS.WARNING]: 0,
    [HEALTH_STATUS.CRITICAL]: 0,
    [HEALTH_STATUS.UNKNOWN]: 0,
    [HEALTH_STATUS.INACTIVE]: 0,
  });
}

export function buildSystemHealth({ classes = [], services = [], generatedAt = new Date().toISOString() } = {}) {
  const classifiedClasses = classes.map(classifyClassHealth);
  const allItems = [...classifiedClasses, ...services];
  return {
    generatedAt,
    overallStatus: overallHealthStatus(allItems),
    summary: healthSummary(allItems),
    classes: classifiedClasses,
    services,
  };
}
