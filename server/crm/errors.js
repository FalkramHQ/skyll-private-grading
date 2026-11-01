// Consistent CRM error responses: `{ error: { code, message, details? } }`.
import { randomUUID } from 'node:crypto';
import { CrmTransitionError } from '../../shared/crm/lifecycles.js';

export class CrmHttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'CrmHttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const crmErrors = {
  unauthenticated: () => new CrmHttpError(401, 'unauthenticated', 'Sign in required'),
  forbidden: () => new CrmHttpError(403, 'forbidden', 'You do not have permission for this action'),
  // Used for missing records, other schools' records, and a disabled CRM alike,
  // so responses never reveal whether something exists elsewhere.
  notFound: () => new CrmHttpError(404, 'not_found', 'Not found'),
  methodNotAllowed: () => new CrmHttpError(405, 'method_not_allowed', 'Method not allowed'),
  schoolRequired: () => new CrmHttpError(400, 'school_required', 'Choose a school first'),
  validation: (details) => new CrmHttpError(422, 'validation_failed', 'Request is invalid', details),
};

export function sendCrmError(res, error) {
  if (error instanceof CrmHttpError) {
    const body = { code: error.code, message: error.message };
    if (error.details) body.details = error.details;
    return res.status(error.status).json({ error: body });
  }
  if (error instanceof CrmTransitionError) {
    return res.status(422).json({ error: { code: error.code, message: error.message } });
  }
  const ref = randomUUID().slice(0, 8).toUpperCase();
  console.error(`[${ref}] crm:`, error);
  return res.status(500).json({ error: { code: 'internal', message: `An internal error occurred. Reference: ${ref}` } });
}
