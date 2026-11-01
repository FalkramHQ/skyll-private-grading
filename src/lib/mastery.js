import { apiGet } from './apiClient';

export const MASTERY_BANDS = { ready: 0.75, developing: 0.5 };

export function masteryStatus(theta) {
  const t = Number(theta) || 0;
  if (t >= MASTERY_BANDS.ready) return 'ready';
  if (t >= MASTERY_BANDS.developing) return 'developing';
  return 'at_risk';
}

export function getMastery({ studentId, username, subject } = {}) {
  const params = new URLSearchParams();
  if (studentId) params.set('studentId', studentId);
  if (username) params.set('username', username);
  if (subject) params.set('subject', subject);
  const suffix = params.toString() ? `?${params}` : '';
  return apiGet(`/api/ai/mastery${suffix}`, 'Could not load mastery');
}

// Route rows -> panel rows. Weakest first; wide rows keep their theta but lose CI.
export function normalizeMasteryRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const thetaMean = Math.min(1, Math.max(0, Number(row.thetaMean) || 0));
      const ciLow = row.ciLow == null ? null : Math.min(1, Math.max(0, Number(row.ciLow)));
      const ciHigh = row.ciHigh == null ? null : Math.min(1, Math.max(0, Number(row.ciHigh)));
      return {
        kcId: row.kcId,
        kcLabel: row.kcLabel || row.kcId,
        subject: row.subject || 'General',
        thetaMean,
        pct: Math.round(thetaMean * 100),
        ciLow,
        ciHigh,
        hasCi: Number.isFinite(ciLow) && Number.isFinite(ciHigh),
        wide: Boolean(row.wide ?? (row.ciLow == null || row.ciHigh == null)),
        evidenceCount: Number(row.evidenceCount) || 0,
        status: masteryStatus(thetaMean),
        lastSignalAt: row.lastSignalAt || null,
      };
    })
    .sort((a, b) => a.thetaMean - b.thetaMean);
}

export function groupMasteryBySubject(rows) {
  const bySubject = new Map();
  for (const row of rows) {
    const list = bySubject.get(row.subject) || [];
    list.push(row);
    bySubject.set(row.subject, list);
  }
  return [...bySubject.entries()]
    .map(([subject, list]) => ({ subject, rows: list }))
    .sort((a, b) => a.subject.localeCompare(b.subject));
}
