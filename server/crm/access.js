// Team access (grants) and audit log handlers (CRM-002, CRM-006).
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AUDIT_ACTION_NAMES } from '../../shared/crm/auditActions.js';
import { CAPABILITIES } from '../../shared/crm/capabilities.js';
import { GRANTABLE_ROLES, GRANT_PRESETS, ROLE_DEFAULTS } from '../../shared/crm/roleDefaults.js';
import { auditStatement } from './audit.js';
import { CrmHttpError, crmErrors } from './errors.js';
import { decodeCursor, listQuery, toPage } from './pagination.js';
import { ownRecordsOnly } from './permissions.js';

const userId = z.string().trim().min(1).max(128);
const capability = z.enum(CAPABILITIES);

export const grantBody = z.object({
  userId,
  capabilities: z.array(capability).max(CAPABILITIES.length).optional(),
  preset: z.enum(Object.keys(GRANT_PRESETS)).optional(),
}).refine((body) => Boolean(body.preset) !== Boolean(body.capabilities?.length), {
  message: 'Send either a preset or a list of capabilities',
});

export const revokeBody = z.object({ userId, capability });

export const auditQuery = listQuery.extend({
  action: z.enum(AUDIT_ACTION_NAMES).optional(),
  entityType: z.string().max(64).optional(),
  entityId: z.string().max(128).optional(),
});

function legacyRole(role) {
  return role === 'school_admin' ? 'admin' : role;
}

/** Active member of the scoped school whose role can hold grants, else 404/422. */
async function grantableMember(db, scope, targetUserId) {
  const result = await db.execute({
    sql: `SELECT m.role, u.display_name FROM school_memberships m
          JOIN users u ON u.id = m.user_id AND u.status = 'active'
          WHERE m.school_id = ? AND m.user_id = ? AND m.status = 'active'`,
    args: [scope.schoolId, targetUserId],
  });
  if (!result.rows.length) throw crmErrors.notFound();
  const member = result.rows.find((row) => GRANTABLE_ROLES.includes(legacyRole(row.role)));
  if (!member) {
    throw new CrmHttpError(422, 'not_grantable', 'CRM access can be granted only to teachers and staff');
  }
  return { role: legacyRole(member.role), name: member.display_name };
}

async function activeGrantsFor(db, schoolId, targetUserId) {
  const result = await db.execute({
    sql: `SELECT capability FROM crm_capability_grants
          WHERE school_id = ? AND user_id = ? AND revoked_at IS NULL ORDER BY capability`,
    args: [schoolId, targetUserId],
  });
  return result.rows.map((row) => row.capability);
}

// Teachers and staff with their default and granted capabilities.
export async function listTeam({ db, scope, input }) {
  const { limit, cursor } = input.query;
  const after = decodeCursor(cursor, 1);
  const members = await db.execute({
    sql: `SELECT u.id AS user_id, u.display_name, m.role,
                 (SELECT login_id FROM user_credentials c WHERE c.user_id = u.id AND c.is_primary = 1 AND c.status = 'active' LIMIT 1) AS username
          FROM school_memberships m
          JOIN users u ON u.id = m.user_id AND u.status = 'active'
          WHERE m.school_id = ? AND m.status = 'active' AND m.role IN ('teacher', 'staff')
            ${after ? 'AND u.id > ?' : ''}
          ORDER BY u.id
          LIMIT ?`,
    args: [scope.schoolId, ...(after || []), limit + 1],
  });
  const page = toPage(members.rows, limit, (row) => [row.user_id]);
  const ids = page.items.map((row) => row.user_id);
  const grants = ids.length
    ? (await db.execute({
      sql: `SELECT user_id, capability FROM crm_capability_grants
            WHERE school_id = ? AND revoked_at IS NULL AND user_id IN (${ids.map(() => '?').join(', ')})
            ORDER BY capability`,
      args: [scope.schoolId, ...ids],
    })).rows
    : [];
  return {
    items: page.items.map((row) => ({
      userId: row.user_id,
      name: row.display_name,
      username: row.username || null,
      role: row.role,
      defaults: [...(ROLE_DEFAULTS[row.role] || [])],
      grants: grants.filter((grant) => grant.user_id === row.user_id).map((grant) => grant.capability),
    })),
    nextCursor: page.nextCursor,
    presets: Object.entries(GRANT_PRESETS).map(([key, preset]) => ({ key, label: preset.label, capabilities: [...preset.capabilities] })),
  };
}

export async function grantAccess({ db, scope, input }) {
  const { userId: targetUserId, preset } = input.body;
  const requested = preset ? GRANT_PRESETS[preset].capabilities : input.body.capabilities;
  // Nobody can hand out access they do not hold themselves, and access held
  // only for one's own records cannot be handed out school-wide.
  const missing = requested.filter((cap) => !scope.capabilities.has(cap) || ownRecordsOnly(scope, cap));
  if (missing.length) throw crmErrors.forbidden();
  await grantableMember(db, scope, targetUserId);

  const now = new Date().toISOString();
  const statements = [];
  for (const cap of [...new Set(requested)]) {
    statements.push(
      {
        sql: `INSERT INTO crm_capability_grants (id, school_id, user_id, capability, granted_by, created_at, updated_at)
              SELECT ?, ?, ?, ?, ?, ?, ?
              WHERE NOT EXISTS (SELECT 1 FROM crm_capability_grants
                                WHERE school_id = ? AND user_id = ? AND capability = ? AND revoked_at IS NULL)`,
        args: [randomUUID(), scope.schoolId, targetUserId, cap, scope.actor.user_id, now, now, scope.schoolId, targetUserId, cap],
      },
      auditStatement(scope, {
        action: 'permission.granted',
        entityId: targetUserId,
        summary: preset ? { capability: cap, preset } : { capability: cap },
        onlyIfChanged: true,
        now,
      }),
    );
  }
  await db.batch(statements, 'write');
  return { userId: targetUserId, grants: await activeGrantsFor(db, scope.schoolId, targetUserId) };
}

export async function revokeAccess({ db, scope, input }) {
  const { userId: targetUserId, capability: cap } = input.body;
  await grantableMember(db, scope, targetUserId);
  const now = new Date().toISOString();
  await db.batch([
    {
      sql: `UPDATE crm_capability_grants SET revoked_at = ?, revoked_by = ?, updated_at = ?
            WHERE school_id = ? AND user_id = ? AND capability = ? AND revoked_at IS NULL`,
      args: [now, scope.actor.user_id, now, scope.schoolId, targetUserId, cap],
    },
    auditStatement(scope, { action: 'permission.revoked', entityId: targetUserId, summary: { capability: cap }, onlyIfChanged: true, now }),
  ], 'write');
  return { userId: targetUserId, grants: await activeGrantsFor(db, scope.schoolId, targetUserId) };
}

export async function listAudit({ db, scope, input }) {
  const { limit, cursor, action, entityType, entityId } = input.query;
  const after = decodeCursor(cursor, 2);
  const clauses = ['e.school_id = ?'];
  const args = [scope.schoolId];
  if (action) { clauses.push('e.action = ?'); args.push(action); }
  if (entityType) { clauses.push('e.entity_type = ?'); args.push(entityType); }
  if (entityId) { clauses.push('e.entity_id = ?'); args.push(entityId); }
  if (after) { clauses.push('(e.created_at < ? OR (e.created_at = ? AND e.id < ?))'); args.push(after[0], after[0], after[1]); }
  const result = await db.execute({
    sql: `SELECT e.id, e.actor_user_id, e.actor_role, e.entity_type, e.entity_id, e.action, e.summary_json, e.created_at,
                 u.display_name AS actor_name
          FROM crm_audit_events e
          LEFT JOIN users u ON u.id = e.actor_user_id
          WHERE ${clauses.join(' AND ')}
          ORDER BY e.created_at DESC, e.id DESC
          LIMIT ?`,
    args: [...args, limit + 1],
  });
  return toPage(result.rows, limit, (row) => [row.created_at, row.id], (row) => ({
    id: row.id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    actor: { userId: row.actor_user_id, name: row.actor_name || null, role: row.actor_role },
    summary: JSON.parse(row.summary_json || '{}'),
    createdAt: row.created_at,
  }));
}
