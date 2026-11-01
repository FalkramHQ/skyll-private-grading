// Regression tests for the durable-scan-result bridge.
//
// The Kotlin patch adds `consumePendingScanResult` / `discardPendingScanResult`
// to the TurboModule and re-exports them as named exports from the package
// root. Two bugs this locks down:
//   1. The package's *default export* is a hand-written object literal that does
//      NOT forward those methods, so reaching the module through it silently
//      disabled recovery (feature-detect always false, every call a no-op).
//      The package `exports` map also blocks deep imports of the TurboModule.
//   2. The native side reads `scanSessionId` off an options object, not a bare
//      string argument.

const mockConsume = jest.fn();
const mockDiscard = jest.fn();

jest.mock('@preeternal/react-native-document-scanner-plugin', () => ({
  __esModule: true,
  consumePendingScanResult: (...args) => mockConsume(...args),
  discardPendingScanResult: (...args) => mockDiscard(...args),
}));

import {
  consumePendingScanResult,
  discardPendingScanResult,
  supportsDurableScanResults,
} from '../src/nativeScanResult';

describe('nativeScanResult', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConsume.mockResolvedValue(null);
    mockDiscard.mockResolvedValue(undefined);
  });

  test('feature-detects support on the package exports', () => {
    expect(supportsDurableScanResults()).toBe(true);
  });

  test('passes the session id as an options object, not a bare argument', async () => {
    mockConsume.mockResolvedValue({
      status: 'success',
      scannedImages: ['file:///a.jpg'],
    });

    const result = await consumePendingScanResult('scan_123');

    expect(mockConsume).toHaveBeenCalledWith({ scanSessionId: 'scan_123' });
    expect(result).toEqual({ pages: ['file:///a.jpg'] });
  });

  test('returns null for a non-success or empty native result', async () => {
    mockConsume.mockResolvedValue({ status: 'cancelled' });
    expect(await consumePendingScanResult('scan_123')).toBeNull();

    mockConsume.mockResolvedValue({ status: 'success', scannedImages: [] });
    expect(await consumePendingScanResult('scan_123')).toBeNull();
  });

  test('returns null instead of throwing when the native call rejects', async () => {
    mockConsume.mockRejectedValue(new Error('no manifest'));
    expect(await consumePendingScanResult('scan_123')).toBeNull();
  });

  test('skips the native call entirely without a session id', async () => {
    expect(await consumePendingScanResult(undefined)).toBeNull();
    expect(mockConsume).not.toHaveBeenCalled();
  });

  test('discard forwards the session id as an options object', async () => {
    await discardPendingScanResult('scan_123');
    expect(mockDiscard).toHaveBeenCalledWith({ scanSessionId: 'scan_123' });
  });
});
