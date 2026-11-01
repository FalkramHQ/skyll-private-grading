import { UPLOAD_IDLE_TIMEOUT_MS, UPLOAD_PUT_TIMEOUT_MS } from './uploadQueue';

export function uploadTimeoutError(message) {
  return Object.assign(new Error(message), { status: 408, code: 'timeout', timedOut: true });
}

function isUnavailableError(error) {
  return error?.code === 'ERR_UNAVAILABLE' || /is not available|unavailable/i.test(String(error?.message || ''));
}

/** Race a promise against a timer. Used only when the native task API is missing. */
export function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(uploadTimeoutError(message)), ms);
    }),
  ]);
}

/**
 * PUT a local file to a signed storage URL and make sure a timed-out transfer
 * is actually stopped.
 *
 * With `createUploadTask` (expo-file-system legacy, shipped in the APK) the
 * transfer is cancelled when it sends no bytes for `idleTimeoutMs`, or when it
 * exceeds `maxTimeoutMs` overall, so a stalled page no longer keeps uploading
 * in the background after the queue has moved on. Older native builds without
 * the task API fall back to the previous fixed-timeout race.
 */
export async function putFileWithTimeout(FileSystem, {
  url,
  fileUri,
  headers,
  idleTimeoutMs = UPLOAD_IDLE_TIMEOUT_MS,
  maxTimeoutMs = UPLOAD_PUT_TIMEOUT_MS,
  checkEveryMs = 5_000,
  // Progress events are not delivered while the app is backgrounded, so the
  // idle clock is held while this returns true (the hard ceiling still runs).
  isProgressPaused = () => false,
  now = () => Date.now(),
} = {}) {
  const options = {
    httpMethod: 'PUT',
    uploadType: FileSystem.FileSystemUploadType?.BINARY_CONTENT,
    headers,
  };
  const fallback = () => withTimeout(
    FileSystem.uploadAsync(url, fileUri, options),
    maxTimeoutMs,
    `Storage upload timed out after ${Math.round(maxTimeoutMs / 1000)}s`,
  );
  if (typeof FileSystem.createUploadTask !== 'function') return fallback();

  const startedAt = now();
  let lastProgressAt = startedAt;
  let lastBytes = -1;
  const task = FileSystem.createUploadTask(url, fileUri, options, (progress) => {
    const sent = Number(progress?.totalBytesSent) || 0;
    if (sent > lastBytes) {
      lastBytes = sent;
      lastProgressAt = now();
    }
  });

  let watchdog = null;
  let timeoutReason = '';
  const stalled = new Promise((_, reject) => {
    watchdog = setInterval(() => {
      const current = now();
      if (isProgressPaused()) lastProgressAt = current;
      if (current - lastProgressAt >= idleTimeoutMs) {
        timeoutReason = `Storage upload stalled (no progress for ${Math.round(idleTimeoutMs / 1000)}s)`;
      } else if (current - startedAt >= maxTimeoutMs) {
        timeoutReason = `Storage upload timed out after ${Math.round(maxTimeoutMs / 1000)}s`;
      } else {
        return;
      }
      clearInterval(watchdog);
      Promise.resolve().then(() => task.cancelAsync()).catch(() => {});
      reject(uploadTimeoutError(timeoutReason));
    }, Math.max(250, checkEveryMs));
  });

  try {
    const result = await Promise.race([task.uploadAsync(), stalled]);
    // A cancelled task resolves null/undefined instead of rejecting.
    if (!result) throw uploadTimeoutError(timeoutReason || 'Storage upload was cancelled');
    return result;
  } catch (error) {
    if (!timeoutReason && isUnavailableError(error)) return fallback();
    throw error;
  } finally {
    clearInterval(watchdog);
  }
}
