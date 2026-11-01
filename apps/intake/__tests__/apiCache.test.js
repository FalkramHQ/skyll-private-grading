jest.mock('@react-native-async-storage/async-storage', () => {
  const storage = new Map();
  return {
    __esModule: true,
    default: {
      getItem: jest.fn(async (key) => (storage.has(key) ? storage.get(key) : null)),
      setItem: jest.fn(async (key, value) => { storage.set(key, String(value)); }),
      removeItem: jest.fn(async (key) => { storage.delete(key); }),
      getAllKeys: jest.fn(async () => Array.from(storage.keys())),
      multiRemove: jest.fn(async (keys) => { keys.forEach((key) => storage.delete(key)); }),
      _storage: storage,
    },
  };
});

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  cacheKeyFor,
  clearApiCache,
  isCacheFresh,
  readCachedResponse,
  setApiCacheNamespace,
  writeCachedResponse,
} from '../src/apiCache';

describe('intake api cache (stale-while-revalidate)', () => {
  beforeEach(() => {
    AsyncStorage._storage.clear();
    setApiCacheNamespace('default');
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('round-trips a response body through AsyncStorage', async () => {
    await writeCachedResponse('/api/intake/tests', { tests: [{ id: 't1' }] });
    const entry = await readCachedResponse('/api/intake/tests');
    expect(entry.body).toEqual({ tests: [{ id: 't1' }] });
    expect(typeof entry.cachedAt).toBe('number');
  });

  test('returns null when nothing is cached', async () => {
    expect(await readCachedResponse('/api/intake/tests')).toBeNull();
  });

  test('treats entries within the 60s TTL as fresh and older ones as stale', async () => {
    await writeCachedResponse('/api/intake/batches', { batches: [] });
    expect(isCacheFresh(await readCachedResponse('/api/intake/batches'))).toBe(true);
    jest.setSystemTime(new Date('2026-01-01T00:01:01.000Z')); // 61s later
    expect(isCacheFresh(await readCachedResponse('/api/intake/batches'))).toBe(false);
    // Stale data is still readable — that is the point of stale-while-revalidate.
    expect((await readCachedResponse('/api/intake/batches')).body).toEqual({ batches: [] });
  });

  test('keeps cache entries isolated per signed-in user', async () => {
    setApiCacheNamespace('alice');
    await writeCachedResponse('/api/teacher-dashboard', { students: [] });
    setApiCacheNamespace('bob');
    expect(await readCachedResponse('/api/teacher-dashboard')).toBeNull();
    setApiCacheNamespace('alice');
    expect((await readCachedResponse('/api/teacher-dashboard')).body).toEqual({ students: [] });
  });

  test('treats corrupt or malformed entries as a cache miss', async () => {
    const key = cacheKeyFor('/api/intake/tests');
    await AsyncStorage.setItem(key, 'not-json');
    expect(await readCachedResponse('/api/intake/tests')).toBeNull();
    await AsyncStorage.setItem(key, JSON.stringify({ body: 'missing cachedAt' }));
    expect(await readCachedResponse('/api/intake/tests')).toBeNull();
  });

  test('ignores an empty namespace when computing keys', () => {
    setApiCacheNamespace('  ');
    expect(cacheKeyFor('/api/intake/tests')).toContain(':default:/api/intake/tests');
  });

  test('clears all cached entries across namespaces on sign-out', async () => {
    setApiCacheNamespace('alice');
    await writeCachedResponse('/api/intake/tests', { tests: [] });
    setApiCacheNamespace('bob');
    await writeCachedResponse('/api/intake/batches', { batches: [] });
    await clearApiCache();
    expect(await readCachedResponse('/api/intake/tests')).toBeNull();
    expect(await readCachedResponse('/api/intake/batches')).toBeNull();
  });

  test('does not touch non-cache storage keys', async () => {
    await AsyncStorage.setItem('skyll_access_token_fallback', 'token');
    await writeCachedResponse('/api/intake/tests', { tests: [] });
    await clearApiCache();
    expect(await AsyncStorage.getItem('skyll_access_token_fallback')).toBe('token');
  });
});
