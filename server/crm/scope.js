// CRM request scope. The school always comes from the session, except that
// platform staff (skyll_admin) choose one explicitly with `X-Skyll-School`.
// Every other caller's header is ignored.
import { database } from '../../api/_lib/auth.js';
import { isSchoolFeatureEnabled } from '../../api/_lib/featureFlags.js';
import { effectiveCapabilities } from '../../shared/crm/roleDefaults.js';
import { DEFAULT_TIMEZONE } from '../../shared/crm/time.js';
import { crmErrors } from './errors.js';
import { loadCapabilities } from './permissions.js';

export const SUPPORT_SCHOOL_HEADER = 'x-skyll-school';
const SCHOOL_ID = /^[A-Za-z0-9_-]{1,64}$/;

function requestedSchoolId(req) {
  const headers = req.headers || {};
  const value = headers[SUPPORT_SCHOOL_HEADER] ?? headers['X-Skyll-School'];
  return typeof value === 'string' ? value.trim() : '';
}

async function activeSchool(schoolId) {
  const result = await database().execute({
    sql: "SELECT id, display_name, timezone FROM schools WHERE id = ? AND status = 'active'",
    args: [schoolId],
  });
  return result.rows[0] || null;
}

/**
 * Resolves `{ schoolId, schoolName, actor, capabilities, support }` or throws:
 * 400 when skyll_admin has not chosen a school, 404 when the school does not
 * exist or the CRM is off for it.
 */
export async function resolveCrmScope(req, actor) {
  if (actor.role === 'skyll_admin') {
    const schoolId = requestedSchoolId(req);
    if (!schoolId) throw crmErrors.schoolRequired();
    if (!SCHOOL_ID.test(schoolId)) throw crmErrors.notFound();
    const school = await activeSchool(schoolId);
    if (!school) throw crmErrors.notFound();
    // Platform staff bypass the flag so they can verify before rollout.
    return {
      schoolId: school.id,
      schoolName: school.display_name,
      timezone: school.timezone || DEFAULT_TIMEZONE,
      actor,
      capabilities: effectiveCapabilities(actor.role),
      grants: new Set(),
      support: true,
    };
  }

  if (!actor.school_id) throw crmErrors.notFound();
  if (!(await isSchoolFeatureEnabled(actor, 'crm'))) throw crmErrors.notFound();
  const school = await activeSchool(actor.school_id);
  const { capabilities, grants } = await loadCapabilities(database(), actor.school_id, actor);
  return {
    schoolId: actor.school_id,
    schoolName: actor.school,
    timezone: school?.timezone || DEFAULT_TIMEZONE,
    actor,
    capabilities,
    grants,
    support: false,
  };
}
