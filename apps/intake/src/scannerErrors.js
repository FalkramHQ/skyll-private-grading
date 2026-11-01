/**
 * Maps document-scanner failures to user-facing copy.
 * The native plugin can throw for memory pressure, activity recreation, or
 * cancelled scans — never assume Expo Go just because scanDocument rejected.
 */

export function isExpoGoRuntime(constants) {
  if (!constants || typeof constants !== 'object') return false;
  return constants.appOwnership === 'expo' || constants.executionEnvironment === 'storeClient';
}

export function isScannerCancelError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return /cancel|cancell?ed|user.?dismiss/.test(message);
}

/**
 * The plugin owns a single native scanner instance and rejects a second
 * scanDocument() while one is still open. Reaching this means a duplicate tap
 * slipped past the UI guard — a benign no-op, not a scanner failure, so it must
 * never surface as a hard error.
 */
export function isScannerBusyError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return /already in progress|scan.*in progress/.test(message);
}

export function scannerUnavailableMessage(error, { isExpoGo = false } = {}) {
  if (isExpoGo) {
    return 'Use the installed Skyll Intake APK. Document scanning is not available in Expo Go.';
  }
  const detail = String(error?.message || '').trim();
  const hint = 'If this keeps happening after many scans, close the app fully and open it again.';
  if (detail) return `Document scanner failed: ${detail}. ${hint}`;
  return `Document scanner failed. ${hint}`;
}
