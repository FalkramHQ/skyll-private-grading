// CRM audit events (CRM-006). Handlers never INSERT into crm_audit_events
// directly: they add `auditStatement(...)` to the same `db.batch` as the
// business write, so both commit or neither does.
import { randomBytes } from 'node:crypto';
import { AUDIT_ACTIONS, buildAuditSummary } from '../../shared/crm/auditActions.js';

const SUPPORT_SESSION_WINDOW_MS = 12 * 60 * 60 * 1000;

let lastMs = 0;
let sequence = 0;

/**
 * Time-ordered ids (ms timestamp + per-process sequence + random), so events
 * sharing a `created_at` still list in write order when sorted by id.
 */
export function auditEventId(nowMs = Date.now()) {
  if (nowMs === lastMs) sequence += 1;
  else { lastMs = nowMs; sequence = 0; }
  return `aud_${nowMs.toString(36).padStart(9, '0')}${sequence.toString(36).padStart(4, '0')}${randomBytes(6).toString('hex')}`;
}

function actorRole(scope) {
  return scope.support ? 'skyll_admin' : scope.actor.role;
}

/**
 * Builds the INSERT for one audit event. With `onlyIfChanged`, the row is
 * written only when the previous statement in the batch changed a row, so a
 * no-op write never produces an audit event. With `when` (`{ sql, args }`), it
 * is written only if that SQL condition holds when the statement runs. With
 * `computed` (`{ key, sql, args }`), that summary field is filled from SQL as
 * the row is written (a value the same batch has just created, such as an
 * invoice number); `summary[key]` must hold a placeholder that passes the schema.
 */
export function auditStatement(scope, { action, entityId, entityType, summary = {}, requestId = null, onlyIfChanged = false, when = null, computed = null, now = new Date().toISOString() }) {
  const definition = AUDIT_ACTIONS[action];
  const values = [
    auditEventId(Date.parse(now) || Date.now()),
    scope.schoolId,
    scope.actor.user_id || null,
    actorRole(scope),
    entityType || definition?.entityType,
    String(entityId),
    action,
    JSON.stringify(buildAuditSummary(action, summary)),
    requestId,
    now,
  ];
  const columns = '(id, school_id, actor_user_id, actor_role, entity_type, entity_id, action, summary_json, request_id, created_at)';
  if (computed) {
    // `computed.sql` is server-written SQL only, never request input.
    if (!/^[A-Za-z]+$/.test(computed.key) || !(computed.key in summary)) throw new Error(`Invalid computed audit key: ${computed.key}`);
    const condition = when || (onlyIfChanged ? { sql: 'changes() > 0', args: [] } : { sql: '1', args: [] });
    return {
      sql: `INSERT INTO crm_audit_events ${columns} SELECT ?, ?, ?, ?, ?, ?, ?, json_set(?, '$.${computed.key}', ${computed.sql}), ?, ? WHERE ${condition.sql}`,
      args: [...values.slice(0, 8), ...computed.args, ...values.slice(8), ...condition.args],
    };
  }
  if (when) {
    return {
      sql: `INSERT INTO crm_audit_events ${columns} SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${when.sql}`,
      args: [...values, ...when.args],
    };
  }
  if (onlyIfChanged) {
    return {
      sql: `INSERT INTO crm_audit_events ${columns} SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() > 0`,
      args: values,
    };
  }
  return { sql: `INSERT INTO crm_audit_events ${columns} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, args: values };
}

/**
 * Records that platform staff opened a school's CRM. Written at most once per
 * actor, school, and 12-hour window so the log stays readable.
 */
export async function recordSupportSession(db, scope, now = new Date()) {
  if (!scope?.support) return false;
  const since = new Date(now.getTime() - SUPPORT_SESSION_WINDOW_MS).toISOString();
  const recent = await db.execute({
    sql: `SELECT 1 FROM crm_audit_events
          WHERE school_id = ? AND actor_user_id = ? AND action = 'support.session' AND created_at > ?
          LIMIT 1`,
    args: [scope.schoolId, scope.actor.user_id || null, since],
  });
  if (recent.rows.length) return false;
  const statement = auditStatement(scope, { action: 'support.session', entityId: scope.schoolId, now: now.toISOString() });
  await db.execute(statement);
  return true;
}
