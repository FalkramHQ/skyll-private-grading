// Server-side CRM authorisation (CRM-002). Handlers call `can()`; nothing
// compares role names outside shared/crm/roleDefaults.js.
import { OWN_RECORDS_ONLY, canReceiveGrants, effectiveCapabilities } from '../../shared/crm/roleDefaults.js';
import { crmErrors } from './errors.js';

export async function activeGrants(db, schoolId, userId, role) {
  if (!userId || !canReceiveGrants(role)) return [];
  const result = await db.execute({
    sql: `SELECT capability FROM crm_capability_grants
          WHERE school_id = ? AND user_id = ? AND revoked_at IS NULL`,
    args: [schoolId, userId],
  });
  return result.rows.map((row) => row.capability);
}

export async function loadCapabilities(db, schoolId, actor) {
  const grants = await activeGrants(db, schoolId, actor.user_id, actor.role);
  return { capabilities: effectiveCapabilities(actor.role, grants), grants: new Set(grants) };
}

/**
 * `context.batchId` is accepted now so teacher scope can later narrow to their
 * own classes without touching call sites (D5). Today it does not restrict.
 */
// eslint-disable-next-line no-unused-vars
export function can(scope, capability, context = {}) {
  return Boolean(scope?.capabilities?.has(capability));
}

/**
 * True when the actor holds `capability` only for records they own: the role
 * default is own-records-only (e.g. teacher tasks) and no explicit grant widens
 * it to the whole school (CRM_CONTRACTS §2.3, D11).
 */
export function ownRecordsOnly(scope, capability) {
  const limited = OWN_RECORDS_ONLY[scope?.actor?.role]?.includes(capability);
  return Boolean(limited && !scope.grants?.has(capability));
}

export function assertCan(scope, capability, context) {
  if (!can(scope, capability, context)) throw crmErrors.forbidden();
}
