import { randomUUID } from 'node:crypto';

export function internalError(res, error, context = '') {
  const ref = randomUUID().slice(0, 8).toUpperCase();
  console.error(`[${ref}] ${context}:`, error);
  return res.status(500).json({ error: `An internal error occurred. Reference: ${ref}` });
}
