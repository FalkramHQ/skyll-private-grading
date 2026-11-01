// Client helpers for the CRM Fees section (CRM M2 phase 1).
import { CrmApiError, crmFetch, newIdempotencyKey } from './api';

/**
 * A sender for one fee form. It keeps the same Idempotency-Key across
 * retries, so a request that timed out but reached the server isn't applied
 * twice (a payment is never recorded twice). Once the server has answered
 * with an error, nothing was applied, and the next attempt gets a fresh key.
 */
export function feeRequest() {
  let key = newIdempotencyKey();
  return async function send(path, body) {
    try {
      return await crmFetch(path, { method: 'POST', body, idempotencyKey: key });
    } catch (error) {
      if (error instanceof CrmApiError) key = newIdempotencyKey();
      throw error;
    }
  };
}

/** Staff-facing text for a fee write error. */
export function feeErrorText(error) {
  if (!error) return null;
  if (error.code === 'idempotency_mismatch') return 'This may already have been saved. Close this, check the fees list, then try again if it is missing.';
  if (error.code === 'version_conflict') return 'Someone else changed this meanwhile. Close and reopen to see the latest version.';
  return error.message;
}
