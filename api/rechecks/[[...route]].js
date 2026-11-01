import { createClient } from '@libsql/client/web';
import { ensureAuthTables, requireUser } from '../_lib/auth.js';
import { tursoAuthToken, tursoUrl } from '../_lib/env.js';
import { createRecheck, listRechecks, RecheckContractError } from '../_lib/recheckCollectionService.js';
import { transitionRecheck } from '../_lib/recheckTransitionService.js';
import { internalError } from '../_lib/httpError.js';
import { handleCors } from '../_lib/cors.js';

const client = tursoUrl ? createClient({ url: tursoUrl, authToken: tursoAuthToken }) : null;

function routeId(req) {
  const route = req.query?.route;
  return Array.isArray(route) ? route[0] : route;
}

async function listOrCreate(db, req, res, actor) {
  if (req.method === 'GET') {
    return res.status(200).json({ requests: await listRechecks(db, actor, req.query) });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  return res.status(201).json({ request: await createRecheck(db, actor, req.body) });
}

async function update(db, req, res, actor, id) {
  if (req.method !== 'PATCH') return res.status(405).json({ error: 'Method not allowed' });
  return res.status(200).json({ request: await transitionRecheck(db, actor, id, req.body) });
}

export function createRecheckHttpHandler({
  db = client,
  ensureTables = ensureAuthTables,
  authenticate = requireUser,
} = {}) {
  return async function recheckHttpHandler(req, res) {
    if (handleCors(req, res)) return;
    if (!db) return res.status(500).json({ error: 'Database not configured' });
    try {
      await ensureTables();
      const actor = await authenticate(req, res);
      if (!actor) return;
      // Defense in depth: the services remain the source of truth for the
      // per-action role contract, but the HTTP layer must never pass an actor
      // with a role the contract does not permit at all.
      const id = routeId(req);
      if (id === '_collection') return await listOrCreate(db, req, res, actor);
      const updateRoles = ['teacher', 'admin', 'skyll_admin'];
      if (id && req.method === 'PATCH' && !updateRoles.includes(actor.role)) {
        return res.status(403).json({ error: 'You do not have permission for this action' });
      }
      if (!['student', 'teacher', 'admin', 'skyll_admin'].includes(actor.role)) {
        return res.status(403).json({ error: 'You do not have permission for this action' });
      }
      return id
        ? await update(db, req, res, actor, id)
        : await listOrCreate(db, req, res, actor);
    } catch (error) {
      if (error instanceof RecheckContractError) {
        return res.status(error.status).json({ error: error.message, ...error.details });
      }
      return internalError(res, error, 'rechecks');
    }
  };
}

export default createRecheckHttpHandler();
