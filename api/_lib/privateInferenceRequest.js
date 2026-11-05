// Gives a Vercel request the same private-inference routing a worker job has: the
// signed-in user's school decides whether its model calls go to NEAR AI only.

import { database, sessionForRequest } from './auth.js';
import { nearPrivateEnabledForContext, runWithInferenceContext } from '../../apps/processing-worker/inferenceContext.js';

let sinkReady = false;

/**
 * Platform staff can name any school in a request, so once a school is opted in their
 * calls all take the private path. That costs nothing and cannot route one wrongly.
 */
export function inferenceContextForUser(user, jobType) {
  return {
    school: user?.school || '',
    schoolId: user?.school_id || null,
    jobType,
    forcePrivate: user?.role === 'skyll_admin',
  };
}

/** Points receipts at the database before the first private call in this instance. */
export async function enablePrivateInferenceFor(context) {
  if (sinkReady || !nearPrivateEnabledForContext(context)) return;
  const [{ setPrivateInferenceSink }, { privateInferenceDbSink }] = await Promise.all([
    import('../../apps/processing-worker/nearPrivateInference.js'),
    import('../../apps/processing-worker/privateInferenceSink.js'),
  ]);
  setPrivateInferenceSink(privateInferenceDbSink(database()));
  sinkReady = true;
}

/** Runs a route inside its user's context. With no school opted in, nothing changes. */
export async function withRequestInferenceContext(req, jobType, handler) {
  if (!String(process.env.NEAR_AI_SCHOOLS || '').trim()) return handler();
  // A failed lookup leaves no user: the route's own auth check answers before any model call.
  const user = await sessionForRequest(req).catch(() => null);
  const context = inferenceContextForUser(user, jobType);
  await enablePrivateInferenceFor(context);
  return runWithInferenceContext(context, handler);
}
