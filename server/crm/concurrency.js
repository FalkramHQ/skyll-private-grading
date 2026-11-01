// Optimistic concurrency for versioned CRM rows. Writers send the version they
// last saw; the UPDATE only matches that version. Zero rows changed means the
// record is gone (404) or someone else saved first (409 with the current version).
import { z } from 'zod';
import { CrmHttpError, crmErrors } from './errors.js';

export const expectedVersion = z.coerce.number().int().positive();

export function versionConflict(currentVersion) {
  return new CrmHttpError(409, 'version_conflict', 'This was changed by someone else. Reload and try again.', { currentVersion });
}

/**
 * Call after a batch whose statement at `index` was the guarded UPDATE.
 * `lookup` returns the row's current version, or null when it is not visible
 * in this school.
 */
export async function assertVersionedWrite(results, index, lookup) {
  if (Number(results[index]?.rowsAffected || 0) > 0) return;
  const current = await lookup();
  if (current === null || current === undefined) throw crmErrors.notFound();
  throw versionConflict(Number(current));
}
