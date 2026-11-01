/**
 * On-device layout for scanned answer-sheet pages.
 *
 *   documentDirectory/intake-review/{testId}/{testStudentId}/{ts}-{page}.jpg
 *     Pages the operator is still reviewing. Never uploaded or recovered into
 *     the upload queue; deleted on Cancel / Back / Remove page.
 *   documentDirectory/intake-outbox/{testId}/{testStudentId}/{ts}-{page}.jpg
 *     Pages the operator confirmed. Boot recovery re-queues anything here that
 *     the persisted queue lost.
 *   documentDirectory/intake-quarantine/{testId}/{testStudentId}/{ts}-{page}.jpg
 *     Confirmed pages of a test that was locked before they were sent. Kept
 *     until the operator retries (moved back to the outbox) or discards them.
 *   documentDirectory/intake/{testId}/{testStudentId}/{ts}-{page}.jpg
 *     Legacy layout written by app versions before this split. It mixed
 *     pending-review and confirmed pages. Files already there keep the old
 *     recovery behaviour (treated as confirmed) so nothing in the field is
 *     lost; new scans are never written there.
 *
 * The page number in the file name is the durable per-student page number.
 */

export const SCAN_AREA_ROOTS = Object.freeze({
  review: 'intake-review',
  outbox: 'intake-outbox',
  quarantine: 'intake-quarantine',
  legacy: 'intake',
});

const AREA_BY_ROOT = Object.freeze(Object.fromEntries(
  Object.entries(SCAN_AREA_ROOTS).map(([area, root]) => [root, area]),
));

export function scanAreaRoot(documentDirectory, area) {
  const root = SCAN_AREA_ROOTS[area];
  if (!documentDirectory || !root) return null;
  return `${documentDirectory}${root}/`;
}

export function scanFolder(documentDirectory, area, testId, testStudentId) {
  const root = scanAreaRoot(documentDirectory, area);
  if (!root || !testId || !testStudentId) return null;
  return `${root}${testId}/${testStudentId}/`;
}

/** Parse `{root}/{testId}/{testStudentId}/{file}.jpg` for any scan area. */
export function parseScanPath(uri = '') {
  const normalized = String(uri || '').replace(/\\/g, '/');
  const match = normalized.match(/\/(intake(?:-review|-outbox|-quarantine)?)\/([^/]+)\/([^/]+)\/([^/]+\.jpe?g)$/i);
  if (!match) return null;
  const [, root, testId, testStudentId, filename] = match;
  if (!testId || !testStudentId || testStudentId === 'references') return null;
  const prefix = normalized.slice(0, normalized.length - match[0].length + 1);
  return { area: AREA_BY_ROOT[root.toLowerCase()], root: prefix, testId, testStudentId, filename };
}

/** Same file name, same test/student, different area. */
export function relocateScanUri(uri, area) {
  const parsed = parseScanPath(uri);
  const root = SCAN_AREA_ROOTS[area];
  if (!parsed || !root) return null;
  return `${parsed.root}${root}/${parsed.testId}/${parsed.testStudentId}/${parsed.filename}`;
}

/**
 * Move a page between areas, idempotently. If the source is already gone but
 * the destination exists (a previous move finished before a crash), the
 * destination is returned. Returns null when neither exists.
 */
export async function moveScanFile(FileSystem, uri, area) {
  const destination = relocateScanUri(uri, area);
  if (!destination) return null;
  if (destination === uri) return uri;
  const source = await FileSystem.getInfoAsync(uri).catch(() => null);
  if (source?.exists) {
    const parsed = parseScanPath(destination);
    await FileSystem.makeDirectoryAsync(destination.slice(0, destination.length - parsed.filename.length), { intermediates: true }).catch(() => {});
    try {
      await FileSystem.moveAsync({ from: uri, to: destination });
    } catch {
      // Some storage providers refuse a rename; copy, verify, then delete.
      await FileSystem.copyAsync({ from: uri, to: destination });
      const copied = await FileSystem.getInfoAsync(destination);
      if (!copied?.exists) throw new Error('Could not save the scanned page on this phone.');
      await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
    }
    return destination;
  }
  const already = await FileSystem.getInfoAsync(destination).catch(() => null);
  return already?.exists ? destination : null;
}
