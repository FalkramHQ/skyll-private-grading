import { consumePendingScanResult as nativeConsume, discardPendingScanResult as nativeDiscard } from '@preeternal/react-native-document-scanner-plugin';

/**
 * Thin wrapper around the plugin's optional durable-result methods.
 *
 * The Kotlin patch that adds `consumePendingScanResult()` ships inside the APK,
 * so an OTA-only update can land on an install whose native module predates it.
 * Every call here is therefore feature-detected: when the method is missing we
 * fall back to the plain (in-memory) `scanDocument()` result so an older APK
 * keeps working exactly as before, simply without cross-process recovery.
 *
 * These are imported as named exports added to the package root by the same
 * patch. The package's `exports` map blocks deep imports of its TurboModule,
 * and its default export object does not forward the optional methods, so the
 * root-level named export is the only stable entry point.
 */

function isSupported() {
  return typeof nativeConsume === 'function' && typeof nativeDiscard === 'function';
}

export function supportsDurableScanResults() {
  return isSupported();
}

/**
 * Ask the native module for a scan result it persisted under `sessionId`.
 * Returns `null` when unsupported, unavailable, or already consumed.
 */
export async function consumePendingScanResult(sessionId) {
  if (!sessionId || typeof nativeConsume !== 'function') return null;
  try {
    // Native reads `scanSessionId` off the options map, not a bare argument.
    const result = await nativeConsume({ scanSessionId: sessionId });
    if (!result || result.status !== 'success') return null;
    const pages = Array.isArray(result.scannedImages) ? result.scannedImages.filter((uri) => typeof uri === 'string' && uri) : [];
    return pages.length ? { pages } : null;
  } catch {
    // A missing/expired manifest is not an error — it means "no recoverable
    // result", which the caller already knows how to handle.
    return null;
  }
}

export async function discardPendingScanResult(sessionId) {
  if (!sessionId || typeof nativeDiscard !== 'function') return;
  try {
    await nativeDiscard({ scanSessionId: sessionId });
  } catch {
    // Cleanup is best effort; an undiscarded manifest expires on its own.
  }
}
