jest.mock('expo-file-system/legacy', () => {
  const files = new Map(); // localUri -> byte size
  return {
    __esModule: true,
    documentDirectory: 'file:///data/skyll/',
    getInfoAsync: jest.fn(async (uri) => (files.has(uri) ? { exists: true, uri, size: files.get(uri) } : { exists: false, uri })),
    makeDirectoryAsync: jest.fn(async () => {}),
    downloadAsync: jest.fn(async (url, fileUri) => { files.set(fileUri, 2048); return { uri: fileUri, status: 200 }; }),
    deleteAsync: jest.fn(async (uri) => {
      for (const key of Array.from(files.keys())) if (key.startsWith(uri)) files.delete(key);
    }),
    _files: files,
  };
});

import * as FileSystem from 'expo-file-system/legacy';
import {
  assetKeyFor,
  clearAssetCache,
  localUriFor,
  readCachedAsset,
  resolveCachedImages,
  setAssetCacheNamespace,
  writeCachedAsset,
} from '../src/assetCache';

const flush = () => new Promise((resolve) => { setTimeout(resolve, 0); });
const REMOTE = 'https://www.skyllai.com/api/student-answer-sheet?subject=Chemistry&page=1';
const AUTH = { Authorization: 'Bearer token' };

describe('intake asset cache (offline report images)', () => {
  beforeEach(() => {
    FileSystem._files.clear();
    setAssetCacheNamespace('default');
    jest.clearAllMocks();
  });

  test('derives a stable, filesystem-safe key per URL', () => {
    expect(assetKeyFor(REMOTE)).toBe(assetKeyFor(REMOTE));
    expect(assetKeyFor(REMOTE)).not.toBe(assetKeyFor(`${REMOTE}&x=2`));
    expect(assetKeyFor(REMOTE)).toMatch(/^asset_[a-z0-9]+$/);
  });

  test('ignores an empty namespace and isolates cached files per user', async () => {
    setAssetCacheNamespace('  ');
    expect(localUriFor(REMOTE)).toContain('/report-assets/default/');
    setAssetCacheNamespace('alice');
    await writeCachedAsset(REMOTE, AUTH);
    const aliceUri = localUriFor(REMOTE);
    setAssetCacheNamespace('bob');
    expect(await readCachedAsset(REMOTE)).toBeNull();
    setAssetCacheNamespace('alice');
    expect(await readCachedAsset(REMOTE)).toBe(aliceUri);
  });

  test('readCachedAsset returns null for a miss and the local uri for a hit', async () => {
    expect(await readCachedAsset(REMOTE)).toBeNull();
    await writeCachedAsset(REMOTE, AUTH);
    expect(await readCachedAsset(REMOTE)).toBe(localUriFor(REMOTE));
  });

  test('writeCachedAsset downloads with auth headers and persists to disk', async () => {
    const local = await writeCachedAsset(REMOTE, AUTH);
    expect(local).toBe(localUriFor(REMOTE));
    expect(FileSystem.makeDirectoryAsync).toHaveBeenCalled();
    expect(FileSystem.downloadAsync).toHaveBeenCalledWith(REMOTE, local, { headers: AUTH });
    expect(FileSystem._files.has(local)).toBe(true);
  });

  test('a failed download is swallowed so the caller keeps the remote url', async () => {
    FileSystem.downloadAsync.mockRejectedValueOnce(new Error('offline'));
    expect(await writeCachedAsset(REMOTE, AUTH)).toBeNull();
    expect(await readCachedAsset(REMOTE)).toBeNull();
  });

  test('a throwing getInfoAsync is treated as a cache miss', async () => {
    FileSystem.getInfoAsync.mockRejectedValueOnce(new Error('disk error'));
    expect(await readCachedAsset(REMOTE)).toBeNull();
  });

  test('resolveCachedImages prefers on-disk copies and keeps remote + headers for misses', async () => {
    const cachedUrl = REMOTE;
    const missUrl = `${REMOTE}&page=2`;
    await writeCachedAsset(cachedUrl, AUTH);
    jest.clearAllMocks();

    const pages = await resolveCachedImages([cachedUrl, missUrl], AUTH);
    expect(pages).toEqual([
      { uri: localUriFor(cachedUrl) }, // cached: local file, no auth header needed
      { uri: missUrl, headers: AUTH }, // miss: remote url with auth so <Image> can fetch it
    ]);

    // The miss is warmed in the background so the next open works offline.
    await flush();
    expect(FileSystem.downloadAsync).toHaveBeenCalledWith(missUrl, localUriFor(missUrl), { headers: AUTH });
    expect(FileSystem.downloadAsync).not.toHaveBeenCalledWith(cachedUrl, expect.anything(), expect.anything());
  });

  test('resolveCachedImages tolerates empty and non-array input', async () => {
    expect(await resolveCachedImages([], AUTH)).toEqual([]);
    expect(await resolveCachedImages(null, AUTH)).toEqual([]);
  });

  test('clearAssetCache wipes cached files across namespaces on sign-out', async () => {
    setAssetCacheNamespace('alice');
    await writeCachedAsset(REMOTE, AUTH);
    setAssetCacheNamespace('bob');
    await writeCachedAsset(REMOTE, AUTH);
    await clearAssetCache();
    setAssetCacheNamespace('alice');
    expect(await readCachedAsset(REMOTE)).toBeNull();
    setAssetCacheNamespace('bob');
    expect(await readCachedAsset(REMOTE)).toBeNull();
  });
});
