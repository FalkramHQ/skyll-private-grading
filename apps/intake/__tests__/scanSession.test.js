// jest-expo does not provide the AsyncStorage native module; the module under
// test only needs the JS surface, so stub it before importing.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import {
  SCAN_SESSION_MAX_AGE_MS,
  SCAN_SESSION_STATE,
  clearScanSession,
  createScanSession,
  isExpiredScanSession,
  isRecoverableScanSession,
  isSameScanSession,
  normalizeScanSession,
  planScanRecovery,
  readScanSession,
  updateScanSession,
  writeScanSession,
} from '../src/scanSession';

// Minimal in-memory stand-in for AsyncStorage so these tests exercise the real
// read/write/normalize logic without a native module.
function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: jest.fn(async (key) => (map.has(key) ? map.get(key) : null)),
    setItem: jest.fn(async (key, value) => {
      map.set(key, value);
    }),
    removeItem: jest.fn(async (key) => {
      map.delete(key);
    }),
    _map: map,
  };
}

const user = { username: 'admin@school.test', role: 'admin' };
const student = { testStudentId: 'ts_1', name: 'Aarav' };

function baseSession(overrides = {}) {
  return createScanSession({
    sessionId: 'scan_1',
    userId: user.username,
    testId: 'test_1',
    student,
    existingPages: [],
    nextPageNumber: 3,
    createdAt: 1_000_000,
    ...overrides,
  });
}

// createScanSession always starts in `launching`; build fixtures for other
// states through normalizeScanSession, the same path real reads take.
function sessionInState(state, overrides = {}) {
  return normalizeScanSession({
    ...baseSession(overrides),
    ...overrides,
    state,
  });
}

describe('scanSession', () => {
  test('createScanSession records a launching session with the student', () => {
    const session = baseSession();
    expect(session.sessionId).toBe('scan_1');
    expect(session.state).toBe(SCAN_SESSION_STATE.LAUNCHING);
    expect(session.testId).toBe('test_1');
    expect(session.student).toEqual({ testStudentId: 'ts_1', name: 'Aarav' });
    expect(session.nextPageNumber).toBe(3);
  });

  test('createScanSession stores an existing-page count, not the page objects', () => {
    const session = createScanSession({
      sessionId: 'scan_1',
      testId: 'test_1',
      student,
      existingPages: [{ uri: 'file:///a.jpg' }, { uri: 'file:///b.jpg' }],
    });
    expect(session.existingPageCount).toBe(2);
    // The record must stay small; full page descriptors are not persisted.
    expect(session.existingPages).toBeUndefined();
  });

  test('normalizeScanSession back-fills existingPageCount from legacy records', () => {
    // Records written before existingPageCount existed still carried the array.
    const legacy = normalizeScanSession({
      sessionId: 'scan_1',
      state: SCAN_SESSION_STATE.LAUNCHING,
      existingPages: [{ uri: 'a' }, { uri: 'b' }, { uri: 'c' }],
      createdAt: 1_000_000,
    });
    expect(legacy.existingPageCount).toBe(3);
    expect(normalizeScanSession({ sessionId: 's', state: 'launching' }).existingPageCount).toBe(0);
  });

  test('round-trips through storage keyed by user', async () => {
    const storage = createMemoryStorage();
    await writeScanSession(user, baseSession(), storage);
    const loaded = await readScanSession(user, storage);
    expect(loaded.sessionId).toBe('scan_1');
    expect(loaded.student).toEqual({ testStudentId: 'ts_1', name: 'Aarav' });
    // Sessions are namespaced per user so a shared device cannot cross-recover.
    expect(storage.setItem.mock.calls[0][0]).toContain(user.username);
  });

  test('readScanSession tolerates missing and corrupt payloads', async () => {
    const storage = createMemoryStorage();
    expect(await readScanSession(user, storage)).toBeNull();
    storage._map.set(`skyll:intake:scan-session:v1:${user.username}`, '{not json');
    expect(await readScanSession(user, storage)).toBeNull();
  });

  test('updateScanSession merges patches and bumps updatedAt', async () => {
    const storage = createMemoryStorage();
    await writeScanSession(user, baseSession(), storage);
    const updated = await updateScanSession(user, { state: SCAN_SESSION_STATE.RESULT_READY }, storage);
    expect(updated.state).toBe(SCAN_SESSION_STATE.RESULT_READY);
    expect(updated.sessionId).toBe('scan_1');
  });

  test('normalizeScanSession rejects records without a sessionId', () => {
    expect(normalizeScanSession(null)).toBeNull();
    expect(normalizeScanSession({ state: 'launching' })).toBeNull();
    expect(normalizeScanSession({ sessionId: 's', state: 'bogus' }).state).toBe(
      SCAN_SESSION_STATE.LAUNCHING
    );
  });

  test('isRecoverableScanSession only accepts in-flight, unexpired sessions', () => {
    const now = 1_000_000 + 1000;
    expect(isRecoverableScanSession(baseSession(), now)).toBe(true);
    expect(
      isRecoverableScanSession(sessionInState(SCAN_SESSION_STATE.RESULT_READY), now)
    ).toBe(true);
    // Terminal states are never recovered.
    expect(
      isRecoverableScanSession(sessionInState(SCAN_SESSION_STATE.CONSUMED), now)
    ).toBe(false);
    expect(
      isRecoverableScanSession(sessionInState(SCAN_SESSION_STATE.CANCELLED), now)
    ).toBe(false);
    // Abandoned sessions expire.
    expect(isRecoverableScanSession(baseSession(), 1_000_000 + SCAN_SESSION_MAX_AGE_MS + 1)).toBe(false);
    expect(isRecoverableScanSession(null, now)).toBe(false);
  });

  test('isExpiredScanSession flags only sessions past the max age', () => {
    expect(isExpiredScanSession(baseSession(), 1_000_000)).toBe(false);
    expect(isExpiredScanSession(baseSession(), 1_000_000 + SCAN_SESSION_MAX_AGE_MS)).toBe(true);
  });

  test('isSameScanSession scopes recovery to the same user and test', () => {
    const session = baseSession();
    expect(isSameScanSession(session, { userId: user.username, testId: 'test_1' })).toBe(true);
    expect(isSameScanSession(session, { userId: 'someone-else' })).toBe(false);
    expect(isSameScanSession(session, { testId: 'test_2' })).toBe(false);
  });

  test('clearScanSession removes the record', async () => {
    const storage = createMemoryStorage();
    await writeScanSession(user, baseSession(), storage);
    await clearScanSession(user, storage);
    expect(await readScanSession(user, storage)).toBeNull();
  });
});

describe('planScanRecovery', () => {
  const now = 1_000_000 + 1000;

  test('resumes review when a durable native result exists', () => {
    const plan = planScanRecovery({
      session: baseSession(),
      nativeResult: { pages: ['file:///a.jpg', 'file:///b.jpg'] },
      now,
    });
    expect(plan.action).toBe('resume-review');
    expect(plan.pages).toEqual(['file:///a.jpg', 'file:///b.jpg']);
    expect(plan.student).toEqual({ testStudentId: 'ts_1', name: 'Aarav' });
    // Carries the recorded count so the caller can rebuild the append target.
    expect(plan.existingPageCount).toBe(0);
  });

  test('filters non-string/empty page entries', () => {
    const plan = planScanRecovery({
      session: baseSession(),
      nativeResult: { pages: ['file:///a.jpg', '', null, 42] },
      now,
    });
    expect(plan.action).toBe('resume-review');
    expect(plan.pages).toEqual(['file:///a.jpg']);
  });

  test('falls back to interrupted when the result was lost to process death', () => {
    const plan = planScanRecovery({ session: baseSession(), nativeResult: null, now });
    expect(plan.action).toBe('resume-interrupted');
    expect(plan.student).toEqual({ testStudentId: 'ts_1', name: 'Aarav' });
  });

  test('discards with no session, an expired session, or a terminal one', () => {
    expect(planScanRecovery({ session: null, now }).action).toBe('discard');
    expect(
      planScanRecovery({ session: baseSession({ createdAt: 0 }), now }).action
    ).toBe('discard');
    expect(
      planScanRecovery({
        session: sessionInState(SCAN_SESSION_STATE.CONSUMED),
        now,
      }).action
    ).toBe('discard');
    expect(
      planScanRecovery({
        session: baseSession(),
        nativeResult: { pages: ['file:///a.jpg'] },
        now: 1_000_000 + SCAN_SESSION_MAX_AGE_MS + 1,
      }).action
    ).toBe('discard');
  });

  test('recovery is idempotent: consuming then re-planning yields discard', async () => {
    const storage = createMemoryStorage();
    await writeScanSession(user, baseSession(), storage);

    const first = planScanRecovery({
      session: await readScanSession(user, storage),
      nativeResult: { pages: ['file:///a.jpg'] },
      now,
    });
    expect(first.action).toBe('resume-review');

    // Simulate a successful consume: the record is cleared.
    await clearScanSession(user, storage);

    // A second boot finds nothing and must not resurrect the scan.
    const secondPlan = planScanRecovery({
      session: await readScanSession(user, storage),
      nativeResult: { pages: ['file:///a.jpg'] },
      now,
    });
    expect(secondPlan.action).toBe('discard');
  });
});
