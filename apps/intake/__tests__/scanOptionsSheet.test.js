// React 19 requires this flag for act()-based testing; jest-expo does not set it.
global.IS_REACT_ACT_ENVIRONMENT = true;

import { Alert, Image, Linking } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import App from '../App';
import { palette } from '../src/theme';

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

const testSummary = { id: 't1', title: 'Chemistry Midterm', subject: 'Chemistry', grade: '12', studentCount: 2, status: 'uploading' };

const defaultAssets = [
  { id: 'a1', kind: 'answer_sheet', label: 'asha-1.jpg', testStudentId: 'ts1', status: 'uploaded', remoteAssetId: 'r1' },
  { id: 'a2', kind: 'answer_sheet', label: 'asha-2.jpg', testStudentId: 'ts1', status: 'uploaded', remoteAssetId: 'r2' },
];

// Per-test override so the preview tests can exercise one-page and
// mixed-status papers; reset in beforeEach.
let currentAssets = null;

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
    assets: currentAssets || defaultAssets,
  };
}

const mockFetch = jest.fn((url, options = {}) => {
  const u = String(url);
  let body = {};
  const requestBody = options.body ? JSON.parse(options.body) : {};
  if (u.includes('/api/auth/session')) body = { user: { role: 'admin', username: 'mahadmin', school: 'Test School' } };
  else if (u.includes('/api/auth/features')) body = { features: {} };
  else if (u.includes('/api/intake/batches')) body = { batches: [] };
  else if (u.includes('/api/intake/devices')) body = { installations: [] };
  else if (u.includes('/api/teacher-dashboard')) body = {};
  else if (u.includes('/api/intake/tests?id=')) body = { test: testDetail() };
  else if (u.includes('/api/intake/tests')) body = { tests: [testSummary] };
  else if (u.includes('/api/intake/uploads') && requestBody.action === 'preview') body = { previewUrl: 'https://example.com/preview' };
  else if (u.includes('/api/intake/uploads')) body = {};
  return Promise.resolve({ ok: true, json: () => Promise.resolve(JSON.parse(JSON.stringify(body))) });
});

let alertSpy;

beforeEach(() => {
  jest.clearAllMocks();
  currentAssets = null;
  global.fetch = mockFetch;
  mockScanDocument.mockResolvedValue({ status: 'cancel' });
  mockAnalyzeScannedImages.mockResolvedValue({ textBlocks: [] });
  Image.getSize = jest.fn((uri, success) => success(800, 1200));
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  jest.spyOn(Linking, 'canOpenURL').mockResolvedValue(true);
  jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
});

afterEach(() => {
  alertSpy.mockRestore();
});

async function openTestEditor() {
  await render(<App />);
  await fireEvent.press(await screen.findByText('Open test'));
  await screen.findByText('Asha');
}

async function openScanSheet() {
  await openTestEditor();
  await fireEvent.press(screen.getAllByText('Scan')[0]);
  await screen.findByText('Existing paper found');
}

test('shows all five scan actions when the student already has pages', async () => {
  await openScanSheet();
  expect(screen.getByText(/Asha already has 2 uploaded page\(s\)/)).toBeTruthy();
  expect(screen.getByText('Preview paper')).toBeTruthy();
  expect(screen.getByText('Add pages')).toBeTruthy();
  expect(screen.getByText('Replace paper')).toBeTruthy();
  expect(screen.getByText('Remove paper')).toBeTruthy();
  expect(screen.getByText('Cancel')).toBeTruthy();
});

test('Preview paper opens every uploaded page in upload order', async () => {
  await openScanSheet();
  await fireEvent.press(screen.getByText('Preview paper'));
  await waitFor(() => expect(screen.queryByText('Existing paper found')).toBeNull());
  await screen.findByText('Answer-sheet preview');
  expect(screen.getByText('Asha · Page 1 of 2')).toBeTruthy();
  let previewCalls = mockFetch.mock.calls.filter(([url]) => String(url).includes('/api/intake/uploads'));
  expect(JSON.parse(previewCalls[0][1].body)).toMatchObject({ action: 'preview', assetId: 'r1' });
  expect(Linking.openURL).not.toHaveBeenCalled();

  await fireEvent.press(screen.getByLabelText('Next page'));
  await screen.findByText('Asha · Page 2 of 2');
  previewCalls = mockFetch.mock.calls.filter(([url]) => String(url).includes('/api/intake/uploads'));
  expect(JSON.parse(previewCalls[1][1].body)).toMatchObject({ action: 'preview', assetId: 'r2' });
  expect(screen.getByLabelText('Previous page').props.accessibilityState.disabled).toBe(false);
});

test('a one-page paper still previews with navigation disabled', async () => {
  currentAssets = [
    { id: 'a1', kind: 'answer_sheet', label: 'asha-1.jpg', testStudentId: 'ts1', status: 'uploaded', remoteAssetId: 'r1' },
  ];
  await openScanSheet();
  await fireEvent.press(screen.getByText('Preview paper'));
  await screen.findByText('Answer-sheet preview');
  expect(screen.getByText('Asha · Page 1 of 1')).toBeTruthy();
  const previewCalls = mockFetch.mock.calls.filter(([url]) => String(url).includes('/api/intake/uploads'));
  expect(JSON.parse(previewCalls[0][1].body)).toMatchObject({ action: 'preview', assetId: 'r1' });
  expect(screen.getByLabelText('Previous page').props.accessibilityState.disabled).toBe(true);
  expect(screen.getByLabelText('Next page').props.accessibilityState.disabled).toBe(true);
});

test('superseded, failed, and pending assets are excluded from the preview', async () => {
  currentAssets = [
    { id: 'a1', kind: 'answer_sheet', label: 'asha-1.jpg', testStudentId: 'ts1', status: 'uploaded', remoteAssetId: 'r1' },
    { id: 'a2', kind: 'answer_sheet', label: 'asha-2.jpg', testStudentId: 'ts1', status: 'superseded', remoteAssetId: 'r2' },
    { id: 'a3', kind: 'answer_sheet', label: 'asha-3.jpg', testStudentId: 'ts1', status: 'failed', remoteAssetId: null },
    { id: 'a4', kind: 'answer_sheet', label: 'asha-4.jpg', testStudentId: 'ts1', status: 'registered', remoteAssetId: null },
    { id: 'a5', kind: 'answer_sheet', label: 'asha-5.jpg', testStudentId: 'ts1', status: 'uploading', remoteAssetId: null },
  ];
  await openScanSheet();
  expect(screen.getByText(/Asha already has 1 uploaded page\(s\)/)).toBeTruthy();
  await fireEvent.press(screen.getByText('Preview paper'));
  await screen.findByText('Answer-sheet preview');
  expect(screen.getByText('Asha · Page 1 of 1')).toBeTruthy();
  const previewCalls = mockFetch.mock.calls.filter(([url]) => String(url).includes('/api/intake/uploads'));
  expect(previewCalls).toHaveLength(1);
  expect(JSON.parse(previewCalls[0][1].body)).toMatchObject({ action: 'preview', assetId: 'r1' });
});

test('Cancel closes the sheet without opening the scanner', async () => {
  await openScanSheet();
  await fireEvent.press(screen.getByText('Cancel'));
  await waitFor(() => expect(screen.queryByText('Existing paper found')).toBeNull());
  expect(mockScanDocument).not.toHaveBeenCalled();
});

test('Add pages closes the sheet and scans in append mode', async () => {
  mockScanDocument.mockResolvedValue({ status: 'success', scannedImages: ['file://scan1.jpg'] });
  await openScanSheet();
  await fireEvent.press(screen.getByText('Add pages'));
  await waitFor(() => expect(screen.queryByText('Existing paper found')).toBeNull());
  expect(mockScanDocument).toHaveBeenCalledTimes(1);
  expect(await screen.findByText('Use 1 page(s)')).toBeTruthy();
});

test('Replace paper closes the sheet and scans in replace mode', async () => {
  mockScanDocument.mockResolvedValue({ status: 'success', scannedImages: ['file://scan1.jpg'] });
  await openScanSheet();
  await fireEvent.press(screen.getByText('Replace paper'));
  await waitFor(() => expect(screen.queryByText('Existing paper found')).toBeNull());
  expect(mockScanDocument).toHaveBeenCalledTimes(1);
  expect(await screen.findByText('Replace with 1 page(s)')).toBeTruthy();
});

test('Remove paper closes the sheet and asks for destructive confirmation', async () => {
  await openScanSheet();
  await fireEvent.press(screen.getByText('Remove paper'));
  await waitFor(() => expect(screen.queryByText('Existing paper found')).toBeNull());
  expect(alertSpy).toHaveBeenCalledWith(
    'Remove paper and re-upload?',
    expect.stringContaining('Remove all 2 uploaded page(s) for Asha?'),
    expect.any(Array),
  );
});

test('confirming removal calls the remove_answer_sheet backend action', async () => {
  await openScanSheet();
  await fireEvent.press(screen.getByText('Remove paper'));
  await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('Remove paper and re-upload?', expect.any(String), expect.any(Array)));
  const [, , buttons] = alertSpy.mock.calls.find(([title]) => title === 'Remove paper and re-upload?');
  await act(async () => {
    await buttons.find((button) => button.text === 'Remove paper').onPress();
  });
  await waitFor(() => expect(mockFetch).toHaveBeenCalledWith(
    expect.stringContaining('/api/intake/uploads'),
    expect.objectContaining({ method: 'POST' }),
  ));
  const uploadCall = mockFetch.mock.calls.find(([url]) => String(url).includes('/api/intake/uploads'));
  expect(JSON.parse(uploadCall[1].body)).toMatchObject({ action: 'remove_answer_sheet', testId: 't1', testStudentId: 'ts1' });
  await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('Paper removed', expect.stringContaining('Asha\'s uploaded pages and history were removed'), expect.any(Array)));
});

test('opens the scanner directly when the student has no pages', async () => {
  await openTestEditor();
  await fireEvent.press(screen.getAllByText('Scan')[1]);
  expect(screen.queryByText('Existing paper found')).toBeNull();
  expect(mockScanDocument).toHaveBeenCalledTimes(1);
});

test('returns to the roster immediately and keeps local pages when upload is queued', async () => {
  mockScanDocument.mockResolvedValue({ status: 'success', scannedImages: ['file://scan1.jpg', 'file://scan2.jpg'] });
  Image.getSize = jest.fn((uri, success) => success(1600, 1200));
  require('expo-file-system/legacy').getInfoAsync.mockResolvedValue({ exists: true, size: 200000 });
  global.fetch = jest.fn((url, options = {}) => {
    const u = String(url);
    if (u.startsWith('file://')) return Promise.resolve({ ok: true, blob: () => Promise.resolve(new Blob(['fake-page'])) });
    const requestBody = options.body ? JSON.parse(options.body) : {};
    if (u.includes('/api/intake/uploads') && requestBody.action === 'create') {
      return Promise.resolve({ ok: false, json: () => Promise.resolve({ error: 'simulated storage failure' }) });
    }
    return mockFetch(url, options);
  });
  await openTestEditor();
  await fireEvent.press(screen.getAllByText('Scan')[1]);
  await fireEvent.press(await screen.findByText('Use 2 page(s)'));
  await waitFor(() => expect(screen.queryByText('Use 2 page(s)')).toBeNull());
  expect(mockScanDocument).toHaveBeenCalledTimes(1);
  expect(alertSpy).not.toHaveBeenCalledWith('Could not upload paper', expect.anything());
});

// FLKRM-111: the page indicator must stay visible next to the pager, not only
// in the modal header, and Previous/Next keep equal flex widths.
test('preview keeps a persistent page indicator beside equal-width pager actions', async () => {
  await openScanSheet();
  await fireEvent.press(screen.getByText('Preview paper'));
  await screen.findByText('Answer-sheet preview');

  // Header caption and the pager indicator both report the same position.
  expect(screen.getByText('Asha · Page 1 of 2')).toBeTruthy();
  expect(screen.getByText('Page 1 of 2')).toBeTruthy();

  await fireEvent.press(screen.getByLabelText('Next page'));
  await screen.findByText('Page 2 of 2');
  expect(screen.getByText('Asha · Page 2 of 2')).toBeTruthy();

  const flatten = (style) => Object.assign({}, ...[].concat(style).filter(Boolean));
  const previous = flatten(screen.getByLabelText('Previous page').props.style);
  const next = flatten(screen.getByLabelText('Next page').props.style);
  expect(previous.flex).toBe(1);
  expect(next.flex).toBe(1);
  expect(previous.minHeight).toBeGreaterThanOrEqual(44);
  expect(next.minHeight).toBeGreaterThanOrEqual(44);
});

// FLKRM-111: reference actions must be state-driven and separated by weight.
test('reference panel separates primary, secondary and destructive actions by state', async () => {
  currentAssets = [
    { id: 'a1', kind: 'answer_sheet', label: 'asha-1.jpg', testStudentId: 'ts1', status: 'uploaded', remoteAssetId: 'r1' },
    { id: 'q1', kind: 'question_paper', label: 'paper.pdf', testStudentId: null, status: 'uploaded', remoteAssetId: 'rq' },
    { id: 'k1', kind: 'answer_key', label: 'key.pdf', testStudentId: null, status: 'uploaded', remoteAssetId: 'rk' },
  ];
  await openTestEditor();

  // Uploaded reference files expose Preview (primary) and Replace (secondary).
  // There is no server action to delete an uploaded reference, so no Remove is offered.
  expect(screen.getAllByText('Preview')).toHaveLength(2);
  expect(screen.queryByText('Remove')).toBeNull();
  expect(screen.getAllByText('Replace')).toHaveLength(2);
  // No "Not uploaded" state remains once both references are present.
  expect(screen.queryByText('Not uploaded')).toBeNull();

  const flatten = (style) => Object.assign({}, ...[].concat(style).filter(Boolean));
  const preview = flatten(screen.getAllByLabelText('Preview Question paper')[0].props.style);
  const replace = flatten(screen.getAllByLabelText('Replace Question paper')[0].props.style);
  // Primary preview is a filled control; secondary replace is outlined and clearly distinct.
  expect(preview.backgroundColor).toBe(palette.ink);
  expect(replace.backgroundColor).not.toBe(preview.backgroundColor);
  expect(preview.backgroundColor).not.toBe(replace.borderColor);
  expect(screen.getAllByLabelText('Preview Question paper')[0].props.accessibilityState.disabled).toBe(false);
});

// FLKRM-111: a missing reference must not offer preview/remove, only Upload.
test('reference panel shows only Upload when a file is absent', async () => {
  currentAssets = [
    { id: 'a1', kind: 'answer_sheet', label: 'asha-1.jpg', testStudentId: 'ts1', status: 'uploaded', remoteAssetId: 'r1' },
  ];
  await openTestEditor();

  expect(screen.getAllByText('Upload')).toHaveLength(2);
  expect(screen.getAllByText('Not uploaded')).toHaveLength(2);
  expect(screen.queryByText('Preview')).toBeNull();
  expect(screen.queryByText('Remove')).toBeNull();
});

// FLKRM-111: a disabled reference action must explain why it is unavailable.
// An interrupted server row is durable and must NOT be mistaken for a live
// upload: the upload queue is the only source of truth for a file in flight.
test('a stale interrupted reference row is not reported as uploading', async () => {
  currentAssets = [
    { id: 'a1', kind: 'answer_sheet', label: 'asha-1.jpg', testStudentId: 'ts1', status: 'uploaded', remoteAssetId: 'r1' },
    { id: 'q1', kind: 'question_paper', label: 'paper.pdf', testStudentId: null, status: 'uploading', remoteAssetId: null },
    { id: 'k1', kind: 'answer_key', label: 'key.pdf', testStudentId: null, status: 'uploaded', remoteAssetId: 'rk' },
  ];
  await openTestEditor();

  // normalizeUploadAssets rewrites the stale in-flight row to failed, and no live
  // queue entry exists, so the panel must offer a retryable Upload.
  expect(screen.queryByText('Uploading')).toBeNull();
  expect(screen.getAllByText('Failed')).toHaveLength(1);
  const upload = screen.getByLabelText('Upload Question paper');
  expect(upload.props.accessibilityState.disabled).toBe(false);
});

// FLKRM-111: a failed reference upload must surface a retryable Upload action.
test('a failed reference upload shows the failure and keeps Upload available', async () => {
  currentAssets = [
    { id: 'a1', kind: 'answer_sheet', label: 'asha-1.jpg', testStudentId: 'ts1', status: 'uploaded', remoteAssetId: 'r1' },
    { id: 'q1', kind: 'question_paper', label: 'paper.pdf', testStudentId: null, status: 'failed', remoteAssetId: null, error: 'network' },
  ];
  await openTestEditor();

  expect(screen.getByText('This file could not be uploaded.')).toBeTruthy();
  const upload = screen.getByLabelText('Upload Question paper');
  expect(upload.props.accessibilityState.disabled).toBe(false);
  expect(screen.getAllByText('Failed')).toHaveLength(1);
});
