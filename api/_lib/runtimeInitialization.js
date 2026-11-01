/**
 * Shares one initialization attempt within a warm serverless runtime.
 *
 * A failed attempt is deliberately not cached: the next request may succeed
 * after a transient database failure or a corrected configuration.
 */
export function createRetryableInitializer(initialize) {
  let initializationPromise;

  return function ensureInitialized() {
    if (!initializationPromise) {
      try {
        initializationPromise = Promise.resolve(initialize()).catch((error) => {
          initializationPromise = undefined;
          throw error;
        });
      } catch (error) {
        initializationPromise = undefined;
        return Promise.reject(error);
      }
    }
    return initializationPromise;
  };
}
