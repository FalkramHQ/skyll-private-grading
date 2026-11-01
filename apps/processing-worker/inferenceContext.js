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

/** True when NEAR_AI_SCHOOLS names this school ("*" opts in every school). */
export function nearPrivateEnabledFor(school) {
  if (!process.env.NEAR_AI_API_KEY) return false;
  const schools = String(process.env.NEAR_AI_SCHOOLS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (schools.includes('*')) return true;
  return Boolean(school) && schools.includes(String(school).trim().toLowerCase());
}

export function nearPrivateEnabledForCurrentJob() {
  return nearPrivateEnabledFor(currentInferenceContext().school);
}
