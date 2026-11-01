// School members who can be given CRM records (lead owners now, task owners
// in S2). An owner must hold an active membership in the scoped school and
// the capability the record needs (CRM_CONTRACTS §1.10).
import { effectiveCapabilities } from '../../shared/crm/roleDefaults.js';
import { CrmHttpError } from './errors.js';

const STAFF_ROLES = ['school_admin', 'admin', 'teacher', 'staff'];

function legacyRole(role) {
  return role === 'school_admin' ? 'admin' : role;
}

/** Active staff-side members of the school with their effective CRM capabilities. */
export async function crmMembers(db, schoolId, { userIds = null } = {}) {
  const filter = userIds ? `AND u.id IN (${userIds.map(() => '?').join(', ')})` : '';
  const members = await db.execute({
    sql: `SELECT u.id AS user_id, u.display_name, m.role
          FROM school_memberships m
          JOIN users u ON u.id = m.user_id AND u.status = 'active'
          WHERE m.school_id = ? AND m.status = 'active'
            AND m.role IN (${STAFF_ROLES.map(() => '?').join(', ')}) ${filter}
          ORDER BY u.display_name, u.id`,
    args: [schoolId, ...STAFF_ROLES, ...(userIds || [])],
  });
  if (!members.rows.length) return [];
  const grants = await db.execute({
    sql: 'SELECT user_id, capability FROM crm_capability_grants WHERE school_id = ? AND revoked_at IS NULL',
    args: [schoolId],
  });
  const grantsByUser = new Map();
  for (const row of grants.rows) {
    if (!grantsByUser.has(row.user_id)) grantsByUser.set(row.user_id, []);
    grantsByUser.get(row.user_id).push(row.capability);
  }
  const seen = new Set();
  return members.rows.filter((row) => !seen.has(row.user_id) && seen.add(row.user_id)).map((row) => {
    const role = legacyRole(row.role);
    return {
      userId: row.user_id,
      name: row.display_name || null,
      role,
      capabilities: effectiveCapabilities(role, grantsByUser.get(row.user_id) || []),
    };
  });
}

/** Members holding `capability`, for owner pickers. */
export async function membersWith(db, schoolId, capability) {
  return (await crmMembers(db, schoolId))
    .filter((member) => member.capabilities.has(capability))
    .map(({ userId, name, role }) => ({ userId, name, role }));
}

/** Throws 422 `invalid_owner` unless `userId` is an active member holding `capability`. */
export async function assertAssignable(db, schoolId, userId, capability) {
  const [member] = await crmMembers(db, schoolId, { userIds: [userId] });
  if (!member || !member.capabilities.has(capability)) {
    throw new CrmHttpError(422, 'invalid_owner', 'Choose an active team member who can work on this record', [{ path: 'ownerUserId', message: 'Not an eligible owner' }]);
  }
  return member;
}
