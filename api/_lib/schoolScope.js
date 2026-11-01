import { resolveSchoolId } from './canonicalSubmissions.js';

/**
 * Does `actor` belong to the school that owns a resource? (FLKRM-389)
 *
 * Compares school ids, never display names: the actor's id is the school
 * pinned on their session, and the resource's comes from its own school_id
 * or, for legacy rows that only carry a name, from resolveSchoolId — which
 * returns null for an unknown or ambiguous name, so the check fails closed.
 * Platform-admin bypasses stay explicit at each call site.
 */
export async function inActorSchool(db, actor, { schoolId = null, schoolName = null } = {}) {
  const actorSchoolId = actor?.school_id || null;
  if (!actorSchoolId) return false;
  const resourceSchoolId = schoolId || (schoolName ? await resolveSchoolId(db, schoolName) : null);
  return Boolean(resourceSchoolId) && resourceSchoolId === actorSchoolId;
}
