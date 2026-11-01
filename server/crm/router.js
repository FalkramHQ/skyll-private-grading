// CRM API entry, mounted at /api/auth/crm/* by the auth catch-all (no new
// serverless function). Every request runs the same chain:
//   authenticate (401) → match route (404/405) → school scope + flag (400/404)
//   → capability (403) → validate (422) → idempotency replay → handler.
// Platform staff requests also write a `support.session` audit event.
// Public routes (the inquiry form) skip the session: their handlers resolve the
// school from the URL themselves and validate the body only after that.
import { database, sessionForRequest } from '../../api/_lib/auth.js';
import { recordSupportSession } from './audit.js';
import { CrmHttpError, crmErrors, sendCrmError } from './errors.js';
import { findReplay, idempotencyKey, requestHash, storeReplay } from './idempotency.js';
import { can } from './permissions.js';
import { CRM_ROUTES } from './routes.js';
import { resolveCrmScope } from './scope.js';
import { parseInput } from './validation.js';

function matchRoute(routes, method, path) {
  const candidates = routes.filter((route) => route.path === path);
  if (!candidates.length) throw crmErrors.notFound();
  const route = candidates.find((candidate) => candidate.method === method);
  if (!route) throw crmErrors.methodNotAllowed();
  return route;
}

async function handlePublicRoute(req, res, route) {
  const { route: _routeParam, ...query } = req.query || {};
  const input = { query: route.query ? parseInput(route.query, query) : {}, body: {} };
  const result = await route.handler({ req, res, db: database(), input });
  if (res.headersSent || res.writableEnded) return undefined;
  return res.status(route.status || 200).json(result ?? {});
}

export async function handleCrmRequest(req, res, segments = [], { routes = CRM_ROUTES } = {}) {
  try {
    const path = segments.join('/');
    if (routes.some((candidate) => candidate.public && candidate.path === path)) {
      return await handlePublicRoute(req, res, matchRoute(routes.filter((candidate) => candidate.public), req.method, path));
    }

    const actor = await sessionForRequest(req);
    if (!actor) throw crmErrors.unauthenticated();

    const route = matchRoute(routes.filter((candidate) => !candidate.public), req.method, path);

    let scope = null;
    if (route.platform) {
      if (actor.role !== 'skyll_admin') throw crmErrors.forbidden();
    } else {
      scope = await resolveCrmScope(req, actor);
      if (route.capability && !can(scope, route.capability)) throw crmErrors.forbidden();
      await recordSupportSession(database(), scope);
    }

    // `route` is the catch-all path parameter, not client input.
    const { route: _routeParam, ...query } = req.query || {};
    const input = {
      query: route.query ? parseInput(route.query, query) : {},
      body: route.body ? parseInput(route.body, req.body) : {},
    };

    const db = database();
    const key = route.idempotent && scope ? idempotencyKey(req) : null;
    const hash = key ? requestHash(req.method, route.path, input.body) : null;
    if (key) {
      const replay = await findReplay(db, scope, key, hash);
      if (replay) return res.status(replay.status).json(replay.body);
    }

    const result = await route.handler({ req, res, db, actor, scope, input });
    if (res.headersSent || res.writableEnded) return undefined;
    const status = route.status || 200;
    if (key) await storeReplay(db, scope, key, hash, status, result);
    return res.status(status).json(result ?? {});
  } catch (error) {
    if (!(error instanceof CrmHttpError) && error?.message === 'Database not configured') {
      return sendCrmError(res, new CrmHttpError(503, 'unavailable', 'Service unavailable'));
    }
    return sendCrmError(res, error);
  }
}
