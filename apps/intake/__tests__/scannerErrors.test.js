import {
  isExpoGoRuntime,
  isScannerBusyError,
  isScannerCancelError,
  scannerUnavailableMessage,
} from '../src/scannerErrors';

describe('scannerErrors', () => {
  test('detects Expo Go from appOwnership or storeClient executionEnvironment', () => {
    expect(isExpoGoRuntime({ appOwnership: 'expo' })).toBe(true);
    expect(isExpoGoRuntime({ executionEnvironment: 'storeClient' })).toBe(true);
    expect(isExpoGoRuntime({ appOwnership: 'standalone', executionEnvironment: 'standalone' })).toBe(false);
    expect(isExpoGoRuntime(null)).toBe(false);
  });

  test('treats cancel-style native errors as soft dismissals', () => {
    expect(isScannerCancelError(new Error('User canceled'))).toBe(true);
    expect(isScannerCancelError(new Error('Scan cancelled'))).toBe(true);
    expect(isScannerCancelError(new Error('Native module DocumentScanner is null'))).toBe(false);
  });

  test('treats a second overlapping scanDocument call as a benign no-op', () => {
    expect(isScannerBusyError(new Error('Scan already in progress'))).toBe(true);
    expect(isScannerBusyError({ message: 'A scan is already in progress' })).toBe(true);
    expect(isScannerBusyError('Scan already in progress')).toBe(true);
    expect(isScannerBusyError(new Error('Native module DocumentScanner is null'))).toBe(false);
    expect(isScannerBusyError(new Error('User canceled'))).toBe(false);
    expect(isScannerBusyError(null)).toBe(false);
  });

  test('only mentions Expo Go when actually running in Expo Go', () => {
    expect(scannerUnavailableMessage(new Error('boom'), { isExpoGo: true })).toContain('Expo Go');
    expect(scannerUnavailableMessage(new Error('Native module DocumentScanner is null'), { isExpoGo: false }))
      .toBe('Document scanner failed: Native module DocumentScanner is null. If this keeps happening after many scans, close the app fully and open it again.');
    expect(scannerUnavailableMessage(null, { isExpoGo: false })).toContain('Document scanner failed.');
    expect(scannerUnavailableMessage(null, { isExpoGo: false })).not.toContain('Expo Go');
  });
});
