// React 19 requires this flag for act()-based testing; jest-expo does not set it.
global.IS_REACT_ACT_ENVIRONMENT = true;

import { Alert, Image, Linking } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import App from '../App';

// Native modules and platform APIs used by App.js are stubbed so the full
// sign-in → open-test → scan flow can run under jest-expo.
const mockScanDocument = jest.fn();
const mockAnalyzeScannedImages = jest.fn();
jest.mock('@preeternal/react-native-document-scanner-plugin', () => ({
  scanDocument: (...args) => mockScanDocument(...args),
  analyzeScannedImages: (...args) => mockAnalyzeScannedImages(...args),
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(() => Promise.resolve(null)),
  setItem: jest.fn(() => Promise.resolve()),
  removeItem: jest.fn(() => Promise.resolve()),
}));

// react-native-safe-area-context requires a real native module / SafeAreaProvider.
// App.js renders full-screen SafeAreaView + InsetBottom (which call useSafeAreaInsets),
// so stub the module: insets are zero in the test environment.
jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  const { View } = require('react-native');
  const SafeAreaProvider = ({ children }) => React.createElement(React.Fragment, null, children);
  const SafeAreaView = ({ children, ...props }) => React.createElement(View, props, children);
  const useSafeAreaInsets = () => ({ top: 0, right: 0, bottom: 0, left: 0 });
  return { SafeAreaProvider, SafeAreaView, useSafeAreaInsets };
});

jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));

// expo-constants is provided by the Expo toolchain at runtime but is not a
// declared dependency, so jest cannot resolve it — mock it virtually.
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '0.2.1' }, nativeAppVersion: '0.2.1' },
}), { virtual: true });

jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file://test/',
  FileSystemUploadType: { BINARY_CONTENT: 0 },
  makeDirectoryAsync: jest.fn(() => Promise.resolve()),
  copyAsync: jest.fn(() => Promise.resolve()),
  getInfoAsync: jest.fn(() => Promise.resolve({ exists: true, size: 1000 })),
  uploadAsync: jest.fn(() => Promise.resolve({ status: 200, body: '' })),
  moveAsync: jest.fn(() => Promise.resolve()),
  readDirectoryAsync: jest.fn(() => Promise.resolve([])),
  deleteAsync: jest.fn(() => Promise.resolve()),
  readAsStringAsync: jest.fn(() => Promise.resolve('')),
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve('test-token')),
  setItemAsync: jest.fn(() => Promise.resolve()),
  deleteItemAsync: jest.fn(() => Promise.resolve()),
}));

jest.mock('expo-updates', () => ({
  isEnabled: false,
  checkForUpdateAsync: jest.fn(),
  fetchUpdateAsync: jest.fn(),
  reloadAsync: jest.fn(),
  runtimeVersion: '0.2.1',
  updateId: 'test-update-id',
}));

// App.js registers for push on mount (src/pushRegistration.js). Stub the native
// notifications module so registration resolves to "unavailable" and never
// touches a device: permissions denied + no tap responses.
jest.mock('expo-notifications', () => ({
  AndroidImportance: { DEFAULT: 4 },
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn(() => Promise.resolve()),
  getPermissionsAsync: jest.fn(() => Promise.resolve({ granted: false, canAskAgain: false })),
  requestPermissionsAsync: jest.fn(() => Promise.resolve({ granted: false })),
  getExpoPushTokenAsync: jest.fn(() => Promise.resolve({ data: 'ExponentPushToken[test]' })),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  getLastNotificationResponseAsync: jest.fn(() => Promise.resolve(null)),
}));

// End-to-end coverage for the intake upload-reliability fixes: review pages
// live outside the outbox, locked tests never delete pages, a lost `complete`
// response does not create a duplicate, and a 401 is verified before sign-out.
const FileSystem = require('expo-file-system/legacy');

// The full App renders slowly on a loaded CI machine.
jest.setTimeout(30000);

const testSummary = { id: 't1', title: 'Chemistry Midterm', subject: 'Chemistry', grade: '12', studentCount: 2, status: 'uploading' };
function testDetail() {
  return {
    id: 't1',
    title: 'Chemistry Midterm',
    subject: 'Chemistry',
    status: 'uploading',
    job: null,
    students: [
      { id: 's1', testStudentId: 'ts1', name: 'Asha' },
      { id: 's2', testStudentId: 'ts2', name: 'Bilal' },
    ],
    assets: [],
  };
}

let uploadHandler;
let sessionUser;
function json(body, status = 200) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(JSON.parse(JSON.stringify(body))) });
}
const mockFetch = jest.fn((url, options = {}) => {
  const u = String(url);
  const requestBody = options.body ? JSON.parse(options.body) : {};
  if (u.includes('/api/auth/session')) return json({ user: sessionUser() });
  if (u.includes('/api/auth/features')) return json({ features: {} });
  if (u.includes('/api/intake/batches')) return json({ batches: [] });
  if (u.includes('/api/intake/devices')) return json({ installations: [] });
  if (u.includes('/api/teacher-dashboard')) return json({});
  if (u.includes('/api/intake/tests?id=')) return json({ test: testDetail() });
  if (u.includes('/api/intake/tests')) return json({ tests: [testSummary] });
  if (u.includes('/api/intake/uploads')) return uploadHandler(requestBody);
  return json({});
});

const admin = { role: 'admin', username: 'mahadmin', school: 'Test School' };
let alertSpy;

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = mockFetch;
  sessionUser = () => admin;
  uploadHandler = (body) => {
    if (body.action === 'create') return json({ asset: { id: `asset-${body.filename}` }, uploadUrl: 'https://r2/put', headers: {} }, 201);
    return json({ ok: true });
  };
  mockScanDocument.mockResolvedValue({ status: 'success', scannedImages: ['file://scan1.jpg', 'file://scan2.jpg'] });
  mockAnalyzeScannedImages.mockResolvedValue({ textBlocks: [] });
  Image.getSize = jest.fn((uri, success) => success(1600, 1200));
  FileSystem.getInfoAsync.mockResolvedValue({ exists: true, size: 200000 });
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});

afterEach(() => {
  alertSpy.mockRestore();
});

async function scanTwoPagesForBilal() {
  await render(<App />);
  await fireEvent.press(await screen.findByText('Open test'));
  await screen.findAllByText('Bilal');
  await fireEvent.press(screen.getByLabelText('Scan answer sheet for Bilal'));
  await screen.findByText('Use 2 page(s)');
}

function uploadCalls(action) {
  return mockFetch.mock.calls
    .filter(([url]) => String(url).includes('/api/intake/uploads'))
    .map(([, options]) => JSON.parse(options.body))
    .filter((body) => !action || body.action === action);
}

test('new scans are kept in the review area, never in the recoverable outbox', async () => {
  await scanTwoPagesForBilal();
  const destinations = FileSystem.copyAsync.mock.calls.map(([{ to }]) => to);
  expect(destinations).toHaveLength(2);
  expect(destinations.every((uri) => uri.startsWith('file://test/intake-review/t1/ts2/'))).toBe(true);
});

test('Cancel asks first, then deletes the unconfirmed pages', async () => {
  await scanTwoPagesForBilal();
  await fireEvent.press(screen.getByLabelText('Cancel scan review'));
  const call = alertSpy.mock.calls.find(([title]) => title === 'Discard this scan?');
  expect(call).toBeTruthy();
  expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
  await act(async () => { call[2].find((button) => button.text === 'Discard').onPress(); });
  await waitFor(() => expect(screen.queryByText('Use 2 page(s)')).toBeNull());
  const deleted = FileSystem.deleteAsync.mock.calls.map(([uri]) => uri);
  expect(deleted).toHaveLength(2);
  expect(deleted.every((uri) => uri.includes('/intake-review/t1/ts2/'))).toBe(true);
  expect(uploadCalls('create')).toHaveLength(0);
});

test('confirming moves pages to the outbox and uploads them with durable page numbers', async () => {
  await scanTwoPagesForBilal();
  await fireEvent.press(screen.getByText('Use 2 page(s)'));
  await waitFor(() => expect(uploadCalls('complete')).toHaveLength(2));
  const moved = FileSystem.moveAsync.mock.calls.map(([{ from, to }]) => [from, to]);
  expect(moved).toHaveLength(2);
  expect(moved.every(([from, to]) => from.includes('/intake-review/') && to.includes('/intake-outbox/'))).toBe(true);
  const filenames = uploadCalls('create').map((body) => body.filename).sort();
  expect(filenames[0]).toMatch(/^Bilal-page-\d+-1\.jpg$/);
  expect(filenames[1]).toMatch(/^Bilal-page-\d+-2\.jpg$/);
  const uploadedFrom = FileSystem.uploadAsync.mock.calls.map(([, uri]) => uri);
  expect(uploadedFrom.every((uri) => uri.includes('/intake-outbox/t1/ts2/'))).toBe(true);
});

test('a locked test keeps the pages in quarantine and says so, instead of deleting them', async () => {
  uploadHandler = (body) => (body.action === 'create'
    ? json({ error: 'This assessment is locked (ready for review).', code: 'answer_sheet_upload_locked' }, 409)
    : json({ ok: true }));
  await scanTwoPagesForBilal();
  await fireEvent.press(screen.getByText('Use 2 page(s)'));
  expect(await screen.findByText(/2 pages not sent — this test was locked for processing\. Ask an admin to reopen it, then Retry\./)).toBeTruthy();
  const deletedOutbox = FileSystem.deleteAsync.mock.calls.map(([uri]) => uri).filter((uri) => uri.includes('/intake-outbox/'));
  expect(deletedOutbox).toEqual([]);
  const quarantined = FileSystem.moveAsync.mock.calls.map(([{ to }]) => to).filter((uri) => uri.includes('/intake-quarantine/t1/ts2/'));
  expect(quarantined).toHaveLength(2);
  expect(screen.getByLabelText('Retry 2 locked pages')).toBeTruthy();
  expect(screen.getByLabelText('Discard 2 locked pages')).toBeTruthy();
});

test('a 401 with a still-valid session does not sign the scanner out', async () => {
  let creates = 0;
  uploadHandler = (body) => {
    if (body.action === 'create') {
      creates += 1;
      if (creates <= 2) return json({ error: 'Unauthorized' }, 401);
      return json({ asset: { id: `asset-${creates}` }, uploadUrl: 'https://r2/put', headers: {} }, 201);
    }
    return json({ ok: true });
  };
  await scanTwoPagesForBilal();
  const sessionChecksBefore = mockFetch.mock.calls.filter(([url]) => String(url).includes('/api/auth/session')).length;
  await fireEvent.press(screen.getByText('Use 2 page(s)'));
  await waitFor(() => expect(mockFetch.mock.calls.filter(([url]) => String(url).includes('/api/auth/session')).length).toBeGreaterThan(sessionChecksBefore));
  await waitFor(() => expect(uploadCalls('complete')).toHaveLength(2), { timeout: 8000 });
  expect(alertSpy).not.toHaveBeenCalledWith('Session expired', expect.anything());
  expect(screen.getAllByText('Bilal').length).toBeGreaterThan(0);
});

test('a confirmed expiry signs out but keeps the pages on the phone', async () => {
  uploadHandler = (body) => (body.action === 'create' ? json({ error: 'Unauthorized' }, 401) : json({ ok: true }));
  await scanTwoPagesForBilal();
  sessionUser = () => null;
  await fireEvent.press(screen.getByText('Use 2 page(s)'));
  await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('Session expired', expect.stringContaining('saved on this phone')), { timeout: 8000 });
  const deletedOutbox = FileSystem.deleteAsync.mock.calls.map(([uri]) => uri).filter((uri) => uri.includes('/intake-outbox/'));
  expect(deletedOutbox).toEqual([]);
});

test('a lost complete response resolves through resume instead of creating a duplicate', async () => {
  let completes = 0;
  uploadHandler = (body) => {
    if (body.action === 'create') return json({ asset: { id: `asset-${body.filename}` }, uploadUrl: 'https://r2/put', headers: {} }, 201);
    if (body.action === 'complete') {
      completes += 1;
      // The first complete lands on the server but the phone sees a failure.
      if (completes === 1) return Promise.reject(new TypeError('Network request failed'));
      return json({ ok: true });
    }
    if (body.action === 'resume') return json({ ok: true, status: 'uploaded', alreadyUploaded: true, assetId: body.assetId, asset: { id: body.assetId } });
    return json({ ok: true });
  };
  await scanTwoPagesForBilal();
  await fireEvent.press(screen.getByText('Use 2 page(s)'));
  await waitFor(() => expect(uploadCalls('resume')).toHaveLength(1), { timeout: 8000 });
  await waitFor(() => expect(screen.queryByText(/waiting|sending|failed/)).toBeNull(), { timeout: 8000 });
  expect(uploadCalls('create')).toHaveLength(2);
});
