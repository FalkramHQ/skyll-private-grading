import AsyncStorage from '@react-native-async-storage/async-storage';

// Local response cache for the intake app (stale-while-revalidate).
// The last successful API response for a payload is persisted in AsyncStorage
// so a cold start can paint instantly from cached data and revalidate in the
// background instead of blocking on the network.
const CACHE_TTL_MS = 60 * 1000; // 60 seconds
const CACHE_PREFIX = 'skyll_intake_api_cache';

// Entries are namespaced by the signed-in username so two different users on
// the same device never see each other's cached data.
let cacheNamespace = 'default';

export function setApiCacheNamespace(namespace) {
  cacheNamespace = (namespace && String(namespace).trim()) || 'default';
}

export function cacheKeyFor(path) {
  return `${CACHE_PREFIX}:${cacheNamespace}:${path}`;
}

export function isCacheFresh(entry) {
  return Boolean(entry && typeof entry.cachedAt === 'number' && Date.now() - entry.cachedAt < CACHE_TTL_MS);
}

export async function readCachedResponse(path) {
  try {
    const raw = await AsyncStorage.getItem(cacheKeyFor(path));
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (!entry || typeof entry.cachedAt !== 'number' || entry.body === undefined) return null;
    return entry;
  } catch {
    return null;
  }
}

export async function writeCachedResponse(path, body) {
  try {
    await AsyncStorage.setItem(cacheKeyFor(path), JSON.stringify({ cachedAt: Date.now(), body }));
  } catch {
    // Caching is best-effort; a full storage must never break a request.
  }
}

export async function clearApiCache() {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const cacheKeys = keys.filter((key) => key.startsWith(`${CACHE_PREFIX}:`));
    if (cacheKeys.length) await AsyncStorage.multiRemove(cacheKeys);
  } catch {
    // Best-effort cleanup; sign-out must never block on storage.
  }
}
