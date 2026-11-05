// Which school's data a model call carries, so the gateways can route an
// opted-in school to NEAR AI private inference. Kept free of the verifier's
// dependencies so the API gateway can import it cheaply.

import { AsyncLocalStorage } from 'node:async_hooks';

const inferenceContext = new AsyncLocalStorage();

/** Runs fn with the job's identity, so receipts and routing know whose data this is. */
export function runWithInferenceContext(context, fn) {
  return inferenceContext.run(context, fn);
}

export function currentInferenceContext() {
  return inferenceContext.getStore() || {};
}

function optedInSchools() {
  return String(process.env.NEAR_AI_SCHOOLS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * True when NEAR_AI_SCHOOLS names this school, by name or id ("*" opts in every school).
 * A named school without a NEAR AI key throws: falling back would send its data elsewhere.
 */
export function nearPrivateEnabledFor(school, schoolId) {
  const schools = optedInSchools();
  const listed = schools.includes('*')
    || [school, schoolId].some((value) => value && schools.includes(String(value).trim().toLowerCase()));
  if (listed && !process.env.NEAR_AI_API_KEY) throw new Error('NEAR_AI_SCHOOLS names this school but NEAR_AI_API_KEY is not set.');
  return listed;
}

/** Whether a context's model calls take the private path. forcePrivate counts only once a school is opted in. */
export function nearPrivateEnabledForContext({ school, schoolId, forcePrivate } = {}) {
  if (forcePrivate && optedInSchools().length) {
    if (!process.env.NEAR_AI_API_KEY) throw new Error('NEAR_AI_SCHOOLS is set but NEAR_AI_API_KEY is not.');
    return true;
  }
  return nearPrivateEnabledFor(school, schoolId);
}

export function nearPrivateEnabledForCurrentJob() {
  return nearPrivateEnabledForContext(currentInferenceContext());
}

/**
 * Once any school is opted in, a model call must say whose data it carries. Without
 * this, a new route that forgot its context would quietly skip the private path.
 */
export function assertPrivateRoutingKnown() {
  if (optedInSchools().length && !inferenceContext.getStore()) {
    throw new Error('Model call without an inference context while NEAR_AI_SCHOOLS is set.');
  }
}
