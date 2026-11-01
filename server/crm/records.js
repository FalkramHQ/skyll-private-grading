// Access to the CRM records that notes, tags, tasks and timelines hang off
// (FLKRM-326). A lead needs lead access; a student needs student access. The
// record must belong to the scoped school, otherwise it is simply not found.
import { crmErrors } from './errors.js';
import { can } from './permissions.js';

const CAPABILITIES = {
  lead: { read: 'crm.leads.read', write: 'crm.leads.write' },
  student: { read: 'crm.students.read', write: 'crm.students.write' },
};

export function recordCapability(entityType, mode) {
  return CAPABILITIES[entityType][mode];
}

export function canAccessRecord(scope, entityType, mode) {
  return can(scope, recordCapability(entityType, mode));
}

/** 403 without the capability, 404 when the record is not a live record of this school. */
export async function assertRecord(db, scope, entityType, entityId, mode) {
  if (!canAccessRecord(scope, entityType, mode)) throw crmErrors.forbidden();
  const result = await db.execute({
    sql: entityType === 'lead'
      ? 'SELECT 1 FROM crm_leads WHERE id = ? AND school_id = ? AND archived_at IS NULL'
      : "SELECT 1 FROM students WHERE id = ? AND school_id = ? AND status != 'archived'",
    args: [entityId, scope.schoolId],
  });
  if (!result.rows.length) throw crmErrors.notFound();
}

/** Marks a lead as recently active (notes, tags). Not a versioned field. */
export function touchStatement(scope, entityType, entityId, now) {
  if (entityType !== 'lead') return null;
  return {
    sql: 'UPDATE crm_leads SET last_activity_at = ? WHERE id = ? AND school_id = ?',
    args: [now, entityId, scope.schoolId],
  };
}
