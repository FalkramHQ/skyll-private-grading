import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Durable record of an in-flight native document scan.
 *
 * On low-RAM Android devices the OS can kill Skyll's React process while the
 * external Google scanner activity is foregrounded. The scanner's result then
 * comes back to a brand-new process that has no live `scanDocument()` promise
 * to receive it, so the scan is silently dropped and the user is stranded on
 * the home screen. The record below is written to AsyncStorage *before* the
 * scanner launches (never via the debounced draft effect), so the restarted
 * process still knows a scan was in flight and can ask the native module for
 * the persisted result.
 */

export const SCAN_SESSION_KEY_PREFIX = 'skyll:intake:scan-session:v1';

// Abandoned sessions (user force-closed the app mid-scan and never returned)
// are cleaned up so their durable image copies do not accumulate forever.
export const SCAN_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const SCAN_SESSION_STATE = {
  LAUNCHING: 'launching',
  RESULT_READY: 'result-ready',
  CONSUMED: 'consumed',
  CANCELLED: 'cancelled',
};

export function scanSessionKey(user) {
  return `${SCAN_SESSION_KEY_PREFIX}:${user?.username || user?.id || 'admin'}`;
}

export function createScanSession({
  sessionId,
  userId,
  testId,
  student,
  replaceExisting = false,
  existingPages = [],
  nextPageNumber,
  createdAt = Date.now(),
} = {}) {
  return {
    sessionId,
    userId: userId || '',
    testId: testId || '',
    student: student ? { testStudentId: student.testStudentId, name: student.name } : null,
    replaceExisting: Boolean(replaceExisting),
    // The pre-scan record must be small and fast to write — it sits on the path
    // to launching the scanner, and every millisecond here widens the window
    // before the session is durable. Store only how many pages already exist;
    // the recovery path re-reads them from the roster rather than trusting a
    // snapshot of full inspected page objects.
    existingPageCount: Array.isArray(existingPages) ? existingPages.length : Number(existingPages) || 0,
    nextPageNumber: Number(nextPageNumber) || 1,
    state: SCAN_SESSION_STATE.LAUNCHING,
    createdAt,
    updatedAt: createdAt,
  };
}

export function normalizeScanSession(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!raw.sessionId) return null;
  const state = Object.values(SCAN_SESSION_STATE).includes(raw.state)
    ? raw.state
    : SCAN_SESSION_STATE.LAUNCHING;
  const existingPageCount = Number(raw.existingPageCount);
  return {
    sessionId: String(raw.sessionId),
    userId: raw.userId || '',
    testId: raw.testId || '',
    student: raw.student || null,
    replaceExisting: Boolean(raw.replaceExisting),
    // Tolerate records written before this field existed.
    existingPageCount: Number.isFinite(existingPageCount) ? existingPageCount : (Array.isArray(raw.existingPages) ? raw.existingPages.length : 0),
    nextPageNumber: Number(raw.nextPageNumber) || 1,
    state,
    createdAt: Number(raw.createdAt) || 0,
    updatedAt: Number(raw.updatedAt) || Number(raw.createdAt) || 0,
  };
}

/**
 * A session is worth recovering only while it is still in flight and not yet
 * past its expiry. Consumed/cancelled sessions are terminal, and a stale
 * session is treated as abandoned.
 */
export function isRecoverableScanSession(session, now = Date.now()) {
  if (!session) return false;
  if (session.state !== SCAN_SESSION_STATE.LAUNCHING && session.state !== SCAN_SESSION_STATE.RESULT_READY) {
    return false;
  }
  if (!session.createdAt) return false;
  return now - session.createdAt < SCAN_SESSION_MAX_AGE_MS;
}

export function isExpiredScanSession(session, now = Date.now()) {
  if (!session) return false;
  return Boolean(session.createdAt) && now - session.createdAt >= SCAN_SESSION_MAX_AGE_MS;
}

export function isSameScanSession(session, { userId, testId } = {}) {
  if (!session) return false;
  if (userId && session.userId && session.userId !== userId) return false;
  if (testId && session.testId && session.testId !== testId) return false;
  return true;
}

export async function readScanSession(user, storage = AsyncStorage) {
  try {
    const raw = await storage.getItem(scanSessionKey(user));
    return normalizeScanSession(raw ? JSON.parse(raw) : null);
  } catch {
    return null;
  }
}

export async function writeScanSession(user, session, storage = AsyncStorage) {
  if (!session) return null;
  const next = { ...session, updatedAt: Date.now() };
  try {
    await storage.setItem(scanSessionKey(user), JSON.stringify(next));
  } catch {
    // Losing the recovery record must never block the scan itself; the native
    // module still persists its own manifest for the current process.
  }
  return next;
}

export async function updateScanSession(user, patch = {}, storage = AsyncStorage) {
  const current = await readScanSession(user, storage);
  if (!current) return null;
  return writeScanSession(user, { ...current, ...patch }, storage);
}

export async function clearScanSession(user, storage = AsyncStorage) {
  try {
    await storage.removeItem(scanSessionKey(user));
  } catch {
    // Best effort: an unreadable key is harmless, readScanSession tolerates it.
  }
}

/**
 * Decide what the app should do when it finds a pending scan session at boot.
 *
 * - `resume-review`: a durable result exists and was copied into app storage;
 *   open the scan-review modal on the restored pages.
 * - `resume-interrupted`: the session was in flight but the native module has
 *   no result (the process died before ML Kit returned, or files were lost).
 *   Return to the editor and explain that the scan must be repeated.
 * - `discard`: nothing actionable — clear the session silently.
 *
 * Pure so it can be unit-tested without a native module or storage.
 */
export function planScanRecovery({ session, nativeResult, now = Date.now() } = {}) {
  if (!session) return { action: 'discard' };
  if (isExpiredScanSession(session, now)) return { action: 'discard' };
  if (!isRecoverableScanSession(session, now)) return { action: 'discard' };
  const pages = Array.isArray(nativeResult?.pages) ? nativeResult.pages.filter((uri) => typeof uri === 'string' && uri) : [];
  if (pages.length) {
    return { action: 'resume-review', pages, student: session.student, replaceExisting: session.replaceExisting, existingPageCount: session.existingPageCount };
  }
  return { action: 'resume-interrupted', student: session.student, replaceExisting: session.replaceExisting, existingPageCount: session.existingPageCount };
}
