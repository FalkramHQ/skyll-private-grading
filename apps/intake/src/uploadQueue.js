import { extractPageNumberFromFilename } from './workflow';

export const QUEUE_STORAGE_PREFIX = 'skyll:intake:upload-queue:v1';
export const ACTIVE_QUEUE_STATUSES = ['queued', 'uploading', 'failed'];
/**
 * `locked` rows belong to a test that stopped accepting answer sheets while the
 * pages were still on the phone. They are never uploaded automatically and are
 * never deleted automatically: the operator retries them after an admin
 * reopens the test, or discards them explicitly.
 */
export const LOCKED_QUEUE_STATUS = 'locked';
export const PRESIGN_MAX_AGE_MS = 10 * 60 * 1000;
/** Parallel page uploads while the intake app is foregrounded. */
export const UPLOAD_CONCURRENCY = 3;
/** Every API call (create / resume / complete) gives up after this long. */
export const API_TIMEOUT_MS = 30_000;
/** Cancel a storage PUT that has sent no bytes for this long. */
export const UPLOAD_IDLE_TIMEOUT_MS = 60_000;
/** Hard ceiling for one storage PUT, even while it is still crawling. */
export const UPLOAD_PUT_TIMEOUT_MS = 5 * 60_000;
/**
 * Backstop for an attempt that never settles. Every step is individually
 * bounded, so an attempt can legitimately take up to create + PUT + complete.
 */
export const UPLOAD_STUCK_MS = API_TIMEOUT_MS * 3 + UPLOAD_PUT_TIMEOUT_MS + 15_000;

export function isBlockingQueueItem(item) {
  if (!item) return false;
  if (ACTIVE_QUEUE_STATUSES.includes(item.status)) return true;
  return item.status === 'uploaded' && Boolean(item.replaceGroupId);
}

export function queueStorageKey(user) {
  return `${QUEUE_STORAGE_PREFIX}:${user?.username || user?.id || 'admin'}`;
}

export function normalizePersistedQueue(items = []) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => item && typeof item === 'object' && item.uri && item.testId && item.testStudentId)
    .map((item) => ({
      ...item,
      // Process death / force-stop leaves items mid-flight; always retry immediately on reopen.
      status: item.status === 'uploading' ? 'queued' : item.status,
      nextAttemptAt: 0,
    }))
    .filter((item) => (
      ACTIVE_QUEUE_STATUSES.includes(item.status)
      || item.status === LOCKED_QUEUE_STATUS
      || (item.status === 'uploaded' && item.replaceGroupId && item.remoteAssetId)
    ));
}

/**
 * Reset hung `uploading` rows so the drain can claim them again.
 *
 * `inFlightIds` (a Set or Map of item ids with a live attempt in this process)
 * makes the check exact: an `uploading` row with no live attempt is an orphan
 * and is requeued at once; a live attempt is only reclaimed past the
 * UPLOAD_STUCK_MS backstop. Without it the old time-only rule applies.
 */
export function reclaimStuckUploads(items = [], now = Date.now(), inFlightIds = null) {
  return (Array.isArray(items) ? items : []).map((item) => {
    if (item?.status !== 'uploading') return item;
    const started = Number(item.uploadingStartedAt || item.urlCreatedAt || item.createdAt) || 0;
    const orphan = Boolean(inFlightIds) && !inFlightIds.has(item.id);
    if (!orphan && (!started || (now - started) < UPLOAD_STUCK_MS)) return item;
    return {
      ...item,
      status: 'queued',
      nextAttemptAt: 0,
      lastError: 'Upload stalled; retrying.',
      uploadingStartedAt: null,
      attemptId: null,
    };
  });
}

/**
 * Append new rows, skipping any whose local file is already in the queue (in
 * any state). One JPEG must never become two server pages.
 */
export function appendQueueItems(items = [], additions = []) {
  const current = Array.isArray(items) ? items : [];
  const seen = new Set(current.map((item) => item?.uri).filter(Boolean));
  const fresh = [];
  for (const item of Array.isArray(additions) ? additions : []) {
    if (!item?.uri || seen.has(item.uri)) continue;
    seen.add(item.uri);
    fresh.push(item);
  }
  return fresh.length ? [...current, ...fresh] : current;
}

/** Durable per-student page number for a queued page (from its local file name). */
export function queuePageNumber(page = {}, fallback = 1) {
  const explicit = Number(page?.pageNumber);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  return extractPageNumberFromFilename(page?.uri) || fallback;
}

/** Server filename for a page. The worker orders pages by the trailing number. */
export function queueUploadFilename(studentName, now, pageNumber) {
  return `${studentName || 'student'}-page-${now}-${pageNumber}.jpg`;
}

/** Clear backoff / stuck uploads so a foreground return can drain immediately. */
export function wakeQueuedUploads(items = [], now = Date.now()) {
  return reclaimStuckUploads(items, now).map((item) => (
    item.status === 'queued'
      ? { ...item, nextAttemptAt: 0 }
      : item
  ));
}

/**
 * Drop active queue rows whose local JPEG is gone.
 * Successful uploads delete the file; leftovers after a race must not show as
 * sending/failed forever.
 */
export function dropMissingLocalUploads(items = [], missingUris = []) {
  const missing = new Set((missingUris || []).filter(Boolean));
  if (!missing.size) return Array.isArray(items) ? items : [];
  return (Array.isArray(items) ? items : []).filter((item) => {
    if (!ACTIVE_QUEUE_STATUSES.includes(item?.status)) return true;
    return item.uri && !missing.has(item.uri);
  });
}

/**
 * Drop active (non-replace) queue rows once the server already has the expected
 * page count for that student — clears ghost failed/sending after a successful burst.
 */
export function dropSatisfiedStudentUploads(items = [], uploadedCounts = {}) {
  return (Array.isArray(items) ? items : []).filter((item) => {
    if (!ACTIVE_QUEUE_STATUSES.includes(item?.status)) return true;
    if (item.replaceGroupId) return true;
    const uploaded = Number(uploadedCounts[item.testStudentId]) || 0;
    const expected = Number(item.expectedPageCount);
    if (Number.isInteger(expected) && expected > 0 && uploaded >= expected) return false;
    return true;
  });
}

/** Apply disk + server reconciliation in one pass (pure). */
export function reconcileUploadQueue(items = [], {
  missingUris = [],
  uploadedCounts = {},
  now = Date.now(),
  inFlightIds = null,
} = {}) {
  return dropSatisfiedStudentUploads(
    dropMissingLocalUploads(reclaimStuckUploads(items, now, inFlightIds), missingUris),
    uploadedCounts,
  );
}

export function buildScanQueueItems({
  testId,
  student,
  pages = [],
  replaceExisting = false,
  uploadedCount = 0,
  now = Date.now(),
} = {}) {
  const replaceGroupId = replaceExisting ? `replace-${student?.testStudentId}-${now}` : null;
  const expectedPageCount = replaceExisting ? null : Number(uploadedCount || 0) + pages.length;
  const fallbackBase = replaceExisting ? 0 : Number(uploadedCount || 0);
  return pages.map((page, index) => ({
    id: `q-${now}-${index}-${Math.random().toString(36).slice(2, 8)}`,
    testId,
    testStudentId: student.testStudentId,
    studentName: student.name || 'student',
    kind: 'answer_sheet',
    uri: page.uri,
    // The trailing number is the durable per-student page number baked into
    // the local file name, not the index within this batch: pages added later
    // must sort after the pages already on the server.
    filename: queueUploadFilename(student.name, now, queuePageNumber(page, fallbackBase + index + 1)),
    byteSize: Number(page.byteSize) || 0,
    mimeType: 'image/jpeg',
    status: 'queued',
    remoteAssetId: null,
    urlCreatedAt: null,
    createdAt: now + index,
    attempts: 0,
    lastError: null,
    nextAttemptAt: 0,
    replaceGroupId,
    expectedPageCount,
    pageIndex: index,
    pageCount: pages.length,
  }));
}

export function pickNextQueueItem(items = [], now = Date.now()) {
  const ready = items
    .filter((item) => item.status === 'queued' && (Number(item.nextAttemptAt) || 0) <= now)
    .slice()
    .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
  if (!ready.length) return null;

  // Always advance the oldest queued test first. Prefer finishing an already-
  // started student only within that test — otherwise a busy later test can
  // starve earlier scans forever (e.g. Cyclic-3 waiting while Cycle 2 uploads).
  const oldestTestId = ready[0].testId;
  const sameTest = ready.filter((item) => item.testId === oldestTestId);
  const startedStudents = new Set(
    items
      .filter((item) => (
        item.testId === oldestTestId
        && (item.remoteAssetId || item.status === 'uploading' || Number(item.attempts) > 0)
      ))
      .map((item) => item.testStudentId),
  );
  const finishing = sameTest.filter((item) => startedStudents.has(item.testStudentId));
  const pool = finishing.length ? finishing : sameTest;
  return pool[0] || null;
}

/** Claim up to `limit` queued pages and mark them uploading (mutates a copy). */
export function claimNextQueueItems(items = [], limit = UPLOAD_CONCURRENCY, now = Date.now()) {
  const next = (Array.isArray(items) ? items : []).map((item) => ({ ...item }));
  const claimed = [];
  const max = Math.max(0, Number(limit) || 0);
  for (let index = 0; index < max; index += 1) {
    const item = pickNextQueueItem(next, now);
    if (!item) break;
    // attemptId ties later result updates to this claim, so a reclaimed or
    // locked row is not overwritten by a stale attempt.
    const claimedItem = { ...item, status: 'uploading', lastError: null, uploadingStartedAt: now, attemptId: `a-${now}-${index}-${Math.random().toString(36).slice(2, 8)}` };
    const at = next.findIndex((entry) => entry.id === item.id);
    if (at >= 0) next[at] = claimedItem;
    claimed.push(claimedItem);
  }
  return { items: next, claimed };
}

export function shouldRecreateUploadTarget(item, now = Date.now()) {
  if (!item?.remoteAssetId) return true;
  if (!item.urlCreatedAt) return true;
  return (now - Number(item.urlCreatedAt)) >= PRESIGN_MAX_AGE_MS;
}

export function classifyUploadError(error) {
  const message = String(error?.message || error || '');
  const status = Number(error?.status || error?.statusCode || 0);
  const code = String(error?.code || error?.details?.code || error?.body?.code || '');
  // 503 means the server could not check the session right now (for example
  // a database blip during session lookup). Retry later; never sign out.
  if (status === 503) return 'offline';
  if (status === 401 || /unauthorized|session expired|sign in/i.test(message)) return 'auth';
  if (
    (status === 409 || /assessment is locked|answer sheets are blocked/i.test(message))
    && (code === 'answer_sheet_upload_locked' || /assessment is locked|answer sheets are blocked/i.test(message))
  ) {
    return 'locked';
  }
  if (status === 403 || /403|expired|Request has expired|Forbidden/i.test(message)) return 'stale-url';
  if (status === 408 || /network|offline|timed out|timeout|failed to fetch|network request failed|internet/i.test(message)) return 'offline';
  // The request itself is wrong (bad metadata, test/student/asset gone).
  // Retrying the same request cannot succeed; surface it for Retry/Discard.
  if (status === 400 || status === 404) return 'permanent';
  return 'unknown';
}

export function nextAttemptAt(attempts = 0, now = Date.now()) {
  const delay = Math.min(30_000, 1000 * (2 ** Math.max(0, attempts - 1)));
  return now + delay;
}

export function nextDrainAt(items = [], now = Date.now()) {
  const waiting = items
    .filter((item) => (
      (item.status === 'queued' || (item.status === 'uploaded' && item.replaceGroupId))
      && (Number(item.nextAttemptAt) || 0) > now
    ))
    .map((item) => Number(item.nextAttemptAt));
  return waiting.length ? Math.min(...waiting) : 0;
}

export function pickPendingReplaceGroupId(items = [], now = Date.now()) {
  const ids = [...new Set(items.filter((item) => item.replaceGroupId && item.status === 'uploaded').map((item) => item.replaceGroupId))];
  return ids.find((id) => {
    const group = replaceGroupItems(items, id);
    return replaceGroupReady(items, id) && group.every((item) => (Number(item.nextAttemptAt) || 0) <= now);
  }) || null;
}

export function withExpectedPageCount(items = [], testStudentId, expectedPageCount) {
  if (!testStudentId || !Number.isInteger(Number(expectedPageCount))) return items;
  const expected = Number(expectedPageCount);
  return items.map((item) => (
    item.testStudentId === testStudentId && !item.replaceGroupId
      ? { ...item, expectedPageCount: expected }
      : item
  ));
}

export function pendingLocalPageCount(items = [], testStudentId) {
  return items.filter((item) => item.testStudentId === testStudentId && !item.replaceGroupId && isBlockingQueueItem(item)).length;
}

export function summarizeQueue(items = [], testId = null) {
  const scoped = items.filter((item) => !testId || item.testId === testId);
  return scoped.reduce((counts, item) => {
    if (counts[item.status] !== undefined) counts[item.status] += 1;
    return counts;
  }, { queued: 0, uploading: 0, failed: 0, locked: 0 });
}

/** Locked pages grouped by test, oldest test first, for the persistent banner. */
export function lockedPagesByTest(items = []) {
  const groups = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (item?.status !== LOCKED_QUEUE_STATUS || !item.testId) continue;
    if (!groups.has(item.testId)) groups.set(item.testId, { testId: item.testId, count: 0, items: [] });
    const group = groups.get(item.testId);
    group.count += 1;
    group.items.push(item);
  }
  return [...groups.values()];
}

export function lockedBannerText(count = 0) {
  const n = Number(count) || 0;
  if (!n) return '';
  return `${n} page${n === 1 ? '' : 's'} not sent — this test was locked for processing. Ask an admin to reopen it, then Retry.`;
}

/**
 * Mark rows of blocked tests `locked` instead of dropping them. `moves` maps
 * an item id to its quarantine uri when the caller moved the file; `onlyIds`
 * limits the change to rows the caller actually handled (not in-flight ones).
 */
export function lockItemsForTests(items = [], blockedTestIds = [], moves = {}, onlyIds = null) {
  const blocked = blockedTestIds instanceof Set ? blockedTestIds : new Set(Array.isArray(blockedTestIds) ? blockedTestIds : []);
  if (!blocked.size) return Array.isArray(items) ? items : [];
  let changed = false;
  const next = (Array.isArray(items) ? items : []).map((item) => {
    if (!blocked.has(item?.testId)) return item;
    if (onlyIds && !onlyIds.has(item.id)) return item;
    // A finished replace page is already on the server; leave it for commit.
    if (!ACTIVE_QUEUE_STATUSES.includes(item.status)) return item;
    changed = true;
    return {
      ...item,
      status: LOCKED_QUEUE_STATUS,
      uri: moves[item.id] || item.uri,
      remoteAssetId: null,
      attemptId: null,
      uploadingStartedAt: null,
      nextAttemptAt: 0,
      lastError: 'This test was locked for processing before the page was sent.',
    };
  });
  return changed ? next : items;
}

/** Requeue locked rows of one test (after the files were moved back to the outbox). */
export function unlockItemsForTest(items = [], testId, moves = {}) {
  return (Array.isArray(items) ? items : []).map((item) => (
    item?.status === LOCKED_QUEUE_STATUS && item.testId === testId
      ? { ...item, status: 'queued', uri: moves[item.id] || item.uri, attempts: 0, lastError: null, nextAttemptAt: 0, permanent: false }
      : item
  ));
}

/** Rows the operator may discard for a test: failed and locked pages. */
export function discardableItems(items = [], testId = null) {
  return (Array.isArray(items) ? items : []).filter((item) => (
    (item?.status === 'failed' || item?.status === LOCKED_QUEUE_STATUS)
    && (!testId || item.testId === testId)
  ));
}

/** Pages still only on this phone (anything not yet confirmed by the server). */
export function unsentLocalPageCount(items = [], testId = null) {
  return (Array.isArray(items) ? items : []).filter((item) => (
    (ACTIVE_QUEUE_STATUSES.includes(item?.status) || item?.status === LOCKED_QUEUE_STATUS)
    && (!testId || item.testId === testId)
  )).length;
}

export function queueBannerText(summary = {}) {
  const failed = Number(summary.failed) || 0;
  const queued = Number(summary.queued) || 0;
  const uploading = Number(summary.uploading) || 0;
  if (failed) return `${failed} scan${failed === 1 ? '' : 's'} failed to upload. Tap Retry.`;
  if (uploading) return `Uploading ${uploading} page${uploading === 1 ? '' : 's'} in parallel${queued ? ` · ${queued} waiting` : ''}. Keep the app open.`;
  if (queued) return `${queued} page${queued === 1 ? '' : 's'} waiting to upload. Keep the app open.`;
  return '';
}

export function studentScanLine({
  uploadedCount = 0,
  queuedCount = 0,
  uploadingCount = 0,
  failedCount = 0,
} = {}) {
  if (failedCount) return `${uploadedCount} uploaded · ${failedCount} failed`;
  if (uploadingCount) return `${uploadedCount} uploaded · ${uploadingCount} sending`;
  if (queuedCount) return `${uploadedCount} uploaded · ${queuedCount} waiting`;
  if (uploadedCount) return `${uploadedCount} page(s) uploaded`;
  return 'No scans uploaded yet';
}

export function countsForStudent(items = [], testStudentId) {
  return items.reduce((counts, item) => {
    if (item.testStudentId !== testStudentId) return counts;
    if (item.status === 'queued') counts.queuedCount += 1;
    if (item.status === 'uploading') counts.uploadingCount += 1;
    if (item.status === 'failed') counts.failedCount += 1;
    return counts;
  }, { queuedCount: 0, uploadingCount: 0, failedCount: 0 });
}

export function studentHasBlockingUploads(items = [], testStudentId) {
  return items.some((item) => item.testStudentId === testStudentId && isBlockingQueueItem(item));
}

export function queueBlocksProcessing(items = [], testId) {
  return items.some((item) => item.testId === testId && isBlockingQueueItem(item));
}

export function hasActiveUploads(items = []) {
  return items.some((item) => item.status === 'queued' || item.status === 'uploading' || (item.status === 'uploaded' && item.replaceGroupId));
}

export function replaceGroupItems(items, replaceGroupId) {
  if (!replaceGroupId) return [];
  return items.filter((item) => item.replaceGroupId === replaceGroupId);
}

export function replaceGroupReady(items, replaceGroupId) {
  const group = replaceGroupItems(items, replaceGroupId);
  return group.length > 0 && group.every((item) => item.status === 'uploaded' && item.remoteAssetId);
}

export function retryFailedItems(items = [], testId = null) {
  return items.map((item) => (
    item.status === 'failed' && (!testId || item.testId === testId)
      // Reset the attempt counter too: an item is marked `failed` at the >=4 cap,
      // so without this a manual retry would fail once and fall straight back to
      // `failed` — the "Tap Retry" button could never actually recover a scan.
      ? { ...item, status: 'queued', lastError: null, nextAttemptAt: 0, attempts: 0, permanent: false }
      : item
  ));
}

/** Drop active queue rows for assessments that no longer accept answer sheets. */
export function dropItemsForBlockedTests(items = [], blockedTestIds = []) {
  const blocked = blockedTestIds instanceof Set
    ? blockedTestIds
    : new Set(Array.isArray(blockedTestIds) ? blockedTestIds : []);
  if (!blocked.size) return Array.isArray(items) ? items.slice() : [];
  return (Array.isArray(items) ? items : []).filter((item) => !blocked.has(item?.testId));
}

export function dropBlockingItemsForStudent(items = [], testStudentId) {
  return items.filter((item) => item.testStudentId !== testStudentId);
}

