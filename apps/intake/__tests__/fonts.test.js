import { FONT_LOAD_TIMEOUT_MS, loadAppFonts, resetFontLoadForTests } from '../src/fonts';
import { fontFamily } from '../src/theme';

// Font loading ships in an OTA update, so it must never block or crash the
// app: every failure path resolves to false and the system font stays.
describe('loadAppFonts', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    resetFontLoadForTests();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('keeps the timeout short', () => {
    expect(FONT_LOAD_TIMEOUT_MS).toBeLessThanOrEqual(1500);
  });

  test('resolves true and registers every brand family when loading succeeds', async () => {
    const loadAsync = jest.fn(() => Promise.resolve());
    await expect(loadAppFonts({ loader: () => ({ loadAsync }) })).resolves.toBe(true);
    expect(Object.keys(loadAsync.mock.calls[0][0]).sort()).toEqual(Object.values(fontFamily).sort());
  });

  test('falls back when the native font module is missing', async () => {
    const loader = () => { throw new Error("Cannot find native module 'ExpoFontLoader'"); };
    await expect(loadAppFonts({ loader })).resolves.toBe(false);
  });

  test('falls back when loading rejects', async () => {
    const loader = () => ({ loadAsync: () => Promise.reject(new Error('asset download failed')) });
    await expect(loadAppFonts({ loader })).resolves.toBe(false);
  });

  test('stops waiting after the timeout and reports a late load', async () => {
    let finish;
    const loader = () => ({ loadAsync: () => new Promise((resolve) => { finish = resolve; }) });
    const onLateLoad = jest.fn();
    const result = loadAppFonts({ loader, onLateLoad });
    jest.advanceTimersByTime(FONT_LOAD_TIMEOUT_MS);
    await expect(result).resolves.toBe(false);
    finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(onLateLoad).toHaveBeenCalledTimes(1);
  });
});
