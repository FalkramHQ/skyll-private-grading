import { ensureAuthTables, requireUser } from '../../api/_lib/auth.js';
import { schoolFeaturesForActor } from '../../api/_lib/featureFlags.js';
import { internalError } from '../../api/_lib/httpError.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    await ensureAuthTables();
    // Feature flags are the actor's own school-scoped, non-sensitive booleans:
    // schoolFeaturesForActor() scopes by school_id and only bypasses for
    // platform staff. Every authenticated role must be able to read them —
    // including the mobile 'scanner' role and the web 'teacher' role, which a
    // tight allow-list previously rejected with a 403 on every app launch.
    // Unauthenticated callers still get 401 from requireUser.
    const actor = await requireUser(req, res);
    if (!actor) return;
    return res.status(200).json({ features: await schoolFeaturesForActor(actor) });
  } catch (error) {
    return internalError(res, error, 'auth-features');
  }
}
