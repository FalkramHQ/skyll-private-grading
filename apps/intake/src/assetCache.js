import * as FileSystem from 'expo-file-system/legacy';

// Offline cache for binary report assets — the handwritten answer-sheet page
// images a subject report renders. The report JSON is already cached via
// apiCache.js; this persists the images those reports reference so a subject
// report opens fully with no signal, which is common in coaching centers with
// patchy connectivity. Files live under a per-user namespaced directory in
// documentDirectory and are keyed by a stable hash of the authenticated URL.
//
// Everything here is best-effort: a cache miss, a full disk, or a failed
// download must never block rendering the report — callers fall back to the
// remote URL, exactly as they did before this cache existed.
const ASSET_DIR = 'report-assets';

// Namespaced by the signed-in username so two users on one device never read
// each other's cached answer sheets (parity with apiCache.js).
let assetNamespace = 'default';

export function setAssetCacheNamespace(namespace) {
  assetNamespace = (namespace && String(namespace).trim()) || 'default';
}

// Stable, filesystem-safe key for a URL (djb2 → base36). Answer-sheet image
// URLs are unique per (student, subject, page) and the token lives in a header
// rather than the URL, so the key is stable across sessions.
export function assetKeyFor(url) {
  const value = String(url || '');
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0;
  }
  return `asset_${hash.toString(36)}`;
}

function assetDirectory() {
  return `${FileSystem.documentDirectory}${ASSET_DIR}/${assetNamespace}/`;
}

export function localUriFor(url) {
  return `${assetDirectory()}${assetKeyFor(url)}.jpg`;
}

// Return the on-disk file:// URI when this asset is already cached, else null.
export async function readCachedAsset(url) {
  if (!url || !FileSystem.documentDirectory) return null;
  const localUri = localUriFor(url);
  try {
    const info = await FileSystem.getInfoAsync(localUri);
    return info?.exists ? localUri : null;
  } catch {
    return null;
  }
}

// Download an authenticated remote asset to disk and return its local URI, or
// null on any failure so the caller keeps using the remote URL.
export async function writeCachedAsset(url, headers) {
  if (!url || !FileSystem.documentDirectory) return null;
  const localUri = localUriFor(url);
  try {
    await FileSystem.makeDirectoryAsync(assetDirectory(), { intermediates: true });
    await FileSystem.downloadAsync(url, localUri, { headers: headers || {} });
    const info = await FileSystem.getInfoAsync(localUri);
    return info?.exists ? localUri : null;
  } catch {
    return null;
  }
}

// Resolve a list of remote image URLs into gallery-ready pages, preferring an
// on-disk copy so a cached report renders offline. Any URL not yet cached keeps
// its remote URI + auth headers and is warmed in the background (off the render
// path) so the next open — or a cold, offline start — has it on disk.
export async function resolveCachedImages(urls, headers) {
  const list = Array.isArray(urls) ? urls.filter(Boolean) : [];
  const entries = await Promise.all(list.map(async (url) => ({ url, local: await readCachedAsset(url) })));
  entries
    .filter((entry) => !entry.local)
    .forEach((entry) => { writeCachedAsset(entry.url, headers); });
  return entries.map((entry) => (entry.local ? { uri: entry.local } : { uri: entry.url, headers }));
}

export async function clearAssetCache() {
  if (!FileSystem.documentDirectory) return;
  try {
    // Clears every namespace: the whole report-assets root is derived data that
    // is re-fetched on the next signed-in open, so sign-out wipes it wholesale.
    await FileSystem.deleteAsync(`${FileSystem.documentDirectory}${ASSET_DIR}/`, { idempotent: true });
  } catch {
    // Best-effort cleanup; sign-out must never block on storage.
  }
}
