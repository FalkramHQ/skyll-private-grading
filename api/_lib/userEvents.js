import { randomUUID } from 'node:crypto';

export const TRACKABLE_EVENTS = Object.freeze([
  'login',
  'report_viewed',
  'subject_viewed',
  'dna_viewed',
  'hive_viewed',
  'question_opened',
  'recheck_requested',
  'practice_started',
  'practice_completed',
  'tutor_opened',
  'tutor_message',
  'profile_viewed',
  'teacher_dashboard_viewed',
  'class_insights_viewed',
  'school_profile_viewed',
]);

const MAX_DATA_BYTES = 2048;

function text(value, max = 120) {
  return String(value || '').trim().slice(0, max);
}

export function normalizeEventType(value) {
  const type = text(value, 64).toLowerCase();
  return TRACKABLE_EVENTS.includes(type) ? type : null;
}

export function normalizeEventData(value) {
  if (value == null) return '{}';
  let payload = value;
  if (typeof value === 'string') {
    try { payload = JSON.parse(value); } catch { return '{}'; }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '{}';
  const json = JSON.stringify(payload);
  return json.length > MAX_DATA_BYTES ? '{}' : json;
}

export async function recordUserEvent(db, {
  user = {},
  eventType,
  eventData = {},
  platform = 'web',
  now = new Date().toISOString(),
  id = null,
} = {}) {
  const type = normalizeEventType(eventType);
  if (!type) return null;
  const eventId = id || `evt_${randomUUID()}`;
  await db.execute({
    sql: `INSERT INTO user_events (
            id, user_id, username, role, school_id, school,
            event_type, event_data, platform, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      eventId,
      text(user.user_id || user.id, 80) || null,
      text(user.username, 120) || null,
      text(user.role, 40) || null,
      text(user.school_id || user.schoolId, 80) || null,
      text(user.school, 160) || null,
      type,
      normalizeEventData(eventData),
      text(platform, 40) || 'web',
      now,
    ],
  });
  return eventId;
}

/** Best-effort login telemetry — never fails the auth response. */
export async function recordLoginEventSafe(db, user, platform = 'web') {
  try {
    await recordUserEvent(db, { user, eventType: 'login', platform, eventData: { source: 'auth' } });
  } catch {
    // Telemetry must never block sign-in.
  }
}

function schoolScope(user) {
  if (user.role === 'skyll_admin') return { clause: '', args: [] };
  return { clause: 'AND school = ?', args: [user.school] };
}

async function distinctUsers(db, { eventType = null, since, until = null, schoolClause, schoolArgs }) {
  const args = [since];
  let sql = `SELECT COUNT(DISTINCT COALESCE(user_id, username)) AS n
             FROM user_events
             WHERE created_at >= ?`;
  if (until) {
    sql += ' AND created_at < ?';
    args.push(until);
  }
  if (eventType) {
    sql += ' AND event_type = ?';
    args.push(eventType);
  }
  sql += ` ${schoolClause}`;
  args.push(...schoolArgs);
  const result = await db.execute({ sql, args });
  return Number(result.rows[0]?.n || 0);
}

export async function buildProductMetrics(db, user, { now = new Date() } = {}) {
  const scope = schoolScope(user);
  const iso = (date) => date.toISOString();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const eightDaysAgo = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);
  const fifteenDaysAgo = new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000);

  const [dau, mau, weekActive, logins7d, reports7d, dna7d, hive7d] = await Promise.all([
    distinctUsers(db, { since: iso(dayAgo), schoolClause: scope.clause, schoolArgs: scope.args }),
    distinctUsers(db, { since: iso(monthAgo), schoolClause: scope.clause, schoolArgs: scope.args }),
    distinctUsers(db, { since: iso(weekAgo), schoolClause: scope.clause, schoolArgs: scope.args }),
    distinctUsers(db, { eventType: 'login', since: iso(weekAgo), schoolClause: scope.clause, schoolArgs: scope.args }),
    distinctUsers(db, { eventType: 'report_viewed', since: iso(weekAgo), schoolClause: scope.clause, schoolArgs: scope.args }),
    distinctUsers(db, { eventType: 'dna_viewed', since: iso(weekAgo), schoolClause: scope.clause, schoolArgs: scope.args }),
    distinctUsers(db, { eventType: 'hive_viewed', since: iso(weekAgo), schoolClause: scope.clause, schoolArgs: scope.args }),
  ]);

  const funnelMonth = await Promise.all([
    distinctUsers(db, { eventType: 'login', since: iso(monthAgo), schoolClause: scope.clause, schoolArgs: scope.args }),
    distinctUsers(db, { eventType: 'report_viewed', since: iso(monthAgo), schoolClause: scope.clause, schoolArgs: scope.args }),
    distinctUsers(db, { eventType: 'dna_viewed', since: iso(monthAgo), schoolClause: scope.clause, schoolArgs: scope.args }),
    distinctUsers(db, { eventType: 'hive_viewed', since: iso(monthAgo), schoolClause: scope.clause, schoolArgs: scope.args }),
  ]);

  // D7 retention proxy: users who logged in 8–15 days ago and logged in again in the last 7 days.
  const cohortResult = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM (
            SELECT DISTINCT COALESCE(c.user_id, c.username) AS uid
            FROM user_events c
            WHERE c.event_type = 'login'
              AND c.created_at >= ? AND c.created_at < ?
              ${user.role === 'skyll_admin' ? '' : 'AND c.school = ?'}
              AND EXISTS (
                SELECT 1 FROM user_events later
                WHERE later.event_type = 'login'
                  AND COALESCE(later.user_id, later.username) = COALESCE(c.user_id, c.username)
                  AND later.created_at >= ?
                  ${user.role === 'skyll_admin' ? '' : 'AND later.school = ?'}
              )
          )`,
    args: user.role === 'skyll_admin'
      ? [iso(fifteenDaysAgo), iso(eightDaysAgo), iso(weekAgo)]
      : [iso(fifteenDaysAgo), iso(eightDaysAgo), user.school, iso(weekAgo), user.school],
  });
  const cohortSize = await distinctUsers(db, {
    eventType: 'login',
    since: iso(fifteenDaysAgo),
    until: iso(eightDaysAgo),
    schoolClause: scope.clause,
    schoolArgs: scope.args,
  });
  const retained = Number(cohortResult.rows[0]?.n || 0);

  const byType = await db.execute({
    sql: `SELECT event_type, COUNT(*) AS events, COUNT(DISTINCT COALESCE(user_id, username)) AS users
          FROM user_events
          WHERE created_at >= ? ${scope.clause}
          GROUP BY event_type
          ORDER BY events DESC`,
    args: [iso(weekAgo), ...scope.args],
  });

  const bySchool = user.role === 'skyll_admin'
    ? await db.execute({
      sql: `SELECT school, COUNT(DISTINCT COALESCE(user_id, username)) AS mau
            FROM user_events
            WHERE created_at >= ? AND school IS NOT NULL AND school != ''
            GROUP BY school
            ORDER BY mau DESC
            LIMIT 12`,
      args: [iso(monthAgo)],
    })
    : { rows: [] };

  const recent = await db.execute({
    sql: `SELECT event_type, username, role, school, platform, created_at
          FROM user_events
          WHERE created_at >= ? ${scope.clause}
          ORDER BY created_at DESC
          LIMIT 25`,
    args: [iso(weekAgo), ...scope.args],
  });

  return {
    generatedAt: iso(now),
    scope: user.role === 'skyll_admin' ? 'platform' : 'school',
    kpis: {
      dau,
      wau: weekActive,
      mau,
      dauMauRatio: mau ? Number((dau / mau).toFixed(3)) : 0,
      retentionD7: {
        cohortSize,
        retained,
        rate: cohortSize ? Number((retained / cohortSize).toFixed(3)) : 0,
      },
    },
    funnel7d: {
      login: logins7d,
      reportViewed: reports7d,
      dnaViewed: dna7d,
      hiveViewed: hive7d,
      reportToDna: reports7d ? Number((dna7d / reports7d).toFixed(3)) : 0,
    },
    funnel30d: {
      login: funnelMonth[0],
      reportViewed: funnelMonth[1],
      dnaViewed: funnelMonth[2],
      hiveViewed: funnelMonth[3],
      reportToDna: funnelMonth[1] ? Number((funnelMonth[2] / funnelMonth[1]).toFixed(3)) : 0,
    },
    events7d: byType.rows.map((row) => ({
      eventType: row.event_type,
      events: Number(row.events || 0),
      users: Number(row.users || 0),
    })),
    schoolsMau: bySchool.rows.map((row) => ({ school: row.school, mau: Number(row.mau || 0) })),
    recent: recent.rows,
  };
}
