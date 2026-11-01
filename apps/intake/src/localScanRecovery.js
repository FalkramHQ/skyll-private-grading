import { LOCKED_QUEUE_STATUS, buildScanQueueItems } from './uploadQueue';
import { extractPageNumberFromFilename } from './workflow';
import { parseScanPath } from './scanStorage';

/**
 * Parse durable scan paths in any area (see scanStorage.js):
 *   .../{intake|intake-outbox|intake-quarantine|intake-review}/{testId}/{testStudentId}/{timestamp}-{page}.jpg
 */
export function parseLocalScanPath(uri = '') {
  const parsed = parseScanPath(uri);
  if (!parsed) return null;
  return {
    area: parsed.area,
    testId: parsed.testId,
    testStudentId: parsed.testStudentId,
    filename: parsed.filename,
    pageNumber: extractPageNumberFromFilename(parsed.filename),
  };
}

/**
 * Turn a recursive directory listing into durable scan page records.
 * `entries` items: { uri, byteSize?, modificationTime? }
 */
export function collectLocalScanPages(entries = []) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => {
      if (!entry?.uri) return null;
      const parsed = parseLocalScanPath(entry.uri);
      if (!parsed) return null;
      return {
        ...parsed,
        uri: entry.uri,
        byteSize: Number(entry.byteSize) || 0,
        modificationTime: Number(entry.modificationTime) || 0,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (
      a.testId.localeCompare(b.testId)
      || a.testStudentId.localeCompare(b.testStudentId)
      || (a.pageNumber || 0) - (b.pageNumber || 0)
      || (a.modificationTime || 0) - (b.modificationTime || 0)
      || a.uri.localeCompare(b.uri)
    ));
}

function asSet(value) {
  if (value instanceof Set) return value;
  return new Set(Array.isArray(value) ? value : []);
}

/**
 * Rebuild upload-queue items from JPEGs still on device.
 *
 * Successful uploads delete their local files, so confirmed leftovers are
 * pages that never reached the server. We append them (no replace) using the
 * current uploaded counts when known.
 *
 * - `review` pages are never recovered: the operator has not confirmed them
 *   (they come back through the saved draft's review modal instead).
 * - `outbox` pages and legacy `intake/` pages are recovered as `queued`, or
 *   as `locked` when their test no longer accepts answer sheets.
 * - `quarantine` pages are recovered as `locked` only, so they are shown to
 *   the operator but never uploaded until explicitly retried.
 * - `excludeUris` (pages open in the review modal) and anything already in
 *   the queue are skipped. When `knownTestIds` is given, only pages of tests
 *   the signed-in account can see are touched.
 */
export function planLocalScanRecovery({
  localPages = [],
  existingQueue = [],
  uploadedCounts = {},
  studentNames = {},
  testId = null,
  blockedTestIds = null,
  knownTestIds = null,
  excludeUris = [],
  now = Date.now(),
} = {}) {
  const blocked = asSet(blockedTestIds);
  const known = knownTestIds == null ? null : asSet(knownTestIds);
  const skipUris = new Set([
    ...(existingQueue || []).map((item) => item?.uri),
    ...(excludeUris || []),
  ].filter(Boolean));
  const scoped = (localPages || []).filter((page) => (
    page?.uri
    && page.testId
    && page.testStudentId
    && page.area !== 'review'
    && (!testId || page.testId === testId)
    && (!known || known.has(page.testId))
    && !skipUris.has(page.uri)
  ));

  const byStudent = new Map();
  for (const page of scoped) {
    const locked = page.area === 'quarantine' || blocked.has(page.testId);
    const key = `${locked ? 'locked' : 'open'}::${page.testId}::${page.testStudentId}`;
    if (!byStudent.has(key)) byStudent.set(key, []);
    byStudent.get(key).push(page);
  }

  const recovered = [];
  let stamp = now;
  for (const pages of byStudent.values()) {
    const { testId: pageTestId, testStudentId } = pages[0];
    const locked = pages[0].area === 'quarantine' || blocked.has(pageTestId);
    const legacyKey = `${pageTestId}::${testStudentId}`;
    const uploadedCount = Number(uploadedCounts[testStudentId] || uploadedCounts[legacyKey] || 0) || 0;
    const student = {
      testStudentId,
      name: studentNames[testStudentId] || studentNames[legacyKey] || 'student',
    };
    const items = buildScanQueueItems({
      testId: pageTestId,
      student,
      pages: pages.map((page) => ({ uri: page.uri, byteSize: page.byteSize, pageNumber: page.pageNumber })),
      replaceExisting: false,
      uploadedCount,
      now: stamp,
    });
    stamp += pages.length + 1;
    recovered.push(...(locked
      ? items.map((item) => ({ ...item, status: LOCKED_QUEUE_STATUS, lastError: 'This test was locked for processing before the page was sent.' }))
      : items));
  }

  return recovered;
}
