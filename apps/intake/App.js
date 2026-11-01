import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState, FlatList, Image, KeyboardAvoidingView, Linking, Modal, Platform, Pressable, RefreshControl, ScrollView, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import DocumentScanner from '@preeternal/react-native-document-scanner-plugin';
import { canQueueProcessing, canSubmitRecheck, draftKey, workspaceKey, EXAM_TYPES, MAX_TEST_TITLE_LENGTH, SUBJECTS, buildCalendarWeeks, filterStudentsByName, isResumableDraft, localDateString, mobileAnswerSheetPath, mobileRoleCapabilities, normalizeDraft, normalizeExamDate, normalizeExamType, normalizeUploadAssets, parseStoredWorkspace, pendingScanForOpenedTest, processingBlockReason, resumeEditorTestId, scanQualityWarnings, singleActiveQueueTestId, studentPageCounterKey, calculateNextPageNumber, extractPageNumberFromFilename } from './src/workflow';
import {
  UPLOAD_CONCURRENCY,
  UPLOAD_PUT_TIMEOUT_MS,
  appendQueueItems,
  buildScanQueueItems,
  claimNextQueueItems,
  classifyUploadError,
  countsForStudent,
  discardableItems,
  dropBlockingItemsForStudent,
  hasActiveUploads,
  lockItemsForTests,
  lockedBannerText,
  lockedPagesByTest,
  unlockItemsForTest,
  unsentLocalPageCount,
  nextAttemptAt,
  nextDrainAt,
  normalizePersistedQueue,
  pendingLocalPageCount,
  pickNextQueueItem,
  pickPendingReplaceGroupId,
  queueBannerText,
  queueStorageKey,
  reconcileUploadQueue,
  replaceGroupItems,
  retryFailedItems,
  studentHasBlockingUploads,
  studentScanLine,
  summarizeQueue,
  wakeQueuedUploads,
  withExpectedPageCount,
} from './src/uploadQueue';
import { activateUploadKeepAwake, prepareScanUpload } from './src/prepareScanUpload';
import { putFileWithTimeout, withTimeout } from './src/uploadTransfer';
import { moveScanFile, scanAreaRoot, scanFolder } from './src/scanStorage';
import { collectLocalScanPages, planLocalScanRecovery } from './src/localScanRecovery';
import { isExpoGoRuntime, isScannerBusyError, isScannerCancelError, scannerUnavailableMessage } from './src/scannerErrors';
import {
  clearScanSession,
  createScanSession,
  isRecoverableScanSession,
  planScanRecovery,
  readScanSession,
  writeScanSession,
} from './src/scanSession';
import { consumePendingScanResult, discardPendingScanResult } from './src/nativeScanResult';
import { resolveApiOrigin } from './src/runtimeConfig';
import { readCachedResponse, writeCachedResponse, isCacheFresh, setApiCacheNamespace, clearApiCache } from './src/apiCache';
import { resolveCachedImages, setAssetCacheNamespace, clearAssetCache } from './src/assetCache';
import { createApiClient } from './src/apiClient';
import { AdminDashboard, StudentDashboard, StudentSubjectDashboard } from './src/RoleDashboards';
import { OfflineBanner } from './src/dashboardShared';
import { resolveNotificationSubject } from './src/studentReportHelpers';
import { SchoolProfileScreen, StudentProfileScreen } from './src/ProfileScreens';
import { trackIntakeEvent } from './src/analytics';
import ErrorBoundary from './src/ErrorBoundary';
import { palette, type, radius, shadow, pressedSink } from './src/theme';
import NotebookLoader from './src/NotebookLoader';
import { useAppFonts } from './src/fonts';
import { SafeAreaProvider, SafeAreaView, InsetBottom, spacing } from './src/safeArea';
import { fetchSessionWithRetry, readStoredToken, writeStoredToken, readStoredUser, clearStoredToken, getSessionGeneration, bumpSessionGeneration } from './src/authStore';
import { ScanReviewModal } from './src/ScanReviewModal';
import { shareReportPdf } from './src/reportPdf';
import { configureForegroundNotifications, registerForPushNotifications, routeForNotification, subscribeToNotificationTaps } from './src/pushRegistration';
import { canAcceptAnswerSheetUpload } from '@skyll/shared/workflowLifecycle.js';

const API_ORIGIN = resolveApiOrigin();
// Palette is imported from src/theme.js — see that file for the single source.
const skyllLogo = require('./assets/skyll-logo.png');
const api = createApiClient(API_ORIGIN);

function blockedAnswerSheetTestIds(testList = [], openTest = null) {
  const blocked = new Set();
  for (const entry of testList || []) {
    if (entry?.id && !canAcceptAnswerSheetUpload({ testStatus: entry.status })) blocked.add(entry.id);
  }
  if (openTest?.id && !canAcceptAnswerSheetUpload({ testStatus: openTest.status, hasActiveProcessingJob: Boolean(openTest.job && (openTest.job.status === 'queued' || openTest.job.status === 'running')) })) {
    blocked.add(openTest.id);
  }
  return blocked;
}

function Badge({ children, tone = 'neutral' }) { return <View style={[styles.badge, tone === 'ready' && styles.readyBadge, tone === 'warn' && styles.warnBadge]}><Text style={[styles.badgeText, tone === 'ready' && styles.readyBadgeText, tone === 'warn' && styles.warnBadgeText]}>{children}</Text></View>; }

// Small drawn glyphs (no icon font or SVG dependency, so they ship in an OTA update).
function SearchGlyph() { return <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.searchGlyph}><View style={styles.searchGlyphRing} /><View style={styles.searchGlyphHandle} /></View>; }
function UploadGlyph() { return <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.uploadGlyph}><Text style={styles.uploadGlyphText}>↑</Text></View>; }
function ScanGlyph() { return <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.scanGlyph}><View style={[styles.scanGlyphCorner, styles.scanGlyphTL]} /><View style={[styles.scanGlyphCorner, styles.scanGlyphTR]} /><View style={[styles.scanGlyphCorner, styles.scanGlyphBL]} /><View style={[styles.scanGlyphCorner, styles.scanGlyphBR]} /><View style={styles.scanGlyphLine} /></View>; }
function initialsOf(name = '') { return String(name).trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || '?'; }

function getImageSize(uri) {
  return new Promise((resolve) => {
    Image.getSize(uri, (width, height) => {
      resolve({ width, height });
    }, () => resolve({ width: 0, height: 0 }));
  });
}

function App() {
  const [accessToken, setAccessToken] = useState(null);
  const [bootstrapping, setBootstrapping] = useState(true);
  const [updateState, setUpdateState] = useState('checking');
  const [sessionRestoreFailed, setSessionRestoreFailed] = useState(false);
  const [user, setUser] = useState(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loginError, setLoginError] = useState('');
  const passwordRef = useRef(null);
  const [title, setTitle] = useState('');
  const [subject, setSubject] = useState('Chemistry');
  const [examDate, setExamDate] = useState(localDateString());
  const [examType, setExamType] = useState('subjective');
  const [batches, setBatches] = useState([]);
  const [selectedBatchIds, setSelectedBatchIds] = useState([]);
  const [batchesLoading, setBatchesLoading] = useState(false);
  const [batchPickerOpen, setBatchPickerOpen] = useState(false);
  const [batchPickerMode, setBatchPickerMode] = useState('create');
  const [test, setTest] = useState(null);
  const [tests, setTests] = useState([]);
  const [refreshingTests, setRefreshingTests] = useState(false);
  const [installations, setInstallations] = useState([]);
  const [screen, setScreen] = useState('home');
  const screenRef = useRef(screen);
  useEffect(() => { screenRef.current = screen; }, [screen]);
  // A background update that downloaded while the operator was mid-sitting.
  // It is applied when they are back on the tests list, never over their work.
  const pendingReloadRef = useRef(false);
  const [profileReturnScreen, setProfileReturnScreen] = useState('home');
  const [assets, setAssets] = useState([]);
  const assetsRef = useRef(assets);
  useEffect(() => { assetsRef.current = assets; }, [assets]);
  const [job, setJob] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pendingScan, setPendingScan] = useState(null);
  // Synchronous re-entrancy lock for the native document scanner. `busy` alone
  // is not enough: state updates are async, so rapid taps in one tick can both
  // observe busy === false and start overlapping scan sessions.
  const scanningRef = useRef(false);
  const [uploadQueue, setUploadQueue] = useState([]);
  const [queueHydrated, setQueueHydrated] = useState(false);
  const [localRecoveryNote, setLocalRecoveryNote] = useState('');
  const recoveryInFlightRef = useRef(false);
  const reconcileInFlightRef = useRef(false);
  const scansByStudentRef = useRef({});
  const [draftReady, setDraftReady] = useState(false);
  const [draftRestored, setDraftRestored] = useState(false);
  const [intakeReady, setIntakeReady] = useState(false);
  const [studentContext, setStudentContext] = useState(null);
  const [studentLoadError, setStudentLoadError] = useState('');
  const [teacherContext, setTeacherContext] = useState(null);
  // True while a dashboard is showing cached data because the last revalidation
  // failed (offline). Drives the "offline — showing saved" banner + Retry.
  const [studentOffline, setStudentOffline] = useState(false);
  const [teacherOffline, setTeacherOffline] = useState(false);
  const [roleDataLoading, setRoleDataLoading] = useState(false);
  const [activeSubject, setActiveSubject] = useState(null);
  const [activeExamName, setActiveExamName] = useState('');
  const [viewedStudentUsername, setViewedStudentUsername] = useState('');
  const [sharingReport, setSharingReport] = useState(false);
  const [answerSheet, setAnswerSheet] = useState(null);
  const [rechecks, setRechecks] = useState([]);
  const [featureFlags, setFeatureFlags] = useState({ mobile_portal_v2: false });
  const [scanOptionsStudent, setScanOptionsStudent] = useState(null);
  const [studentPaperPreview, setStudentPaperPreview] = useState(null);
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(() => { const d = new Date(); return { year: d.getFullYear(), month: d.getMonth() }; });
  const [batchSearch, setBatchSearch] = useState('');
  const [studentSearchQuery, setStudentSearchQuery] = useState('');
  const [renameTarget, setRenameTarget] = useState(null);
  const [renameTitle, setRenameTitle] = useState('');
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const updateCheckInFlightRef = useRef(false);
  const lastQuietUpdateCheckAtRef = useRef(0);
  const uploadQueueRef = useRef([]);
  const accessTokenRef = useRef(accessToken);
  const pushTokenRef = useRef(null);
  const notificationTapRef = useRef(null);
  const testRef = useRef(test);
  // Set synchronously inside restoreDraft so boot-time scan recovery can see
  // the restored test before React has committed the setTest() render.
  const draftTestRef = useRef(null);
  const userRef = useRef(user);
  const appStateRef = useRef(AppState.currentState);
  // Live upload attempts in this process, keyed by queue item id. Slots are
  // counted from this map (not a bare counter), so an attempt that is
  // reclaimed as stuck frees its slot and its late result is ignored.
  const inFlightUploadsRef = useRef(new Map());
  const replaceCommitInFlightRef = useRef(false);
  // Set while a 401 is being checked against the session endpoint; the drain
  // does not start new pages until the check settles.
  const uploadsPausedRef = useRef(false);
  const uploadSessionCheckRef = useRef(null);
  const drainTimerRef = useRef(null);
  const rosterRefreshTimerRef = useRef(null);
  const drainUploadQueueRef = useRef(async () => {});
  const authUploadAlertRef = useRef(false);
  const pendingScanRef = useRef(null);
  const retakingRef = useRef(false);
  const confirmingScanRef = useRef(false);
  const [testsLoaded, setTestsLoaded] = useState(false);
  const testsRef = useRef([]);

  // The single write path for the upload queue. `uploadQueueRef` is the source
  // of truth and is updated synchronously, so concurrent async steps (upload
  // results, reconcile, recovery, the drain) each transform the latest queue
  // instead of overwriting each other with stale snapshots.
  function updateQueue(transform) {
    const current = uploadQueueRef.current;
    const next = typeof transform === 'function' ? transform(current) : transform;
    if (!Array.isArray(next) || next === current) return current;
    uploadQueueRef.current = next;
    setUploadQueue(next);
    return next;
  }

  useEffect(() => { pendingScanRef.current = pendingScan; }, [pendingScan]);
  useEffect(() => { accessTokenRef.current = accessToken; }, [accessToken]);
  useEffect(() => { testRef.current = test; }, [test]);
  useEffect(() => { userRef.current = user; }, [user]);

  function persistUploadQueueSnapshot(items) {
    const nextUser = userRef.current;
    if (!nextUser || !queueHydrated) return;
    AsyncStorage.setItem(queueStorageKey(nextUser), JSON.stringify(items)).catch(() => {});
  }

  async function pullAppUpdate({ manual = false, quiet = false } = {}) {
    try {
      if (!Updates.isEnabled) {
        if (manual) {
          Alert.alert('Updates unavailable', 'This install cannot receive over-the-air updates.');
        }
        if (!quiet) setUpdateState('ready');
        return false;
      }

      // Foreground re-checks are cheap to skip; avoid stacking network work while scanning/navigating.
      if (quiet) {
        const now = Date.now();
        if (updateCheckInFlightRef.current) return false;
        if (now - lastQuietUpdateCheckAtRef.current < 5 * 60 * 1000) return false;
        lastQuietUpdateCheckAtRef.current = now;
      }
      if (updateCheckInFlightRef.current && !manual) return false;
      updateCheckInFlightRef.current = true;

      if (manual) setCheckingUpdate(true);
      const update = await Updates.checkForUpdateAsync();
      if (!update.isAvailable) {
        if (!quiet) setUpdateState('ready');
        if (manual) {
          Alert.alert(
            'You are up to date',
            `Runtime ${Updates.runtimeVersion || 'unknown'}\nCurrent update: ${Updates.updateId || 'embedded bundle'}`,
          );
        }
        return false;
      }
      // Foreground (quiet) checks download in the background and never take
      // over the screen; only launch and manual checks show the update splash.
      if (!quiet) setUpdateState('installing');
      await Updates.fetchUpdateAsync();
      if (hasActiveUploads(uploadQueueRef.current) || (quiet && screenRef.current !== 'home')) {
        pendingReloadRef.current = true;
        if (!quiet) setUpdateState('ready');
        return false;
      }
      await Updates.reloadAsync();
      return true;
    } catch (error) {
      const message = error.message || 'Could not check for app updates.';
      if (manual || quiet) {
        if (!quiet) setUpdateState('ready');
        if (manual) Alert.alert('Update check failed', message);
      } else {
        // A failed optional update check must NOT block the app. The user
        // should continue into the signed-in experience with their draft and
        // upload queue intact. Only a server-enforced minimum-version block
        // (checked separately during session validation) may hard-block the app.
        setUpdateState('ready');
      }
      return false;
    } finally {
      updateCheckInFlightRef.current = false;
      if (manual) setCheckingUpdate(false);
    }
  }

  async function restoreDraft(nextUser) {
    setDraftReady(false);
    try {
      const saved = await AsyncStorage.getItem(draftKey(nextUser));
      if (!saved) return normalizeDraft({});
      const draft = normalizeDraft(JSON.parse(saved));
      setTitle(draft.title);
      setSubject(draft.subject);
      setExamDate(draft.examDate || localDateString());
      setExamType(draft.examType);
      setSelectedBatchIds(draft.selectedBatchIds);
      setTest(draft.test);
      draftTestRef.current = draft.test || null;
      assetsRef.current = draft.assets;
      setAssets(draft.assets);
      setJob(draft.job);
      // A page that is no longer on disk cannot be reviewed (it was moved to
      // the outbox by a confirm that finished just before the app died, or
      // was discarded). Keep only pages that still exist.
      const restoredScan = await existingPendingScanPages(draft.pendingScan);
      pendingScanRef.current = restoredScan;
      setPendingScan(restoredScan);
      setDraftRestored(isResumableDraft({ ...draft, pendingScan: restoredScan }));
      return { ...draft, pendingScan: restoredScan };
    } catch {
      await AsyncStorage.removeItem(draftKey(nextUser));
      return normalizeDraft({});
    } finally {
      setDraftReady(true);
    }
  }

  async function existingPendingScanPages(scan) {
    if (!scan?.pages?.length) return scan || null;
    const kept = [];
    for (const page of scan.pages) {
      if (!page?.uri) continue;
      try {
        const info = await FileSystem.getInfoAsync(page.uri);
        if (info.exists === false) continue;
      } catch {
        // Unknown: keep it rather than lose an unconfirmed page.
      }
      kept.push(page);
    }
    return kept.length ? { ...scan, pages: kept } : null;
  }

  async function readWorkspace(nextUser) {
    try {
      const raw = await AsyncStorage.getItem(workspaceKey(nextUser));
      return parseStoredWorkspace(raw);
    } catch {
      return null;
    }
  }

  function rememberWorkspace(nextScreen, nextTestId = '') {
    const current = userRef.current;
    if (!current || (current.role !== 'admin' && current.role !== 'scanner')) return;
    AsyncStorage.setItem(workspaceKey(current), JSON.stringify({
      screen: nextScreen === 'editor' ? 'editor' : 'home',
      testId: nextScreen === 'editor' && nextTestId ? nextTestId : '',
    })).catch(() => {});
  }

  async function restoreIntakeWorkspace(nextUser) {
    const [draft] = await Promise.all([
      restoreDraft(nextUser),
      loadUploadQueue(nextUser),
    ]);
    const workspace = await readWorkspace(nextUser);
    const testId = resumeEditorTestId({
      draft,
      workspace,
      queueTestId: singleActiveQueueTestId(uploadQueueRef.current),
    });
    if (testId) setScreen('editor');
    setIntakeReady(true);
    return { draft, workspace, testId };
  }

  async function loadUploadQueue(nextUser) {
    setQueueHydrated(false);
    try {
      const raw = await AsyncStorage.getItem(queueStorageKey(nextUser));
      const items = normalizePersistedQueue(raw ? JSON.parse(raw) : []);
      inFlightUploadsRef.current.clear();
      uploadQueueRef.current = items;
      setUploadQueue(items);
      await reconcileQueueAgainstDiskAndServer({});
    } catch {
      uploadQueueRef.current = [];
      setUploadQueue([]);
    } finally {
      setQueueHydrated(true);
    }
  }

  async function reconcileQueueAgainstDiskAndServer(uploadedCounts = scansByStudentRef.current) {
    if (reconcileInFlightRef.current) return uploadQueueRef.current;
    reconcileInFlightRef.current = true;
    try {
      const active = uploadQueueRef.current.filter((item) => (
        item?.uri && (item.status === 'queued' || item.status === 'uploading' || item.status === 'failed')
      ));
      const missingUris = [];
      await Promise.all(active.map(async (item) => {
        try {
          const info = await FileSystem.getInfoAsync(item.uri);
          // Only a definite "not there" drops a row. A failed check (busy
          // storage, transient error) must never cost a page.
          if (info.exists === false) missingUris.push(item.uri);
        } catch {
          // keep the row
        }
      }));
      // Transform the queue as it is *now*: uploads may have finished while
      // the disk checks above were running.
      const inFlight = inFlightUploadsRef.current;
      let reclaimedIds = [];
      const next = updateQueue((current) => {
        const reconciled = reconcileUploadQueue(current, { missingUris, uploadedCounts, inFlightIds: inFlight });
        const changed = reconciled.length !== current.length || reconciled.some((item, index) => (
          item.id !== current[index]?.id
          || item.status !== current[index]?.status
          || Number(item.nextAttemptAt) !== Number(current[index]?.nextAttemptAt)
        ));
        if (!changed) return current;
        const before = new Map(current.map((item) => [item.id, item.status]));
        reclaimedIds = reconciled.filter((item) => before.get(item.id) === 'uploading' && item.status === 'queued').map((item) => item.id);
        return reconciled;
      });
      // A reclaimed attempt gives its slot back; its eventual result is ignored.
      for (const id of reclaimedIds) inFlight.delete(id);
      if (!next.some((item) => item.status === 'queued' || item.status === 'uploading' || item.status === 'failed')) {
        setLocalRecoveryNote('');
      }
      return next;
    } finally {
      reconcileInFlightRef.current = false;
    }
  }

  async function loadStudentContext(token = accessToken, usernameOverride = '', force = false) {
    if (!token) return null;
    // Stale-while-revalidate (parity with the teacher dashboard): paint the
    // cached report instantly so a cold start never blocks on the network, then
    // revalidate. The cache is namespaced per signed-in user and keyed per
    // viewed student, so an admin browsing several students never mixes them.
    const path = `/api/student-context${usernameOverride ? `?username=${encodeURIComponent(usernameOverride)}` : ''}`;
    const cached = await readCachedResponse(path);
    if (cached?.body) {
      setStudentContext(cached.body);
      setStudentLoadError('');
      if (!force && isCacheFresh(cached)) return cached.body;
    }
    setRoleDataLoading(true);
    setStudentLoadError('');
    try {
      const result = await api(path, {}, token);
      setStudentContext(result);
      setStudentOffline(false);
      await writeCachedResponse(path, result);
      if (result?.report) {
        trackIntakeEvent(api, token, 'report_viewed', {
          username: usernameOverride || null,
          surface: 'intake_student',
        });
        if (result.report.learner_dna || result.report.learning_dna) {
          trackIntakeEvent(api, token, 'dna_viewed', { surface: 'intake_student' });
        }
      }
      return result;
    } catch (error) {
      // A 404 means "no published report yet" — a normal empty state, not a
      // fault. Paint an empty sentinel so the dashboard shows its "no reports"
      // copy instead of an error, and never alert for it.
      if (error?.status === 404) { setStudentContext({ report: null }); setStudentOffline(false); return { report: null }; }
      // Stale data is already on screen and this was a background revalidation:
      // fail silently (SWR) rather than tearing down a readable report, but flag
      // it so the dashboard shows an "offline — showing saved" banner.
      if (cached?.body) { setStudentOffline(true); return cached.body; }
      // Nothing to show. The student dashboard renders a retryable inline error
      // state; an admin opening a student from Class Insights has no such
      // surface, so keep the alert for that path only.
      setStudentLoadError(error?.message || 'Could not load your report');
      if (usernameOverride) Alert.alert('Could not load report', error.message);
      return null;
    } finally { setRoleDataLoading(false); }
  }

  async function loadTeacherContext(token = accessToken, force = false) {
    if (!token) return;
    // Stale-while-revalidate: paint the cached dashboard instantly, then
    // refresh in the background so a cold start never blocks on the network.
    const cached = await readCachedResponse('/api/teacher-dashboard');
    if (cached?.body) {
      setTeacherContext(cached.body);
      if (!force && isCacheFresh(cached)) return;
    }
    setRoleDataLoading(true);
    try {
      const result = await api('/api/teacher-dashboard', {}, token);
      setTeacherContext(result);
      setTeacherOffline(false);
      await writeCachedResponse('/api/teacher-dashboard', result);
      trackIntakeEvent(api, token, 'class_insights_viewed', { surface: 'intake_admin' });
    } catch (error) {
      // Stale dashboard is on screen: flag it so the offline banner shows.
      if (cached?.body) setTeacherOffline(true);
      // Suppress the alert when stale data is already on screen and this was
      // only a background revalidation; surface it when there is nothing to
      // show or the user explicitly asked to refresh.
      if (!cached || force) Alert.alert('Could not load class insights', error.message);
    } finally { setRoleDataLoading(false); }
  }

  const loadTeacherExamData = useCallback(async (year, examId) => {
    return api(`/api/teacher-dashboard?year=${encodeURIComponent(year || '')}&exam_id=${encodeURIComponent(examId || '')}`, {}, accessToken);
  }, [accessToken]);

  async function loadFeatureFlags(token = accessToken) {
    if (!token) return;
    try { setFeatureFlags((await api('/api/auth/features', {}, token)).features || {}); } catch { setFeatureFlags({ mobile_portal_v2: false }); }
  }

  async function loadAnswerSheet(subjectName, token = accessToken, usernameOverride = '') {
    if (!token || !subjectName) return setAnswerSheet(null);
      const path = mobileAnswerSheetPath({ subject: subjectName, student: usernameOverride });
    const headers = { Authorization: `Bearer ${token}` };
    // Paint a page list into the gallery, preferring an on-disk copy of each
    // image so a cached report renders with no signal (offline-first). Pages we
    // don't have yet keep their remote URL and warm the disk cache in the
    // background. Returns true only when a non-empty gallery was painted.
    const paint = async (subject, pageNumbers) => {
      const numbers = Array.isArray(pageNumbers) ? pageNumbers : [];
      if (!numbers.length) return false;
      const imageBase = `${API_ORIGIN}${path}&page=`;
      const pages = await resolveCachedImages(numbers.map((page) => `${imageBase}${page}`), headers);
      setAnswerSheet({ subject: subject || subjectName, pages });
      return true;
    };
    // Stale-while-revalidate the page list (parity with loadStudentContext):
    // paint from cache instantly so a cold or offline open still shows the
    // sheet, then refresh. The images themselves are cached on disk.
    const cached = await readCachedResponse(path);
    if (cached?.body) {
      const painted = await paint(cached.body.subject, cached.body.pages);
      if (painted && isCacheFresh(cached)) return;
    }
    try {
      const result = await api(path, {}, token);
      await writeCachedResponse(path, result);
      await paint(result.subject, result.pages);
    } catch {
      // Offline with a stale cache already painted above: keep it. Nothing
      // cached at all: no sheet is available yet, so clear the gallery.
      if (!cached?.body) setAnswerSheet(null);
    }
  }

  async function loadRechecks(token = accessToken, subjectName = '') {
    if (!token || !subjectName) return setRechecks([]);
    try {
      const params = new URLSearchParams({ status: 'all', subject: subjectName });
      const result = await api(`/api/rechecks?${params.toString()}`, {}, token);
      setRechecks(Array.isArray(result?.requests) ? result.requests : []);
    } catch {
      // Status is a nicety, never a blocker: fall back to no known requests so
      // the submit form stays available.
      setRechecks([]);
    }
  }

  async function requestRecheck(question, reason) {
    const report = studentContext?.report;
    const submissionId = report?.student?.submission_id || report?.submission_id;
    if (!submissionId) return Alert.alert('Recheck unavailable', 'This report is not linked to its assessment yet.');
    if (!canSubmitRecheck({ submissionId, subject: activeSubject?.name, questionNumber: question.number, reason })) return Alert.alert('Add a little more detail', 'Please explain why this answer or mark should be checked again.');
    try {
      await api('/api/rechecks', { method: 'POST', body: JSON.stringify({ submissionId, subject: activeSubject?.name, questionNumber: question.number, reason }) }, accessToken);
      Alert.alert('Recheck sent', 'Your request is now visible to the review team.');
    } catch (error) {
      Alert.alert('Could not send recheck', error.message);
    } finally {
      // Refresh whether we succeeded or hit a 409 (one is already active) so the
      // question's status chip reflects the server immediately.
      if (activeSubject?.name) loadRechecks(accessToken, activeSubject.name);
    }
  }

  async function shareReport() {
    if (sharingReport) return; // avoid double-tap double-share
    const report = studentContext?.report || {};
    setSharingReport(true);
    try {
      const result = await shareReportPdf(report, { examId: '' });
      if (result.ok && result.mode === 'pdf') {
        trackIntakeEvent(api, accessToken, 'report_shared', { mode: 'pdf', surface: 'intake_student' });
      } else if (result.ok) {
        trackIntakeEvent(api, accessToken, 'report_shared', { mode: 'text_fallback', surface: 'intake_student' });
      } else {
        Alert.alert('Could not share report', 'PDF sharing is unavailable on this device right now. Please try again.');
      }
    } catch (error) {
      // Recoverable: the report view and its state are untouched.
      Alert.alert('Could not share report', error?.message || 'Something went wrong while preparing the share. Please try again.');
    } finally {
      setSharingReport(false);
    }
  }

  async function hydrateSignedInUser(nextUser, token) {
    // Feature flags do not gate any role's data — load them alongside the
    // role-specific hydration instead of ahead of it.
    const flagsPromise = loadFeatureFlags(token);
    if (nextUser.role === 'student') {
      setScreen('student');
      await Promise.all([loadStudentContext(token), reportDevice(token), flagsPromise]);
      return;
    }
    if (nextUser.role !== 'admin' && nextUser.role !== 'scanner') {
      throw new Error('This Skyll account is not available in the mobile app.');
    }
    const adminWork = nextUser.role === 'admin'
      ? [loadBatches(token), loadTeacherContext(token)]
      : [];
    const [{ draft, testId }] = await Promise.all([
      restoreIntakeWorkspace(nextUser),
      loadTests(token),
      reportDevice(token),
      flagsPromise,
      ...adminWork,
    ]);
    if (testId) {
      await openTest(testId, { token, pendingScan: draft?.pendingScan, keepScanSession: true });
    } else {
      setScreen('home');
    }
    // After the workspace (and therefore `test`) is restored, look for a scan
    // that was interrupted by Android reclaiming the process while the native
    // scanner was open.
    await recoverInterruptedScan(nextUser);
  }

  async function restoreSession() {
    setBootstrapping(true);
    setSessionRestoreFailed(false);
    const generation = bumpSessionGeneration();
    const token = await readStoredToken();
    if (!token) { setBootstrapping(false); return; }
    const cachedUser = await readStoredUser();
    if (cachedUser) {
      // Optimistic restore: paint the signed-in app immediately from the
      // cached identity (skipping the "Preparing your workspace..." splash
      // for returning users), then validate the session in the background.
      setApiCacheNamespace(cachedUser.username);
      setAssetCacheNamespace(cachedUser.username);
      setAccessToken(token);
      accessTokenRef.current = token;
      setUser(cachedUser);
      userRef.current = cachedUser;
      if (cachedUser.role === 'student') setRoleDataLoading(true);
      if (cachedUser.role === 'admin' || cachedUser.role === 'scanner') {
        await restoreIntakeWorkspace(cachedUser);
      }
      setBootstrapping(false);
      try {
        const result = await fetchSessionWithRetry(api, token);
        if (generation !== getSessionGeneration()) return; // superseded by a newer sign-in/out
        if (!result.user) {
          // The server explicitly rejected this session — only now sign out.
          await clearStoredToken();
          setRoleDataLoading(false);
          setUser(null); setAccessToken(null);
          return;
        }
        // Re-persist so a token recovered from the fallback is also written
        // back to SecureStore, keeping both stores in sync.
        await writeStoredToken(token, result.user);
        if (generation !== getSessionGeneration()) return; // signed out while writing
        setUser(result.user);
        userRef.current = result.user;
        await hydrateSignedInUser(result.user, token);
      } catch {
        // Transient failure (network drop or a brief server/database hiccup),
        // e.g. after Android recreates the activity when returning from the
        // native document scanner. Keep the optimistic session — the next
        // launch (or pull-to-refresh) revalidates it.
        if (cachedUser.role === 'student') setRoleDataLoading(false);
        else loadTests(token).catch(() => {});
      }
      return;
    }
    try {
      const result = await fetchSessionWithRetry(api, token);
      if (generation !== getSessionGeneration()) return;
      if (!result.user) {
        // The server confirmed this session is no longer valid.
        await clearStoredToken();
      } else {
        // Re-persist so a token recovered from the fallback is also written
        // back to SecureStore, keeping both stores in sync.
        setApiCacheNamespace(result.user.username);
        setAssetCacheNamespace(result.user.username);
        await writeStoredToken(token, result.user);
        setAccessToken(token); setUser(result.user); await hydrateSignedInUser(result.user, token);
      }
    } catch {
      // Transient failure (network drop or a brief server/database hiccup),
      // e.g. after Android recreates the activity when returning from the
      // native document scanner. Keep the stored token so the session can be
      // recovered instead of signing the user out.
      setSessionRestoreFailed(true);
    } finally {
      setBootstrapping(false);
    }
  }

  useEffect(() => {
    if (!user || !draftReady) return undefined;
    const payload = JSON.stringify({ title, subject, examDate, examType, selectedBatchIds, test, assets, job, pendingScan });
    if (pendingScan) {
      AsyncStorage.setItem(draftKey(user), payload).catch(() => {});
      return undefined;
    }
    const timer = setTimeout(() => {
      AsyncStorage.setItem(draftKey(user), payload).catch(() => {});
    }, 250);
    return () => clearTimeout(timer);
  }, [user, draftReady, title, subject, examDate, examType, selectedBatchIds, test, assets, job, pendingScan]);

  useEffect(() => {
    if (!user || !intakeReady) return undefined;
    if (user.role !== 'admin' && user.role !== 'scanner') return undefined;
    rememberWorkspace(screen, test?.id);
    return undefined;
  }, [user, screen, test?.id, intakeReady]);

  useEffect(() => {
    // Never persist until the durable queue has been loaded for this user.
    // Otherwise setUser() + empty initial state can overwrite hundreds of
    // waiting pages with [] on session restore / OTA reload.
    if (!user || !queueHydrated) return undefined;
    AsyncStorage.setItem(queueStorageKey(user), JSON.stringify(uploadQueue)).catch(() => {});
    return undefined;
  }, [user, uploadQueue, queueHydrated]);

  useEffect(() => {
    drainUploadQueue();
  }, [uploadQueue, accessToken, drainUploadQueue]);

  useEffect(() => {
    async function bootstrap() {
      // The OTA check runs concurrently with session restore so a returning
      // user is not blocked on the update server round-trip. The UI only
      // blocks when an update is actually available (or the check failed).
      pullAppUpdate({ manual: false });
      await restoreSession();
    }
    bootstrap().catch(() => { setUpdateState('ready'); });
  // The session bootstrap intentionally runs once; `loadBatches` receives the restored token directly.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Open the exact subject/exam a tapped "report ready" notification points at.
  // A cold start has no report yet, so load it first, resolve the subject by
  // testId + name, then drive the same state the dashboard's onOpenSubject does.
  // Any miss leaves the user on the student dashboard — never a dead end.
  async function openSubjectFromNotification(route) {
    const current = userRef.current;
    const token = accessTokenRef.current;
    setScreen('student');
    if (!current || !token || !route?.subject) return;
    const override = current.role === 'student' ? '' : viewedStudentUsername;
    const context = await loadStudentContext(token, override);
    const resolved = resolveNotificationSubject(context?.report, route);
    if (!resolved) return;
    setActiveSubject(resolved.subject);
    setActiveExamName(resolved.exam?.name || '');
    if (featureFlags.mobile_portal_v2) {
      loadAnswerSheet(resolved.subject.name, token, override);
      loadRechecks(token, resolved.subject.name);
    }
    setScreen(current.role === 'student' ? 'student-subject' : 'admin-student-subject');
  }

  // Route a tapped (warm) or cold-start notification for the signed-in user:
  // students drill into the specific subject, admins/scanners open the test the
  // "reports ready" summary refers to, everyone else lands on their home screen.
  function handleNotificationTap(data) {
    const current = userRef.current;
    if (!current) return;
    const route = routeForNotification(data, current.role);
    if (!route) return;
    if (route.screen === 'student' && route.subject) {
      openSubjectFromNotification(route).catch(() => setScreen('student'));
        return;
      }
    if (route.screen === 'home' && route.testId && current.role !== 'student') {
      setScreen('home');
      openTest(route.testId).catch(() => {});
      return;
    }
    setScreen(route.screen);
  }

  // Keep the tap handler fresh so the once-registered subscription below always
  // closes over current state (viewed student, feature flags, loaded report).
  useEffect(() => { notificationTapRef.current = handleNotificationTap; });

  useEffect(() => {
    // Register for push once per launch. The token is attached to the next
    // device report; when a session is already active we re-report immediately
    // so the server can target this device. Taps route the signed-in user to
    // the relevant screen. Everything is guarded inside pushRegistration, so
    // push can never block sign-in, scanning, or report viewing.
    configureForegroundNotifications();
    let cancelled = false;
    registerForPushNotifications()
      .then((token) => {
        if (cancelled || !token) return;
        pushTokenRef.current = token;
        if (accessTokenRef.current) reportDevice(accessTokenRef.current).catch(() => {});
      })
      .catch(() => {});
    const unsubscribeTaps = subscribeToNotificationTaps((data) => {
      notificationTapRef.current?.(data);
    });
    return () => { cancelled = true; unsubscribeTaps(); };
  // Runs once per launch; the effect only reads stable refs and setState.
  }, []);

  // Apply a deferred update once the operator is back on the tests list with
  // nothing uploading. A cold start would also apply it.
  useEffect(() => {
    if (screen !== 'home' || !pendingReloadRef.current || hasActiveUploads(uploadQueue)) return;
    pendingReloadRef.current = false;
    Updates.reloadAsync().catch(() => {});
  }, [screen, uploadQueue]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      appStateRef.current = nextState;
      if (nextState === 'active') {
        (async () => {
          updateQueue((current) => wakeQueuedUploads(current, Date.now()));
          const reconciled = await reconcileQueueAgainstDiskAndServer(scansByStudentRef.current);
          scheduleDrain(0);
          if (!hasActiveUploads(reconciled)) {
            pullAppUpdate({ manual: false, quiet: true });
          }
        })().catch(() => {});
      }
    });
    const heartbeat = setInterval(() => {
      if (!accessTokenRef.current) return;
      reconcileQueueAgainstDiskAndServer(scansByStudentRef.current)
        .then((items) => {
          if (!hasActiveUploads(items) && !nextDrainAt(items)) return;
          drainUploadQueueRef.current?.();
        })
        .catch(() => {});
    }, 5000);
    return () => {
      subscription.remove();
      clearInterval(heartbeat);
      if (drainTimerRef.current) clearTimeout(drainTimerRef.current);
      if (rosterRefreshTimerRef.current) clearTimeout(rosterRefreshTimerRef.current);
    };
  }, [reconcileQueueAgainstDiskAndServer]);

  async function reportDevice(token) {
    try {
      let installationId = await SecureStore.getItemAsync('skyll_intake_installation_id');
      if (!installationId) {
        installationId = `intake_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
        await SecureStore.setItemAsync('skyll_intake_installation_id', installationId);
      }
      await api('/api/intake/devices', {
        method: 'POST',
        body: JSON.stringify({
          installationId,
          platform: Platform.OS,
          appVersion: Constants.expoConfig?.version || Constants.nativeAppVersion || '',
          runtimeVersion: Updates.runtimeVersion || '',
          updateId: Updates.updateId || '',
          expoPushToken: pushTokenRef.current || undefined,
        }),
      }, token);
    } catch {
      // Update telemetry must never block scanning or sign-in.
    }
  }
  const referenceAssets = useMemo(() => assets.reduce((references, asset) => {
    if (asset.status === 'uploaded' && ['question_paper', 'answer_key'].includes(asset.kind)) references[asset.kind] = asset;
    return references;
  }, {}), [assets]);
  // FLKRM-111: a reference shows one state at a time. A retry can leave the
  // failed row it replaced in the list, so report the newest row matching each
  // state, in the order the upload flow moves through it. "Upload interrupted"
  // is a durable rewrite of a stale in-flight row, so a newer live retry wins.
  const referenceStateOf = (kind) => {
    const refs = assets
      .filter((a) => a.kind === kind)
      .map((a, index) => ({ a, index }))
      .sort((x, y) => x.index - y.index);
    const newest = (statuses) => refs.filter(({ a }) => statuses.includes(a.status)).pop()?.a;
    const live = newest(['uploading', 'registered']);
    if (live) return live.status === 'registered'
      ? { status: 'failed', asset: { ...live, error: live.error || 'Upload interrupted. Tap retry or discard to continue.' } }
      : { status: 'uploading', asset: live };
    const failed = newest(['failed']);
    if (failed) return { status: 'failed', asset: failed };
    const uploaded = refs.filter(({ a }) => a.status === 'uploaded').pop()?.a || referenceAssets[kind];
    if (uploaded) return { status: 'uploaded', asset: uploaded };
    return { status: 'none' };
  };
  const scansByStudent = useMemo(() => assets.filter((asset) => asset.status === 'uploaded' && asset.kind === 'answer_sheet').reduce((counts, asset) => ({ ...counts, [asset.testStudentId]: (counts[asset.testStudentId] || 0) + 1 }), {}), [assets]);
  useEffect(() => { scansByStudentRef.current = scansByStudent; }, [scansByStudent]);
  const canQueue = canQueueProcessing(assets, uploadQueue.filter((item) => item.testId === test?.id));
  const queueSummary = useMemo(() => summarizeQueue(uploadQueue, test?.id), [uploadQueue, test?.id]);
  const queueSummaryAll = useMemo(() => summarizeQueue(uploadQueue), [uploadQueue]);
  const queueBanner = queueBannerText(queueSummary.queued || queueSummary.uploading || queueSummary.failed ? queueSummary : queueSummaryAll);

  useEffect(() => {
    // After the durable queue loads (or was wiped), reattach confirmed JPEG
    // leftovers (outbox + legacy folders) so waiting pages can upload again.
    // Waits for the test list (lock state + which tests this account can see)
    // and the draft (pages still open in the review modal are excluded).
    if (!queueHydrated || !testsLoaded || !draftReady || !user || user.role === 'student') return undefined;
    const studentNames = Object.fromEntries((test?.students || []).map((student) => [student.testStudentId, student.name]));
    recoverLocalScans({
      testId: test?.id || null,
      uploadedCounts: scansByStudent,
      studentNames,
      announce: false,
    }).catch(() => {});
    return undefined;
  // Intentionally tied to hydration + open test identity, not every asset flicker.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueHydrated, testsLoaded, draftReady, user?.id, user?.username, test?.id]);
  const lockedGroups = useMemo(() => lockedPagesByTest(uploadQueue), [uploadQueue]);
  // Persistent: shown on the tests list and in every test until the operator
  // retries (after an admin reopens the test) or discards the pages.
  const lockedBanners = lockedGroups.length ? <View style={styles.lockedStack}>{lockedGroups.map((group) => {
    const title = (tests.find((entry) => entry.id === group.testId) || (test?.id === group.testId ? test : null))?.title;
    return <View key={group.testId} accessibilityLiveRegion="polite" style={styles.lockedBanner}>
      <Text style={styles.lockedBannerText}>{title ? `${title}: ` : ''}{lockedBannerText(group.count)}</Text>
      <View style={styles.lockedActions}>
        <Pressable accessibilityRole="button" accessibilityLabel={`Retry ${group.count} locked pages`} onPress={() => { retryLockedPages(group.testId).catch(() => {}); }} style={({ pressed }) => [styles.lockedAction, pressed && styles.pressedDim]}><Text style={styles.lockedActionText}>Retry</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={`Discard ${group.count} locked pages`} onPress={() => confirmDiscardQueueItems(group.items, 'unsent pages')} style={({ pressed }) => [styles.lockedAction, pressed && styles.pressedDim]}><Text style={styles.lockedDiscardText}>Discard</Text></Pressable>
      </View>
    </View>;
  })}</View> : null;
  const filteredBatches = useMemo(() => { const q = batchSearch.trim().toLowerCase(); if (!q) return batches; return batches.filter((batch) => [batch.name, batch.grade, batch.stream].filter(Boolean).some((field) => String(field).toLowerCase().includes(q))); }, [batches, batchSearch]);
  const filteredStudents = useMemo(() => filterStudentsByName(test?.students, studentSearchQuery), [test?.students, studentSearchQuery]);
  // Sitting mode (display only): who has pages, who is next, and the roster
  // filter pills. "Has pages" counts uploaded pages plus anything still in the
  // local upload queue, so a just-scanned student moves out of "To scan" at once.
  const [rosterFilter, setRosterFilter] = useState('all');
  const studentsWithPages = useMemo(() => {
    const withPages = new Set();
    for (const student of test?.students || []) {
      const queued = countsForStudent(uploadQueue, student.testStudentId);
      if ((scansByStudent[student.testStudentId] || 0) > 0 || queued.queuedCount || queued.uploadingCount || queued.failedCount) withPages.add(student.testStudentId);
    }
    return withPages;
  }, [test?.students, uploadQueue, scansByStudent]);
  const sittingTotal = test?.students?.length || 0;
  const sittingScanned = studentsWithPages.size;
  const nextUpStudent = useMemo(() => (test?.students || []).find((student) => !studentsWithPages.has(student.testStudentId)) || null, [test?.students, studentsWithPages]);
  const rosterStudents = useMemo(() => {
    if (rosterFilter === 'scanned') return filteredStudents.filter((student) => studentsWithPages.has(student.testStudentId));
    if (rosterFilter === 'to-scan') return filteredStudents.filter((student) => !studentsWithPages.has(student.testStudentId));
    return filteredStudents;
  }, [filteredStudents, rosterFilter, studentsWithPages]);
  const calendarWeeks = useMemo(() => buildCalendarWeeks(calendarMonth), [calendarMonth]);
  const todayStr = localDateString();
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const weekdayLabels = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

  async function loadBatches(token = accessToken, force = false) {
    if (!token) return;
    // Stale-while-revalidate: paint the cached roster instantly, then refresh
    // in the background so a cold start never blocks on the network.
    const cached = await readCachedResponse('/api/intake/batches');
    if (cached?.body?.batches) {
      setBatches(cached.body.batches);
      if (!force && isCacheFresh(cached)) return;
    }
    setBatchesLoading(true);
    try {
      const result = await api('/api/intake/batches', { forceRefresh: force }, token);
      setBatches(result.batches || []);
      await writeCachedResponse('/api/intake/batches', result);
    } catch (error) {
      if (error?.notModified) return;
      if (!cached || force) Alert.alert('Could not load batches', error.message);
    } finally { setBatchesLoading(false); }
  }

  async function loadTests(token = accessToken, force = false) {
    if (!token) return;
    // Stale-while-revalidate: paint the cached test list instantly, then
    // refresh in the background so a cold start never blocks on the network.
    const cached = await readCachedResponse('/api/intake/tests');
    if (cached?.body?.tests) {
      applyTestList(cached.body.tests);
      if (!force && isCacheFresh(cached)) return;
    }
    try {
      const result = await api('/api/intake/tests', { forceRefresh: force }, token);
      applyTestList(result.tests || []);
      await writeCachedResponse('/api/intake/tests', result);
    } catch (error) {
      if (error?.notModified) return;
      if (!cached || force) Alert.alert('Could not load tests', error.message);
    }
  }

  function applyTestList(testList = []) {
    const list = Array.isArray(testList) ? testList : [];
    testsRef.current = list;
    setTests(list);
    setTestsLoaded(true);
    lockQueueForBlockedTests(blockedAnswerSheetTestIds(list, testRef.current)).catch(() => {});
  }

  // Move every unsent page of a test that no longer accepts answer sheets to
  // the quarantine folder and mark it `locked`. Nothing is deleted: the
  // operator retries after an admin reopens the test, or discards explicitly.
  async function lockQueueForBlockedTests(blockedTestIds) {
    const blocked = blockedTestIds instanceof Set ? blockedTestIds : new Set(blockedTestIds || []);
    if (!blocked.size) return;
    const candidates = uploadQueueRef.current.filter((item) => (
      blocked.has(item.testId)
      && (item.status === 'queued' || item.status === 'failed' || (item.status === 'uploading' && !inFlightUploadsRef.current.has(item.id)))
    ));
    if (!candidates.length) return;
    const moves = await quarantineFiles(candidates);
    const ids = new Set(candidates.map((item) => item.id));
    updateQueue((current) => lockItemsForTests(current, blocked, moves, ids));
  }

  async function quarantineFiles(items = []) {
    const moves = {};
    for (const item of items) {
      if (!item?.uri) continue;
      try {
        const moved = await moveScanFile(FileSystem, item.uri, 'quarantine');
        if (moved) moves[item.id] = moved;
      } catch {
        // Leave the file where it is; the row is still marked locked.
      }
    }
    return moves;
  }

  async function openDeviceStatus() {
    setBusy(true);
    try {
      const result = await api('/api/intake/devices', {}, accessToken);
      setInstallations(result.installations || []);
      setScreen('devices');
    } catch (error) { Alert.alert('Could not load device status', error.message); } finally { setBusy(false); }
  }

  async function signIn() {
    bumpSessionGeneration();
    setBusy(true);
    setLoginError('');
    try {
      const result = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password, mobile: true }) });
      if (!mobileRoleCapabilities(result.user.role).canUseMobileApp) throw new Error('This Skyll account is not available in the mobile app.');
      await writeStoredToken(result.accessToken, result.user);
      setApiCacheNamespace(result.user.username);
      setAssetCacheNamespace(result.user.username);
      authUploadAlertRef.current = false;
      uploadsPausedRef.current = false;
      setAccessToken(result.accessToken); setUser(result.user); await hydrateSignedInUser(result.user, result.accessToken);
    } catch (error) { setLoginError(error.message || 'Sign in failed'); } finally { setBusy(false); }
  }

  function toggleBatch(batchId) {
    setSelectedBatchIds((current) => current.includes(batchId) ? current.filter((id) => id !== batchId) : [...current, batchId]);
  }
  const selectedBatches = useMemo(() => batches.filter((batch) => selectedBatchIds.includes(batch.id)), [batches, selectedBatchIds]);
  const selectedStudentCount = selectedBatches.reduce((total, batch) => total + batch.studentCount, 0);
  const permissions = mobileRoleCapabilities(user?.role);

  function startNewTest() {
    if (!permissions.canCreateTests) return Alert.alert('Scanner access only', 'This account can open existing tests and scan answer sheets.');
    setTitle(''); setSubject('Chemistry'); setExamDate(localDateString()); setExamType('subjective'); setSelectedBatchIds([]); setTest(null); setAssets([]); setJob(null); setPendingScan(null); setDraftRestored(false); setScreen('editor');
    rememberWorkspace('editor', '');
  }

  function resumeDraft() {
    const testId = test?.id;
    if (testId) {
      rememberWorkspace('editor', testId);
      openTest(testId, { pendingScan }).catch(() => setScreen('editor'));
      return;
    }
    rememberWorkspace('editor', '');
    setScreen('editor');
  }

  // Recursive listing of {root}/{testId}/{testStudentId}/*.jpg for one area.
  async function listScanAreaEntries(area) {
    const root = scanAreaRoot(FileSystem.documentDirectory, area);
    if (!root) return [];
    const rootInfo = await FileSystem.getInfoAsync(root).catch(() => null);
    if (!rootInfo?.exists) return [];
    const entries = [];
    let testIds = [];
    try {
      testIds = await FileSystem.readDirectoryAsync(root);
    } catch {
      return [];
    }
    for (const testId of testIds) {
      if (testId === 'references') continue;
      const testPath = `${root}${testId}/`;
      let studentIds = [];
      try {
        studentIds = await FileSystem.readDirectoryAsync(testPath);
      } catch {
        continue;
      }
      for (const testStudentId of studentIds) {
        if (testStudentId === 'references') continue;
        const studentPath = `${testPath}${testStudentId}/`;
        const studentInfo = await FileSystem.getInfoAsync(studentPath).catch(() => null);
        if (!studentInfo?.exists || !studentInfo.isDirectory) continue;
        let files = [];
        try {
          files = await FileSystem.readDirectoryAsync(studentPath);
        } catch {
          continue;
        }
        for (const file of files) {
          if (!/\.jpe?g$/i.test(file)) continue;
          const uri = `${studentPath}${file}`;
          const info = await FileSystem.getInfoAsync(uri).catch(() => null);
          if (!info?.exists || info.isDirectory) continue;
          entries.push({
            uri,
            byteSize: info.size || 0,
            modificationTime: info.modificationTime || 0,
          });
        }
      }
    }
    return entries;
  }

  // The review area is deliberately not listed: unconfirmed pages are never
  // recovered into the upload queue.
  async function listDurableScanEntries() {
    if (!FileSystem.documentDirectory) return [];
    const [outbox, quarantine, legacy] = await Promise.all([
      listScanAreaEntries('outbox'),
      listScanAreaEntries('quarantine'),
      listScanAreaEntries('legacy'),
    ]);
    return [...outbox, ...quarantine, ...legacy];
  }

  function knownTestIdsForRecovery() {
    const ids = new Set((testsRef.current || []).map((entry) => entry?.id).filter(Boolean));
    if (testRef.current?.id) ids.add(testRef.current.id);
    return ids;
  }

  async function recoverLocalScans({
    testId = null,
    uploadedCounts = {},
    studentNames = {},
    announce = false,
  } = {}) {
    if (recoveryInFlightRef.current) return 0;
    recoveryInFlightRef.current = true;
    try {
      const localPages = collectLocalScanPages(await listDurableScanEntries());
      const planOptions = {
        localPages,
        uploadedCounts,
        studentNames,
        testId,
        blockedTestIds: blockedAnswerSheetTestIds(testsRef.current, testRef.current),
        knownTestIds: knownTestIdsForRecovery(),
        excludeUris: (pendingScanRef.current?.pages || []).map((page) => page?.uri),
      };
      const planned = planLocalScanRecovery({ ...planOptions, existingQueue: uploadQueueRef.current });
      if (!planned.length) {
        setLocalRecoveryNote('');
        if (announce) {
          Alert.alert(
            'No waiting pages on this phone',
            'Skyll only keeps scan images until they finish uploading. Anything already on the server is safe; pages that never left this phone are gone if the files are missing.',
          );
        }
        return 0;
      }
      // Pages of a locked test go to quarantine before they join the queue so
      // a lost queue can never auto-upload them.
      const toQuarantine = planned.filter((item) => item.status === 'locked' && !/\/intake-quarantine\//.test(item.uri));
      const moves = await quarantineFiles(toQuarantine);
      const recovered = planned.map((item) => (moves[item.id] ? { ...item, uri: moves[item.id] } : item));
      const before = uploadQueueRef.current.length;
      const next = updateQueue((current) => appendQueueItems(current, recovered));
      const added = next.length - before;
      const queuedCount = recovered.filter((item) => item.status === 'queued').length;
      const note = queuedCount
        ? `Recovered ${queuedCount} page${queuedCount === 1 ? '' : 's'} from this phone. Keep the app open.`
        : '';
      setLocalRecoveryNote(note);
      if (announce) Alert.alert('Pages recovered', note || `Found ${added} page${added === 1 ? '' : 's'} that could not be sent.`);
      return added;
    } catch (error) {
      if (announce) Alert.alert('Could not recover local pages', error.message);
      return 0;
    } finally {
      recoveryInFlightRef.current = false;
    }
  }

  async function openTest(testId, options = {}) {
    setBusy(true);
    try {
      const token = options.token || accessTokenRef.current;
      const result = await api(`/api/intake/tests?id=${encodeURIComponent(testId)}`, {}, token);
      const loaded = result.test;
      // FLKRM-111: process assets into plain copies before normalizing.
      // normalizeUploadAssets only copies rows it rewrites, so passing
      // loaded.assets through directly would rewrite the upload queue's own
      // in-flight objects to "failed" in place and hide live uploads.
      const nextAssets = normalizeUploadAssets((loaded.assets || []).map((asset) => ({ ...asset })));
      const openedStudentIds = (loaded.students || []).map((student) => student.testStudentId);
      setTest(loaded); setTitle(loaded.title); setSubject(loaded.subject); setExamDate(normalizeExamDate(loaded.examDate || loaded.exam_date) || localDateString()); setExamType(normalizeExamType(loaded.examType || loaded.exam_type)); setSelectedBatchIds((loaded.batches || []).map((batch) => batch.id)); setStudentSearchQuery('');
      // Sync the ref now: boot recovery reads it right after openTest returns,
      // before the effect that mirrors `assets` has run.
      assetsRef.current = nextAssets;
      setAssets(nextAssets); setJob(loaded.job || null);
      setPendingScan((current) => pendingScanForOpenedTest(options.pendingScan || current, openedStudentIds));
      setDraftRestored(false); setScreen('editor');
      rememberWorkspace('editor', loaded.id);
      // Opening a test is an explicit context switch; an unfinished scan
      // session from a previous test must not resurface on this roster.
      // Hydration passes keepScanSession so recoverInterruptedScan can still
      // find a scan that was interrupted while this same test was open.
      if (user && !options.keepScanSession) await clearScanSession(user);
      const uploadedCounts = nextAssets
        .filter((asset) => asset.status === 'uploaded' && asset.kind === 'answer_sheet')
        .reduce((counts, asset) => ({ ...counts, [asset.testStudentId]: (counts[asset.testStudentId] || 0) + 1 }), {});
      const studentNames = Object.fromEntries((loaded.students || []).map((student) => [student.testStudentId, student.name]));
      scansByStudentRef.current = uploadedCounts;
      // Re-queue JPEG leftovers still on disk (successful uploads delete their files).
      testRef.current = loaded;
      const blocked = blockedAnswerSheetTestIds(testsRef.current, loaded);
      await lockQueueForBlockedTests(blocked);
      // Scoped to this test, whose own status is authoritative for its lock
      // state even before the test list has loaded.
      await recoverLocalScans({ testId: loaded.id, uploadedCounts, studentNames, announce: false });
      await reconcileQueueAgainstDiskAndServer(uploadedCounts);
      if (!blocked.has(loaded.id)) {
        updateQueue((current) => retryFailedItems(current, loaded.id));
      }
    } catch (error) { Alert.alert('Could not open test', error.message); } finally { setBusy(false); }
  }

  function confirmDeleteTest(item) {
    if (!permissions.canDeleteTests) return Alert.alert('Scanner access only', 'This account cannot delete tests.');
    const unsent = unsentLocalPageCount(uploadQueueRef.current, item.id);
    const unsentNote = unsent ? ` ${unsent} page${unsent === 1 ? '' : 's'} not yet sent from this phone will also be deleted.` : '';
    Alert.alert('Delete this test?', `Delete “${item.title}” and all scans and reference files attached to it? This cannot be undone.${unsentNote}`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete test', style: 'destructive', onPress: () => deleteTest(item) },
    ]);
  }

  async function deleteTest(item) {
    setBusy(true);
    try {
      await api(`/api/intake/tests?id=${encodeURIComponent(item.id)}`, { method: 'DELETE' }, accessToken);
      if (test?.id === item.id) {
        setTest(null); setAssets([]); setJob(null); setPendingScan(null); setScreen('home');
        rememberWorkspace('home');
      }
      await removeLocalTestData(item.id);
      await loadTests(accessToken, true);
      Alert.alert('Test deleted', 'The test and its uploaded files were removed.');
    } catch (error) { Alert.alert('Could not delete test', error.message); } finally { setBusy(false); }
  }

  // The server no longer has this test: drop its queue rows (any state) and
  // every local file for it, so nothing retries against a deleted test.
  async function removeLocalTestData(testId) {
    if (!testId) return;
    const doomed = uploadQueueRef.current.filter((entry) => entry.testId === testId);
    for (const entry of doomed) inFlightUploadsRef.current.delete(entry.id);
    updateQueue((current) => current.filter((entry) => entry.testId !== testId));
    // Close a review that belongs to this test (its files are removed below).
    const reviewPages = pendingScanRef.current?.pages || [];
    if (reviewPages.length && reviewPages.every((page) => String(page?.uri || '').includes(`/${testId}/`))) setPendingScan(null);
    await Promise.all(doomed.map((entry) => (entry.uri ? FileSystem.deleteAsync(entry.uri, { idempotent: true }).catch(() => {}) : null)));
    await Promise.all(['review', 'outbox', 'quarantine', 'legacy'].map((area) => {
      const root = scanAreaRoot(FileSystem.documentDirectory, area);
      return root ? FileSystem.deleteAsync(`${root}${testId}/`, { idempotent: true }).catch(() => {}) : null;
    }));
  }

  function openRenameTest(item) {
    if (!permissions.canRenameTests) return Alert.alert('Scanner access only', 'This account cannot rename tests.');
    setRenameTitle(item.title || ''); setRenameTarget(item); setBusy(false);
  }

  async function renameTest() {
    if (!permissions.canRenameTests) return Alert.alert('Scanner access only', 'This account cannot rename tests.');
    if (!renameTarget) return;
    const trimmed = renameTitle.trim();
    if (!trimmed) return Alert.alert('Name required', 'Enter a test name before saving.');
    if (trimmed.length > MAX_TEST_TITLE_LENGTH) return Alert.alert('Name too long', `Keep the test name to ${MAX_TEST_TITLE_LENGTH} characters or fewer.`);
    const target = renameTarget;
    setRenameTarget(null); setBusy(true);
    try {
      const result = await api('/api/intake/tests', { method: 'PATCH', body: JSON.stringify({ testId: target.id, title: trimmed }) }, accessToken);
      const savedTitle = String(result?.test?.title || trimmed).trim() || trimmed;
      // Update the currently-open editor, list, cache, and saved draft immediately.
      if (test?.id === target.id) {
        setTitle(savedTitle);
        setTest((prev) => (prev ? { ...prev, title: savedTitle } : prev));
      } else {
        setTests((prev) => prev.map((t) => (t.id === target.id ? { ...t, title: savedTitle } : t)));
      }
      await loadTests(accessToken, true);
      Alert.alert('Test renamed', `“${savedTitle}” is now the test name.`);
    } catch (error) { Alert.alert('Could not rename test', error.message); setRenameTarget(target); setRenameTitle(trimmed); } finally { setBusy(false); }
  }

  function openBatchPicker(mode) { setBatchPickerMode(mode); setBatchPickerOpen(true); }

  async function saveBatches() {
    if (!permissions.canCreateTests) return setBatchPickerOpen(false);
    if (batchPickerMode === 'create') return setBatchPickerOpen(false);
    if (!test) return;
    setBusy(true);
    try {
      const result = await api('/api/intake/tests', { method: 'PATCH', body: JSON.stringify({ testId: test.id, batchIds: selectedBatchIds }) }, accessToken);
      setTest(result.test); setAssets(normalizeUploadAssets(result.test.assets)); setJob(result.test.job || null); setBatchPickerOpen(false);
      await loadTests(accessToken, true);
      Alert.alert(result.added ? 'Batches added' : 'No changes', result.added ? `${result.added} batch${result.added === 1 ? '' : 'es'} added to this test.` : 'Those batches are already included.');
    } catch (error) { Alert.alert('Could not update batches', error.message); } finally { setBusy(false); }
  }

  // Logging out keeps unsent pages on this phone (the queue is stored per
  // account and resumes after the same account signs in again), but say so
  // before leaving, since nothing uploads while signed out.
  function requestSignOut() {
    const unsent = unsentLocalPageCount(uploadQueueRef.current);
    if (!unsent) return signOut();
    Alert.alert(
      'Pages not sent yet',
      `${unsent} page${unsent === 1 ? ' has' : 's have'} not finished uploading. They stay saved on this phone and upload after you sign in again with this account. Log out anyway?`,
      [
        { text: 'Stay signed in', style: 'cancel' },
        { text: 'Log out', style: 'destructive', onPress: () => { signOut().catch(() => {}); } },
      ],
    );
    return undefined;
  }

  async function signOut() {
    bumpSessionGeneration();
    inFlightUploadsRef.current.clear();
    uploadQueueRef.current = [];
    testsRef.current = [];
    setTestsLoaded(false);
    await clearStoredToken();
    await clearApiCache();
    await clearAssetCache();
    if (user) await clearScanSession(user);
    setAccessToken(null); setUser(null); setUsername(''); setPassword(''); setTest(null); setAssets([]); setJob(null); setPendingScan(null); setStudentContext(null); setStudentLoadError(''); setTeacherContext(null); setStudentOffline(false); setTeacherOffline(false); setActiveSubject(null); setRechecks([]); setViewedStudentUsername(''); setScreen('home'); setUploadQueue([]); setQueueHydrated(false); setIntakeReady(false);
  }

  async function createTest() {
    if (!permissions.canCreateTests) return Alert.alert('Scanner access only', 'Ask the school administrator to create tests and assign batches.');
    if (!title.trim() || !subject.trim() || !selectedBatchIds.length) return Alert.alert('Add a title, subject, and at least one batch.');
    if (!normalizeExamDate(examDate)) return Alert.alert('Add the exam date', 'Use the format YYYY-MM-DD (for example 2026-07-20).');
    setBusy(true);
    try {
      const result = await api('/api/intake/tests', { method: 'POST', body: JSON.stringify({ title, subject, batchIds: selectedBatchIds, exam_date: normalizeExamDate(examDate), exam_type: examType }) }, accessToken);
      setTest(result.test);
      setScreen('editor');
      rememberWorkspace('editor', result.test?.id);
      await loadTests(accessToken, true);
      Alert.alert('Test created', 'Attach the question paper, answer key, and answer sheets next.');
    } catch (error) { Alert.alert('Could not create test', error.message); } finally { setBusy(false); }
  }

  async function chooseReference(kind) {
    if (!permissions.canManageReferenceFiles) return Alert.alert('Scanner access only', 'Question papers and answer keys are managed by the school administrator.');
    if (!test) return Alert.alert('Create the test first.');
    const result = await DocumentPicker.getDocumentAsync({ type: 'application/pdf', copyToCacheDirectory: true, multiple: false });
    if (!result.canceled) await upload(await preserveReference(result.assets[0], kind), kind, null);
  }

  async function getPreviewUrl(asset) {
    if (!asset?.remoteAssetId) throw new Error('This file is still uploading.');
    const result = await api('/api/intake/uploads', { method: 'POST', body: JSON.stringify({ action: 'preview', assetId: asset.remoteAssetId }) }, accessToken);
    return result.previewUrl;
  }

  async function previewAsset(asset) {
    if (!asset?.remoteAssetId) return Alert.alert('Preview unavailable', 'This file is still uploading.');
    setBusy(true);
    try {
      const previewUrl = await getPreviewUrl(asset);
      if (!await Linking.canOpenURL(previewUrl)) throw new Error('This device cannot open the selected file.');
      await Linking.openURL(previewUrl);
    } catch (error) { Alert.alert('Could not preview file', error.message); } finally { setBusy(false); }
  }

  async function previewReference(asset) {
    if (!permissions.canManageReferenceFiles) return Alert.alert('Scanner access only', 'Reference PDFs are managed by the school administrator.');
    await previewAsset(asset);
  }

  async function preserveReference(file, kind) {
    if (!FileSystem.documentDirectory) throw new Error('Secure app storage is unavailable on this device.');
    const folder = `${FileSystem.documentDirectory}intake/${test.id}/references/`;
    await FileSystem.makeDirectoryAsync(folder, { intermediates: true });
    const suffix = (file.name || 'reference.pdf').split('.').pop() || 'pdf';
    const destination = `${folder}${kind}-${Date.now()}.${suffix}`;
    await FileSystem.copyAsync({ from: file.uri, to: destination });
    const info = await FileSystem.getInfoAsync(destination);
    return { ...file, uri: destination, size: info.exists ? info.size : file.size };
  }

  async function preserveScan(uri, student, pageNumber, testId = null) {
    if (!FileSystem.documentDirectory) throw new Error('Secure app storage is unavailable on this device.');
    // Boot recovery runs before `test` state has committed, so callers pass the id.
    // New scans land in the review area; they reach the outbox (and the upload
    // queue) only when the operator confirms them.
    const folder = scanFolder(FileSystem.documentDirectory, 'review', testId || testRef.current?.id || test?.id, student.testStudentId);
    await FileSystem.makeDirectoryAsync(folder, { intermediates: true });
    const destination = `${folder}${Date.now()}-${pageNumber}.jpg`;
    await FileSystem.copyAsync({ from: uri, to: destination });
    return destination;
  }

  async function inspectScans(uris) {
    let textByPage = new Map();
    try {
      const analysis = await DocumentScanner.analyzeScannedImages(uris, {
        extract: { text: true },
        concurrency: 2,
        ocrRotate180Fallback: true,
        textTimeoutMs: 7000,
      });
      textByPage = new Map((analysis.textBlocks || analysis.text || []).map((block) => [block.sourceImageIndex, block]));
    } catch {
      // Native OCR is a scan-quality signal only. A failed signal must not discard a valid page.
    }
    return Promise.all(uris.map(async (uri, index) => {
      const [{ width, height }, info] = await Promise.all([getImageSize(uri), FileSystem.getInfoAsync(uri)]);
      const block = textByPage.get(index);
      const readableCharacters = (block?.text || '').replace(/\s/g, '').length;
      const ocrConfidence = Number(block?.confidence || 0);
      const warnings = scanQualityWarnings({ width, height, byteSize: info.exists ? info.size : 0, readableCharacters, ocrConfidence });
      return { uri, width, height, byteSize: info.exists ? info.size : 0, ocrConfidence, needsReview: warnings.length > 0, qualityNote: warnings.join(' ') };
    }));
  }

  async function getNextPageNumber(student, existingPages = [], reset = false, testId = null) {
    const key = studentPageCounterKey(testId || testRef.current?.id || test?.id, student.testStudentId);
    const stored = await AsyncStorage.getItem(key);
    const storedCounter = stored ? parseInt(stored, 10) : 0;
    return calculateNextPageNumber({ storedCounter, assets: assetsRef.current || [], existingPages, testStudentId: student.testStudentId, reset });
  }

  // Rebuild the page list a recovery session should append to. The durable scan
  // session stores only a count (it must stay small enough to write before the
  // scanner launches), so reconstruct the descriptors from the roster's
  // answer-sheet assets. `expectedCount` is used only to keep numbering sane if
  // the roster has fewer pages than the session recorded.
  function existingPagesForStudent(student, expectedCount = 0) {
    if (!student?.testStudentId) return [];
    const fromRoster = (assetsRef.current || [])
      .filter((asset) => asset.kind === 'answer_sheet' && asset.testStudentId === student.testStudentId)
      .map((asset) => ({ uri: asset.file?.uri, label: asset.label, pageNumber: extractPageNumberFromFilename(asset.label || asset.file?.name) }))
      .filter((page) => page.uri);
    const count = Math.max(fromRoster.length, Number(expectedCount) || 0);
    // Pad with placeholders when the session recorded more pages than the
    // roster can account for, so the next page number does not collide.
    while (fromRoster.length < count) fromRoster.push({ uri: null, label: null, pageNumber: fromRoster.length + 1 });
    return fromRoster;
  }

  // Copies a set of raw scanner URIs into durable app storage, inspects them,
  // advances the page counter, and opens the review modal. Both the live
  // scanDocument() return and the boot-time recovery path funnel through here so
  // an ordinary return and a post-process-death recovery produce identical,
  // idempotent results.
  async function applyScannedPages({ student, rawPages, existingPages = [], replaceExisting = false, sessionId = null, testId = null }) {
    if (!rawPages?.length) return false;
    // Prefer an explicit testId (boot recovery knows it from the session), then
    // the ref, then the closed-over state — during boot recovery this runs
    // immediately after setTest() and neither state nor ref may have updated.
    const activeTestId = testId || testRef.current?.id || test?.id;
    if (!activeTestId) return false;
    const startPage = await getNextPageNumber(student, existingPages, replaceExisting, activeTestId);
    const durablePages = await Promise.all(rawPages.map((uri, index) => preserveScan(uri, student, startPage + index, activeTestId)));
    const scannedPages = await inspectScans(durablePages);
    const key = studentPageCounterKey(activeTestId, student.testStudentId);
    await AsyncStorage.setItem(key, String(startPage + rawPages.length - 1));
    setPendingScan({ student, pages: [...existingPages.filter((page) => page.uri), ...scannedPages], replaceExisting });
    // Only now is the native manifest safe to drop: the bytes are in app
    // storage and referenced by React state, so a later crash still recovers
    // them through the ordinary draft-restore path.
    if (sessionId) await discardPendingScanResult(sessionId);
    return true;
  }

  async function chooseScan(student, existingPages = [], replaceExisting = false) {
    if (!test) return Alert.alert('Create the test first.');
    // The native plugin owns a single scanner instance, so a second
    // scanDocument() while one is open is rejected with "Scan already in
    // progress". React state updates are async, so two taps in the same tick can
    // both pass a `busy` check — the ref is the actual re-entrancy lock.
    if (scanningRef.current) return;
    scanningRef.current = true;
    setBusy(true);
    const sessionId = `scan_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
    try {
      // Persist the in-flight session *before* launching the native scanner.
      // If Android kills this process while the external scanner is open, the
      // restarted app reads this record and recovers the scan instead of
      // stranding the user on the home screen. Deliberately not the debounced
      // draft effect — that write would race the process death. Inside the
      // try so a throw here still releases the scanner lock below.
      const session = createScanSession({
        sessionId,
        userId: user?.username || user?.id,
        testId: test.id,
        student,
        replaceExisting,
        existingPages,
        nextPageNumber: await getNextPageNumber(student, existingPages, replaceExisting),
      });
      await writeScanSession(user, session);
      const result = await DocumentScanner.scanDocument({
        responseType: 'imageFilePath',
        croppedImageQuality: 96,
        maxNumDocuments: 30,
        // Read by the patched native module to key its durable manifest. An
        // unpatched APK ignores the extra key, which is safe.
        scanSessionId: sessionId,
      });
      if (result.status === 'success' && result.scannedImages?.length) {
        await applyScannedPages({ student, rawPages: result.scannedImages, existingPages, replaceExisting, sessionId });
        await clearScanSession(user);
      } else {
        // Cancelled or empty: nothing to recover.
        await clearScanSession(user);
        await discardPendingScanResult(sessionId);
      }
    } catch (error) {
      // Cancelled scans must not surface as a hard failure. Any other throw
      // (native module unload, disk copy, etc.) used to be mislabeled as Expo Go.
      if (isScannerCancelError(error)) {
        await clearScanSession(user);
        await discardPendingScanResult(sessionId);
        return;
      }
      // A duplicate tap that raced past the lock is a no-op, not a failure.
      // Clear the session we wrote for this discarded attempt so it cannot
      // linger as a phantom "interrupted scan" until it expires.
      if (isScannerBusyError(error)) {
        await clearScanSession(user);
        await discardPendingScanResult(sessionId);
        return;
      }
      // A live failure with a durable native result can still be recovered on
      // the next boot; keep the session record so the recovery path can try.
      Alert.alert('Scanner unavailable', scannerUnavailableMessage(error, { isExpoGo: isExpoGoRuntime(Constants) }));
    } finally {
      scanningRef.current = false;
      setBusy(false);
    }
  }

  // Runs once per launch, after the session/user and draft have been restored.
  // Looks for an interrupted scan session belonging to the signed-in user and
  // either reopens the scan-review modal (durable result found) or returns to
  // the editor with an explanatory note (result lost to process death).
  async function recoverInterruptedScan(nextUser) {
    if (!nextUser || nextUser.role === 'student') return;
    const session = await readScanSession(nextUser);
    if (!session || !isRecoverableScanSession(session)) {
      if (session) await clearScanSession(nextUser);
      return;
    }
    // The scan session belongs to the test that was open when it launched.
    // Scanner-only accounts often have no saved draft at all, so the restored
    // test may be absent or a different one; in that case load the session's
    // test first so the roster is present before we apply the recovered pages.
    const restoredTest = draftTestRef.current || testRef.current || test;
    if (!restoredTest?.id || (session.testId && restoredTest.id !== session.testId)) {
      if (!session.testId) {
        await discardPendingScanResult(session.sessionId);
        await clearScanSession(nextUser);
        return;
      }
      setBusy(true);
      try {
        // openTest loads the roster and clears any stale scan session, so write
        // ours back afterwards to keep the recovery record alive across it.
        await openTest(session.testId);
      } catch {
        await discardPendingScanResult(session.sessionId);
        await clearScanSession(nextUser);
        return;
      } finally {
        setBusy(false);
      }
      await writeScanSession(nextUser, session);
    }
    if (!session.student) {
      await discardPendingScanResult(session.sessionId);
      await clearScanSession(nextUser);
      return;
    }
    const nativeResult = await consumePendingScanResult(session.sessionId);
    const plan = planScanRecovery({ session, nativeResult });
    if (plan.action === 'discard') {
      await discardPendingScanResult(session.sessionId);
      await clearScanSession(nextUser);
      return;
    }
    if (plan.action === 'resume-review') {
      setBusy(true);
      try {
        // The session stores only a page *count*. Rebuild the existing page
        // list from the roster's durable answer-sheet assets so the recovered
        // pages append with the correct numbering instead of restarting at 1.
        const applied = await applyScannedPages({
          student: session.student,
          rawPages: plan.pages,
          existingPages: existingPagesForStudent(session.student, session.existingPageCount),
          replaceExisting: session.replaceExisting,
          sessionId: session.sessionId,
          testId: session.testId,
        });
        await clearScanSession(nextUser);
        if (applied) {
          // Land the user back in the editor with the recovered pages open in
          // the scan-review modal, not on the dashboard.
          setScreen('editor');
          setDraftRestored(true);
        } else {
          setLocalRecoveryNote('Scan was interrupted before it finished. Please scan this paper again.');
        }
      } catch {
        await clearScanSession(nextUser);
        Alert.alert('Scan recovered partially', 'Some scanned pages could not be restored. Please scan this paper again.');
      } finally {
        setBusy(false);
      }
      return;
    }
    // resume-interrupted: the user confirmed a scan but the process died before
    // ML Kit returned. Return to the editor with a clear, dismissible note.
    await discardPendingScanResult(session.sessionId);
    await clearScanSession(nextUser);
    setScreen('editor');
    setLocalRecoveryNote('Scan was interrupted before it finished. Please scan this paper again.');
  }

  function startStudentScan(student) {
    if (!canAcceptAnswerSheetUpload({
      testStatus: test?.status,
      hasActiveProcessingJob: Boolean(job && (job.status === 'queued' || job.status === 'running')),
    })) {
      return Alert.alert('Scan locked', 'This assessment is already delivered or in review. New answer sheets are blocked. Ask an admin to reopen it if you need a rescan.');
    }
    if (job && (job.status === 'queued' || job.status === 'running')) {
      return Alert.alert('Scan locked', 'This paper can no longer be changed because processing has started or been queued. Cancel or reset processing before replacing the scan.');
    }
    const existingCount = scansByStudent[student.testStudentId] || 0;
    if (!existingCount) return chooseScan(student);
    // Android native alerts render at most three buttons reliably, so the
    // four scan actions are shown in a custom action-sheet Modal instead.
    setScanOptionsStudent(student);
  }

  async function previewStudentPaper(student) {
    // Active answer-sheet assets are kept in upload order, which is the page
    // order they were scanned in. Only status 'uploaded' pages are previewed;
    // superseded, failed, and pending assets are excluded. Filename page
    // numbers break ties when present.
    const pages = assets
      .filter((asset) => asset.kind === 'answer_sheet' && asset.testStudentId === student.testStudentId && asset.status === 'uploaded')
      .slice()
      .sort((a, b) => {
        const pageDelta = extractPageNumberFromFilename(a.label || a.file?.name) - extractPageNumberFromFilename(b.label || b.file?.name);
        if (pageDelta) return pageDelta;
        return 0;
      });
    if (!pages.length) return Alert.alert('Preview unavailable', 'No active uploaded page was found for this student.');
    setBusy(true);
    try {
      setStudentPaperPreview({ student, pages, index: 0, previewUrl: await getPreviewUrl(pages[0]) });
    } catch (error) {
      Alert.alert('Could not preview paper', error.message);
    } finally { setBusy(false); }
  }

  async function selectStudentPaperPreviewPage(index) {
    // Snapshot before await so a Done → reopen for another student cannot apply
    // a stale URL into the new preview session.
    const current = studentPaperPreview;
    if (!current || index < 0 || index >= current.pages.length || index === current.index) return;
    setBusy(true);
    try {
      const previewUrl = await getPreviewUrl(current.pages[index]);
      setStudentPaperPreview((state) => (
        state
        && state.student.testStudentId === current.student.testStudentId
        && state.pages.length === current.pages.length
          ? { ...state, index, previewUrl }
          : state
      ));
    } catch (error) {
      Alert.alert('Could not load page', error.message);
    } finally { setBusy(false); }
  }

  function confirmRemoveStudentScan(student) {
    if (studentHasBlockingUploads(uploadQueue, student.testStudentId)) {
      return Alert.alert('Uploads in progress', `Wait for ${student.name}'s pages to finish sending, or retry failed uploads, before removing this paper.`);
    }
    const pageCount = scansByStudent[student.testStudentId] || 0;
    Alert.alert('Remove paper and re-upload?', `Remove all ${pageCount} uploaded page(s) for ${student.name}? The scan files and history will be permanently removed. You will need to scan this paper again.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove paper', style: 'destructive', onPress: () => removeStudentScan(student) },
    ]);
  }

  async function removeStudentScan(student) {
    if (!test) return;
    setBusy(true);
    try {
      await api('/api/intake/uploads', { method: 'POST', body: JSON.stringify({ action: 'remove_answer_sheet', testId: test.id, testStudentId: student.testStudentId, reason: 'admin_requested_rescan' }) }, accessToken);
      await AsyncStorage.removeItem(studentPageCounterKey(test.id, student.testStudentId)).catch(() => {});
      setAssets((items) => items.filter((item) => !(item.kind === 'answer_sheet' && item.testStudentId === student.testStudentId)));
      setTest((current) => current ? {
        ...current,
        students: (current.students || []).map((item) => item.testStudentId === student.testStudentId ? { ...item, status: 'expected' } : item),
      } : current);
      Alert.alert('Paper removed', `${student.name}'s uploaded pages and history were removed. Scan the paper again when ready.`, [
        { text: 'Done' },
        { text: 'Scan again', onPress: () => chooseScan(student) },
      ]);
    } catch (error) { Alert.alert('Could not remove scan', error.message); } finally { setBusy(false); }
  }

  async function confirmScan() {
    if (!pendingScan) return;
    const { student, pages, replaceExisting } = pendingScan;
    if (!pages.length) return Alert.alert('No pages selected', 'Scan at least one page before continuing.');
    const pagesNeedingReview = pages.filter((page) => page.needsReview).length;
    if (pagesNeedingReview) {
      Alert.alert('Check scan quality', `${pagesNeedingReview} page(s) needs a visual check for blur, glare, or an unreadable scan. Retake only when the handwriting is not clearly readable.`, [
        { text: 'Review pages', style: 'cancel' },
        { text: 'Use anyway', onPress: () => uploadConfirmedScan(student, pages, replaceExisting) },
      ]);
      return;
    }
    await uploadConfirmedScan(student, pages, replaceExisting);
  }

  async function uploadConfirmedScan(student, pages, replaceExisting = false) {
    if (!test?.id || confirmingScanRef.current) return;
    const testId = test.id;
    confirmingScanRef.current = true;
    setBusy(true);
    try {
      // Move every confirmed page from the review area to the outbox first.
      // Only outbox (and legacy) files are ever recovered into the queue, so
      // a crash after this point still uploads them; a crash before it brings
      // the review back from the saved draft.
      const confirmed = [];
      const missing = [];
      for (const page of pages) {
        let uri = null;
        try {
          uri = await moveScanFile(FileSystem, page.uri, 'outbox');
        } catch {
          uri = null;
        }
        if (uri) confirmed.push({ ...page, uri });
        else {
          const info = await FileSystem.getInfoAsync(page.uri).catch(() => null);
          // Could not move but the file is still there: queue it in place.
          if (info?.exists) confirmed.push(page);
          else missing.push(page);
        }
      }
      if (!confirmed.length) {
        Alert.alert('Scan not found', 'These pages are no longer on this phone. Scan the paper again.');
        setPendingScan(null);
        return;
      }
      const studentId = student.testStudentId;
      updateQueue((current) => {
        const next = replaceExisting ? dropBlockingItemsForStudent(current, studentId) : current;
        const uploadedCount = (scansByStudentRef.current[studentId] || 0) + pendingLocalPageCount(next, studentId);
        const items = buildScanQueueItems({
          testId,
          student,
          pages: confirmed,
          replaceExisting,
          uploadedCount,
        });
        const merged = appendQueueItems(next, items);
        return replaceExisting ? merged : withExpectedPageCount(merged, studentId, items[0]?.expectedPageCount);
      });
      persistUploadQueueSnapshot(uploadQueueRef.current);
      setPendingScan(null);
      if (missing.length) {
        Alert.alert('Some pages were missing', `${missing.length} page${missing.length === 1 ? ' was' : 's were'} no longer on this phone and will not upload. Scan ${missing.length === 1 ? 'it' : 'them'} again with Add pages.`);
      }
    } finally {
      confirmingScanRef.current = false;
      setBusy(false);
    }
  }

  // Cancel / Android Back on the review screen. The pages were never
  // confirmed, so they are deleted (after asking) instead of lingering where
  // they could be mistaken for confirmed scans.
  function cancelPendingScan() {
    const current = pendingScanRef.current;
    const pages = (current?.pages || []).filter((page) => page?.uri);
    const discard = () => {
      for (const page of pages) FileSystem.deleteAsync(page.uri, { idempotent: true }).catch(() => {});
      setPendingScan(null);
    };
    if (!pages.length) return discard();
    Alert.alert(
      'Discard this scan?',
      `${pages.length} scanned page${pages.length === 1 ? '' : 's'} for ${current?.student?.name || 'this student'} ${pages.length === 1 ? 'has' : 'have'} not been saved. Discard ${pages.length === 1 ? 'it' : 'them'}?`,
      [
        { text: 'Keep reviewing', style: 'cancel' },
        { text: 'Discard', style: 'destructive', onPress: discard },
      ],
    );
    return undefined;
  }

  function scheduleDrain(delayMs = 0) {
    if (drainTimerRef.current) clearTimeout(drainTimerRef.current);
    drainTimerRef.current = setTimeout(() => {
      drainTimerRef.current = null;
      drainUploadQueueRef.current?.();
    }, Math.max(0, delayMs));
  }

  function scheduleRosterRefresh({ immediate = false } = {}) {
    if (rosterRefreshTimerRef.current) {
      if (!immediate) return;
      clearTimeout(rosterRefreshTimerRef.current);
      rosterRefreshTimerRef.current = null;
    }
    rosterRefreshTimerRef.current = setTimeout(() => {
      rosterRefreshTimerRef.current = null;
      refreshOpenTest().catch(() => {});
    }, immediate ? 0 : 2500);
  }

  async function commitReplaceGroup(replaceGroupId, token) {
    const group = replaceGroupItems(uploadQueueRef.current, replaceGroupId);
    if (!group.length) return;
    const keepAssetIds = group.map((entry) => entry.remoteAssetId).filter(Boolean);
    const lead = group[0];
    await api('/api/intake/uploads', { method: 'POST', body: JSON.stringify({
      action: 'replace_answer_sheet',
      testId: lead.testId,
      testStudentId: lead.testStudentId,
      keepAssetIds,
    }) }, token);
    updateQueue((current) => current.filter((entry) => entry.replaceGroupId !== replaceGroupId));
    scheduleRosterRefresh({ immediate: true });
  }

  // A 401 during upload pauses new pages and asks the session endpoint what is
  // going on (with the same retries as session restore). All concurrent 401s
  // share one check. Only a confirmed expiry signs out — and even then the
  // queue and its files stay on the phone for the next sign-in.
  function checkSessionAfterUploadAuthError(token) {
    uploadsPausedRef.current = true;
    if (!uploadSessionCheckRef.current) {
      const generation = getSessionGeneration();
      uploadSessionCheckRef.current = fetchSessionWithRetry(api, token)
        .then((result) => {
          if (generation !== getSessionGeneration() || accessTokenRef.current !== token) return 'superseded';
          return result?.user ? 'valid' : 'expired';
        })
        // Network trouble or 503 (session store unavailable): retry later.
        .catch(() => 'unknown')
        .then((outcome) => {
          if (outcome === 'expired' && accessTokenRef.current === token) {
            persistUploadQueueSnapshot(uploadQueueRef.current);
            clearStoredToken().catch(() => {});
            if (!authUploadAlertRef.current) {
              authUploadAlertRef.current = true;
              const unsent = unsentLocalPageCount(uploadQueueRef.current);
              Alert.alert('Session expired', `Sign in again to finish uploading scans.${unsent ? ` ${unsent} page${unsent === 1 ? ' is' : 's are'} saved on this phone.` : ''}`);
            }
            setAccessToken(null);
            accessTokenRef.current = null;
            setUser(null);
          }
          uploadsPausedRef.current = false;
          return outcome;
        })
        .finally(() => { uploadSessionCheckRef.current = null; });
    }
    return uploadSessionCheckRef.current;
  }

  async function uploadQueueItem(item, token) {
    const { attemptId } = item;
    // Failure/progress updates apply only while this attempt still owns the
    // row: a reclaimed, locked, or discarded row is left alone.
    const patchOwnRow = (transform) => updateQueue((current) => {
      let hit = false;
      const next = current.map((entry) => {
        if (entry.id !== item.id || entry.attemptId !== attemptId) return entry;
        hit = true;
        return transform(entry);
      });
      return hit ? next : current;
    });
    // Success is a server fact, whatever happened to the attempt meanwhile.
    const finishUploaded = async (remoteAssetId, prepared) => {
      if (prepared?.uri && prepared.uri !== item.uri) await FileSystem.deleteAsync(prepared.uri, { idempotent: true }).catch(() => {});
      await FileSystem.deleteAsync(item.uri, { idempotent: true }).catch(() => {});
      updateQueue((current) => {
        if (!current.some((entry) => entry.id === item.id)) return current;
        const next = current.map((entry) => entry.id === item.id ? { ...entry, status: 'uploaded', remoteAssetId, attemptId: null, lastError: null } : entry);
        return item.replaceGroupId ? next : next.filter((entry) => entry.id !== item.id);
      });
      scheduleRosterRefresh();
    };
    let createdAssetId = item.remoteAssetId || null;
    try {
      const prepared = await prepareScanUpload(item.uri);
      if (!prepared.byteSize) throw new Error('The scanned page is missing from this device. Scan it again.');
      let init = null;
      if (item.remoteAssetId) {
        try {
          init = await api('/api/intake/uploads', { method: 'POST', body: JSON.stringify({ action: 'resume', assetId: item.remoteAssetId }) }, token);
        } catch (error) {
          if (error.status !== 404 && error.status !== 409) throw error;
        }
        // The previous attempt's `complete` landed but its response was lost.
        // Creating again would add a duplicate page.
        if (init && (init.status === 'uploaded' || init.alreadyUploaded)) {
          await finishUploaded(init.asset?.id || item.remoteAssetId, prepared);
          return;
        }
      }
      if (!init) {
        init = await api('/api/intake/uploads', { method: 'POST', body: JSON.stringify({
          action: 'create',
          testId: item.testId,
          testStudentId: item.testStudentId,
          kind: 'answer_sheet',
          filename: item.filename,
          mimeType: item.mimeType || 'image/jpeg',
          byteSize: prepared.byteSize,
          expectedPageCount: item.expectedPageCount,
        }) }, token);
      }
      const remoteAssetId = init.asset.id;
      createdAssetId = remoteAssetId;
      patchOwnRow((entry) => ({ ...entry, status: 'uploading', remoteAssetId, urlCreatedAt: Date.now() }));
      persistUploadQueueSnapshot(uploadQueueRef.current);
      const put = await putFileWithTimeout(FileSystem, {
        url: init.uploadUrl,
        fileUri: prepared.uri,
        headers: init.headers,
        isProgressPaused: () => appStateRef.current !== 'active',
      });
      if (put.status < 200 || put.status >= 300) throw Object.assign(new Error(`Storage upload failed (${put.status})`), { remoteAssetId });
      await api('/api/intake/uploads', { method: 'POST', body: JSON.stringify({
        action: 'complete',
        assetId: remoteAssetId,
        byteSize: prepared.byteSize,
        checksum: prepared.checksum,
      }) }, token);
      await finishUploaded(remoteAssetId, prepared);
    } catch (error) {
      const kind = classifyUploadError(error);
      if (kind === 'locked') {
        // Never delete: keep the page in quarantine and tell the operator.
        const moves = await quarantineFiles([item]);
        updateQueue((current) => lockItemsForTests(current, new Set([item.testId]), moves, new Set([item.id])));
        lockQueueForBlockedTests(new Set([item.testId])).catch(() => {});
        return;
      }
      if (kind === 'auth') {
        const outcome = await checkSessionAfterUploadAuthError(token);
        // A valid session means the 401 was about this request; count it as
        // an ordinary failed attempt so it cannot loop forever.
        const counted = outcome === 'valid';
        const retryAt = nextAttemptAt((item.attempts || 0) + 1);
        patchOwnRow((entry) => ({
          ...entry,
          status: 'queued',
          attempts: counted ? (entry.attempts || 0) + 1 : (entry.attempts || 0),
          lastError: error.message,
          remoteAssetId: createdAssetId || entry.remoteAssetId,
          nextAttemptAt: outcome === 'expired' ? 0 : retryAt,
          attemptId: null,
        }));
        if (outcome !== 'expired') scheduleDrain(Math.max(0, retryAt - Date.now()));
        return;
      }
      const permanent = kind === 'permanent';
      const failed = permanent || (kind !== 'offline' && (item.attempts || 0) >= 4);
      const retryAt = failed ? 0 : nextAttemptAt((item.attempts || 0) + 1);
      if (failed && createdAssetId) {
        await api('/api/intake/uploads', { method: 'POST', body: JSON.stringify({ action: 'discard', assetId: createdAssetId }) }, token).catch(() => {});
      }
      patchOwnRow((entry) => ({
        ...entry,
        status: failed ? 'failed' : 'queued',
        permanent,
        attempts: (entry.attempts || 0) + 1,
        lastError: error.message,
        remoteAssetId: failed ? null : (createdAssetId || entry.remoteAssetId),
        nextAttemptAt: retryAt,
        attemptId: null,
      }));
      if (!failed) scheduleDrain(Math.max(0, retryAt - Date.now()));
    }
  }

  async function drainUploadQueue() {
    const token = accessTokenRef.current;
    if (!token || uploadsPausedRef.current) return;
    const inFlight = inFlightUploadsRef.current;

    if (inFlight.size === 0 && !replaceCommitInFlightRef.current) {
      const pendingReplaceGroupId = pickPendingReplaceGroupId(uploadQueueRef.current);
      if (pendingReplaceGroupId && !pickNextQueueItem(uploadQueueRef.current)) {
        replaceCommitInFlightRef.current = true;
        await activateUploadKeepAwake(true);
        try {
          await commitReplaceGroup(pendingReplaceGroupId, token);
        } catch (error) {
          updateQueue((current) => current.map((entry) => (
            entry.replaceGroupId === pendingReplaceGroupId
              ? { ...entry, lastError: error.message, nextAttemptAt: nextAttemptAt(1) }
              : entry
          )));
          scheduleDrain(nextAttemptAt(1) - Date.now());
        } finally {
          replaceCommitInFlightRef.current = false;
        }
      }
    }

    const slots = UPLOAD_CONCURRENCY - inFlight.size - (replaceCommitInFlightRef.current ? 1 : 0);
    if (slots <= 0) return;
    let claimed = [];
    updateQueue((current) => {
      const result = claimNextQueueItems(current, slots);
      claimed = result.claimed;
      return claimed.length ? result.items : current;
    });
    if (!claimed.length) {
      if (inFlight.size === 0 && !replaceCommitInFlightRef.current) {
        await activateUploadKeepAwake(false);
        scheduleRosterRefresh({ immediate: true });
        const retryAt = nextDrainAt(uploadQueueRef.current);
        if (retryAt) scheduleDrain(retryAt - Date.now());
      }
      return;
    }

    for (const item of claimed) inFlight.set(item.id, { attemptId: item.attemptId, startedAt: Date.now() });
    activateUploadKeepAwake(true);
    for (const item of claimed) {
      uploadQueueItem(item, token).catch(() => {}).finally(() => {
        if (inFlight.get(item.id)?.attemptId === item.attemptId) inFlight.delete(item.id);
        scheduleDrain(0);
      });
    }
  }
  drainUploadQueueRef.current = drainUploadQueue;

  function retryFailedUploads() {
    const scopedToOpenTest = Boolean(queueSummary.queued || queueSummary.uploading || queueSummary.failed);
    updateQueue((current) => retryFailedItems(current, scopedToOpenTest ? test?.id : null));
  }

  function discardQueueItems(items = []) {
    if (!items.length) return;
    const ids = new Set(items.map((item) => item.id));
    for (const id of ids) inFlightUploadsRef.current.delete(id);
    updateQueue((current) => current.filter((entry) => !ids.has(entry.id)));
    for (const item of items) {
      if (item.uri) FileSystem.deleteAsync(item.uri, { idempotent: true }).catch(() => {});
      if (item.remoteAssetId) {
        api('/api/intake/uploads', { method: 'POST', body: JSON.stringify({ action: 'discard', assetId: item.remoteAssetId }) }, accessTokenRef.current).catch(() => {});
      }
    }
  }

  function confirmDiscardQueueItems(items = [], label = 'pages') {
    const count = items.length;
    if (!count) return;
    Alert.alert(
      `Discard ${count} ${label}?`,
      `${count} page${count === 1 ? '' : 's'} will be deleted from this phone and will not be uploaded. Scan ${count === 1 ? 'it' : 'them'} again if the paper is still needed.`,
      [
        { text: 'Keep', style: 'cancel' },
        { text: 'Discard', style: 'destructive', onPress: () => discardQueueItems(items) },
      ],
    );
  }

  // Tapping the failed-uploads banner: Retry, or Discard (after a confirm).
  function openFailedUploadsActions() {
    const testId = queueSummary.failed ? test?.id : null;
    const failedItems = discardableItems(uploadQueueRef.current, testId).filter((item) => item.status === 'failed');
    if (!failedItems.length) return retryFailedUploads();
    const lastError = failedItems.find((item) => item.lastError)?.lastError;
    Alert.alert(
      `${failedItems.length} page${failedItems.length === 1 ? '' : 's'} could not be uploaded`,
      lastError ? `Last error: ${lastError}` : 'Retry sending them, or discard them and scan again.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Discard…', style: 'destructive', onPress: () => confirmDiscardQueueItems(failedItems, 'failed pages') },
        { text: 'Retry', onPress: retryFailedUploads },
      ],
    );
    return undefined;
  }

  // Retry locked pages after an admin reopened the test: refresh the list,
  // and only if the test accepts answer sheets again move the files back to
  // the outbox and requeue them.
  async function retryLockedPages(testId) {
    await loadTests(accessTokenRef.current, true).catch(() => {});
    // Unknown to the list (or offline): requeue and let the server decide; a
    // still-locked test answers 409 and the pages go straight back to quarantine.
    const listed = testsRef.current.find((entry) => entry?.id === testId);
    const stillBlocked = Boolean(listed) && blockedAnswerSheetTestIds([listed], null).has(testId);
    if (stillBlocked) {
      Alert.alert('Test is still locked', 'This test is still locked for processing. Ask an admin to reopen it, then tap Retry again.');
      return;
    }
    const locked = uploadQueueRef.current.filter((entry) => entry.status === 'locked' && entry.testId === testId);
    const moves = {};
    for (const entry of locked) {
      try {
        const moved = await moveScanFile(FileSystem, entry.uri, 'outbox');
        if (moved) moves[entry.id] = moved;
      } catch {
        // Upload from where it is.
      }
    }
    updateQueue((current) => unlockItemsForTest(current, testId, moves));
    scheduleDrain(0);
  }

  async function refreshOpenTest() {
    if (!testRef.current?.id) return;
    const token = accessTokenRef.current;
    if (!token) return;
    const result = await api(`/api/intake/tests?id=${encodeURIComponent(testRef.current.id)}`, {}, token);
    const serverAssets = normalizeUploadAssets((result.test.assets || []).map((asset) => ({ ...asset })));
    const currentAssets = assetsRef.current || [];
    // Preserve live in-memory uploads. normalizeUploadAssets maps in-flight server
    // rows to failed ("Upload interrupted"); replacing assets with that flickers Retry mid-upload.
    // FLKRM-111: reference rows (question paper / answer key) have an empty
    // testStudentId, so the previous per-row kind dedupe dropped them all and the
    // server's stale "Upload interrupted" row leaked through as Failed. Any
    // not-yet-uploaded server row for a reference kind is stale: the in-memory
    // asset and the upload queue are the source of truth while a file is in flight.
    const referenceQueueKinds = new Set(
      (uploadQueueRef.current || []).filter((item) => item.status === 'uploading' || item.status === 'queued').map((item) => item.kind),
    );
    const liveAssetUploads = currentAssets.filter((a) => a.status === 'uploading' || a.status === 'registered');
    const liveRemoteIds = new Set(liveAssetUploads.map((a) => a.remoteAssetId).filter(Boolean));
    const filteredServerAssets = serverAssets.filter((serverAsset) => {
      if (liveRemoteIds.has(serverAsset.id)) return false;
      if (liveAssetUploads.some((localAsset) => localAsset.id === serverAsset.id)) return false;
      if (
        !serverAsset.testStudentId
        && (serverAsset.kind === 'question_paper' || serverAsset.kind === 'answer_key')
        && serverAsset.status !== 'uploaded'
        && (referenceQueueKinds.has(serverAsset.kind) || currentAssets.some((a) => !a.testStudentId && a.kind === serverAsset.kind && a.status === 'uploading'))
      ) {
        return false;
      }
      return true;
    });
    const nextAssets = [
      ...liveAssetUploads,
      ...filteredServerAssets,
    ];
    setTest(result.test);
    setAssets(nextAssets);
    setJob(result.test.job || null);
    const uploadedCounts = nextAssets
      .filter((asset) => asset.status === 'uploaded' && asset.kind === 'answer_sheet')
      .reduce((counts, asset) => ({ ...counts, [asset.testStudentId]: (counts[asset.testStudentId] || 0) + 1 }), {});
    scansByStudentRef.current = uploadedCounts;
    await reconcileQueueAgainstDiskAndServer(uploadedCounts);
  }

  function removePendingPage(index) {
    setPendingScan((current) => {
      const removedPage = current?.pages[index];
      if (removedPage?.uri) FileSystem.deleteAsync(removedPage.uri, { idempotent: true }).catch(() => {});
      return current ? { ...current, pages: current.pages.filter((_, pageIndex) => pageIndex !== index) } : current;
    });
  }

  async function retakePendingPage(index) {
    const current = pendingScan;
    const oldPage = current?.pages[index];
    if (!current || !oldPage) return;
    // Same single-scanner rule as chooseScan: one native scanner at a time.
    if (scanningRef.current || retakingRef.current) return;
    scanningRef.current = true;
    retakingRef.current = true;
    try {
      const result = await DocumentScanner.scanDocument({ responseType: 'imageFilePath', croppedImageQuality: 96, maxNumDocuments: 1 });
      if (result.status !== 'success' || !result.scannedImages?.length) return;
      const pageNumber = extractPageNumberFromFilename(oldPage.uri) || index + 1;
      const durableUri = await preserveScan(result.scannedImages[0], current.student, pageNumber);
      const [replacement] = await inspectScans([durableUri]);
      setPendingScan((state) => state && state.student.testStudentId === current.student.testStudentId ? {
        ...state,
        pages: state.pages.map((page, pageIndex) => pageIndex === index ? replacement : page),
      } : state);
      FileSystem.deleteAsync(oldPage.uri, { idempotent: true }).catch(() => {});
    } catch (error) {
      if (isScannerCancelError(error)) return;
      Alert.alert('Could not retake page', scannerUnavailableMessage(error, { isExpoGo: isExpoGoRuntime(Constants) }));
    } finally {
      scanningRef.current = false;
      retakingRef.current = false;
    }
  }

  async function queueTest() {
    if (!permissions.canQueueProcessing) return Alert.alert('Scanner access only', 'Ask the school administrator to queue processing after uploads are complete.');
    const queueBlock = processingBlockReason(assets, uploadQueue.filter((item) => item.testId === test?.id));
    if (!test || queueBlock) return Alert.alert('Finish uploads first', queueBlock || 'Attach the question paper, answer key, and at least one answer sheet.');
    setBusy(true);
    try {
      const result = await api('/api/intake/jobs', { method: 'POST', body: JSON.stringify({ testId: test.id }) }, accessToken);
      setJob(result.job);
      await loadTests(accessToken, true);
      Alert.alert('Processing queued', 'The assessment has been added to the processing queue.');
    } catch (error) { Alert.alert('Could not queue processing', error.message); } finally { setBusy(false); }
  }

  async function upload(file, kind, testStudentId, existingId = null) {
    const label = file.name || 'upload';
    const localId = existingId || `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const update = (changes) => setAssets((items) => items.map((item) => item.id === localId ? { ...item, ...changes } : item));
    if (existingId) update({ status: 'uploading', error: null });
    else setAssets((items) => [...items, { id: localId, kind, label, testStudentId, file: { uri: file.uri, name: label, mimeType: file.mimeType, size: file.size }, status: 'uploading' }]);
    let createdAssetId = null;
    try {
      let blob = null;
      let size = Number(file.size) || 0;
      if (!size && Platform.OS !== 'web') {
        const info = await FileSystem.getInfoAsync(file.uri);
        size = Number(info.size) || 0;
      }
      if (Platform.OS === 'web') {
        blob = await (await fetch(file.uri)).blob();
        size ||= blob.size;
      }
      const mimeType = file.mimeType || blob?.type || 'application/octet-stream';
      const init = await api('/api/intake/uploads', { method: 'POST', body: JSON.stringify({ action: 'create', testId: test.id, testStudentId, kind, filename: label, mimeType, byteSize: size }) }, accessToken);
      createdAssetId = init.asset.id;
      update({ remoteAssetId: init.asset.id });
      let uploadStatus;
      let uploadDetail = '';
      if (Platform.OS === 'web') {
        const put = await withTimeout(
          fetch(init.uploadUrl, { method: 'PUT', headers: init.headers, body: blob }),
          UPLOAD_PUT_TIMEOUT_MS,
          `Storage upload timed out after ${Math.round(UPLOAD_PUT_TIMEOUT_MS / 1000)}s`,
        );
        uploadStatus = put.status;
        if (!put.ok) uploadDetail = await put.text().catch(() => '');
      } else {
        const put = await putFileWithTimeout(FileSystem, {
          url: init.uploadUrl,
          fileUri: file.uri,
          headers: init.headers,
          isProgressPaused: () => appStateRef.current !== 'active',
        });
        uploadStatus = put.status;
        if (put.status < 200 || put.status >= 300) uploadDetail = put.body || '';
      }
      if (uploadStatus < 200 || uploadStatus >= 300) {
        throw new Error(`Storage upload failed (${uploadStatus}) ${uploadDetail.slice(0, 200)}`);
      }
      await api('/api/intake/uploads', { method: 'POST', body: JSON.stringify({ action: 'complete', assetId: init.asset.id, byteSize: size }) }, accessToken);
      if (!testStudentId && ['question_paper', 'answer_key'].includes(kind)) {
        setAssets((items) => items.map((item) => item.id !== localId && item.kind === kind && item.status === 'uploaded' ? { ...item, status: 'superseded' } : item));
      }
      update({ remoteAssetId: init.asset.id, status: 'uploaded', error: null });
      return init.asset.id;
    } catch (error) {
      if (createdAssetId) {
        await api('/api/intake/uploads', { method: 'POST', body: JSON.stringify({ action: 'discard', assetId: createdAssetId }) }, accessToken).catch(() => {});
      }
      update({ status: 'failed', error: error.message, remoteAssetId: null });
      Alert.alert(`Could not upload ${label}`, error.message);
      return null;
    }
  }

  async function retryUpload(asset) {
    if (!asset.file?.uri) return Alert.alert('Cannot resume this upload', 'The local source file is unavailable. Scan or attach this file again.');
    const info = await FileSystem.getInfoAsync(asset.file.uri);
    if (!info.exists) return Alert.alert('Scan not found', 'The local source file is unavailable. Scan or attach this file again.');
    try {
      if (asset.remoteAssetId) {
        await api('/api/intake/uploads', { method: 'POST', body: JSON.stringify({ action: 'discard', assetId: asset.remoteAssetId }) }, accessToken);
      }
      await upload(asset.file, asset.kind, asset.testStudentId, asset.id);
    } catch (error) { Alert.alert('Could not retry upload', error.message); }
  }

  async function discardUpload(asset) {
    setBusy(true);
    try {
      if (asset.remoteAssetId) await api('/api/intake/uploads', { method: 'POST', body: JSON.stringify({ action: 'discard', assetId: asset.remoteAssetId }) }, accessToken);
      setAssets((items) => items.filter((item) => item.id !== asset.id));
      await refreshOpenTest();
    } catch (error) { Alert.alert('Could not discard upload', error.message); } finally { setBusy(false); }
  }

  // The update check itself never blocks the app — it runs in parallel with
  // session restore. We only take over the screen when an update is actually
  // being installed or the mandatory check failed.
  if (updateState === 'installing') return <SafeAreaView style={styles.page}><View style={styles.splash}><Image source={skyllLogo} resizeMode="contain" style={styles.logoImage} /><Text style={styles.title}>Skyll AI</Text><NotebookLoader size={64} /><Text style={styles.panelTitle}>Updating Skyll AI...</Text><Text style={styles.caption}>Please keep this screen open while we install the update.</Text></View></SafeAreaView>;

  if (bootstrapping) return <SafeAreaView style={styles.page}><View style={styles.splash}><Image source={skyllLogo} resizeMode="contain" style={styles.logoImage} /><Text style={styles.title}>Skyll AI</Text><NotebookLoader size={48} /><Text style={styles.caption}>Preparing your workspace...</Text></View></SafeAreaView>;

  if (sessionRestoreFailed) return <SafeAreaView style={styles.page}><View style={styles.splash}><Image source={skyllLogo} resizeMode="contain" style={styles.logoImage} /><Text style={styles.title}>Skyll AI</Text><Text style={styles.panelTitle}>Connection problem</Text><Text style={styles.caption}>We could not reach Skyll to restore your session. Your sign-in is still saved on this device — check your internet connection and try again.</Text><Pressable accessibilityRole="button" style={({ pressed }) => [styles.primary, pressed && styles.primaryPressed]} onPress={restoreSession}><Text style={styles.primaryText}>Try again</Text></Pressable></View></SafeAreaView>;

  if (!user) return <SafeAreaView style={styles.page}><KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={0}><View style={styles.login}><View style={styles.logo}><Image source={skyllLogo} resizeMode="contain" style={styles.logoImage} /></View><Text style={styles.loginTitle}>Skyll AI</Text><Text style={styles.caption}>Your assessments, learning insights, and reports in one place.</Text><TextInput style={styles.input} value={username} onChangeText={(value) => { setUsername(value); if (loginError) setLoginError(''); }} placeholder="Username" placeholderTextColor={palette.muted} autoCapitalize="none" autoCorrect={false} autoComplete="username" textContentType="username" accessibilityLabel="Username" returnKeyType="next" blurOnSubmit={false} onSubmitEditing={() => passwordRef.current?.focus()} /><View style={styles.passwordRow}><TextInput ref={passwordRef} style={[styles.input, styles.passwordInput]} value={password} onChangeText={(value) => { setPassword(value); if (loginError) setLoginError(''); }} placeholder="Password" placeholderTextColor={palette.muted} secureTextEntry={!showPassword} autoComplete="password" textContentType="password" accessibilityLabel="Password" returnKeyType="go" onSubmitEditing={signIn} /><Pressable style={styles.passwordToggle} onPress={() => setShowPassword((current) => !current)} accessibilityRole="button" accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}><Text style={styles.passwordToggleText}>{showPassword ? 'Hide' : 'Show'}</Text></Pressable></View>{loginError ? <Text accessibilityLiveRegion="assertive" style={styles.loginError}>{loginError}</Text> : null}<Pressable disabled={busy || !username.trim() || !password} accessibilityRole="button" accessibilityState={{ disabled: busy || !username.trim() || !password, busy }} style={({ pressed }) => [styles.primary, styles.primaryLarge, (busy || !username.trim() || !password) && styles.disabled, pressed && styles.primaryPressed]} onPress={signIn}><Text style={styles.primaryText}>{busy ? 'Signing in...' : 'Sign in'}</Text></Pressable><Pressable accessibilityRole="link" onPress={() => Linking.openURL('https://www.skyllai.com/privacy')} style={styles.privacyAction}><Text style={styles.privacyLink}>Privacy Notice</Text></Pressable></View></KeyboardAvoidingView></SafeAreaView>;

  if (screen === 'student-profile') {
    return <SafeAreaView style={styles.page}><StudentProfileScreen api={api} accessToken={accessToken} onBack={() => setScreen('student')} onLogout={requestSignOut} /></SafeAreaView>;
  }

  if (screen === 'school-profile') {
    return <SafeAreaView style={styles.page}><SchoolProfileScreen api={api} accessToken={accessToken} onBack={() => setScreen(profileReturnScreen || 'home')} onLogout={requestSignOut} /></SafeAreaView>;
  }

  if (user.role === 'student' || screen === 'admin-student' || screen === 'admin-student-subject') {
    const report = studentContext?.report;
    if (roleDataLoading && !report) return <SafeAreaView style={styles.page}><View style={styles.splash}><NotebookLoader size={72} /><Text style={styles.panelTitle}>Loading your report...</Text></View></SafeAreaView>;
    if (!report && studentLoadError) return <SafeAreaView style={styles.page}><View style={styles.splash}><Text style={styles.panelTitle}>Couldn’t load your report</Text><Text style={styles.caption}>{studentLoadError}</Text><Pressable accessibilityRole="button" style={({ pressed }) => [styles.primary, pressed && styles.primaryPressed]} onPress={() => loadStudentContext(accessToken, user.role === 'student' ? '' : viewedStudentUsername, true)}><Text style={styles.primaryText}>Try again</Text></Pressable></View></SafeAreaView>;
    if (screen === 'admin-student-subject' || (user.role === 'student' && screen === 'student-subject')) {
      const submissionId = report?.student?.submission_id || report?.submission_id;
      // Most-recent request per question (listRechecks orders requested_at DESC),
      // narrowed to this report's submission so multi-exam students never see a
      // sibling exam's recheck on the wrong question.
      const recheckByQuestion = {};
      for (const rc of rechecks) {
        if (submissionId && rc.submissionId && rc.submissionId !== submissionId) continue;
        const qn = String(rc.questionNumber ?? rc.question_number ?? '');
        if (qn && !recheckByQuestion[qn]) recheckByQuestion[qn] = rc;
      }
      return <SafeAreaView style={styles.page}><StudentSubjectDashboard subject={activeSubject} studentName={report?.student?.name} school={report?.student?.school || user.school} examName={activeExamName} onLogout={requestSignOut} answerSheet={featureFlags.mobile_portal_v2 ? answerSheet : null} onRequestRecheck={featureFlags.mobile_portal_v2 ? requestRecheck : null} rechecks={featureFlags.mobile_portal_v2 ? recheckByQuestion : null} onBack={() => { setActiveSubject(null); setActiveExamName(''); setAnswerSheet(null); setRechecks([]); setScreen(user.role === 'student' ? 'student' : 'admin-student'); }} /></SafeAreaView>;
    }
    return <SafeAreaView style={styles.page}>{studentOffline ? <OfflineBanner onRetry={() => loadStudentContext(accessToken, user.role === 'student' ? '' : viewedStudentUsername, true)} /> : null}<StudentDashboard context={studentContext} onLogout={requestSignOut} onShareReport={featureFlags.mobile_portal_v2 ? shareReport : undefined} sharing={sharingReport} refreshing={roleDataLoading} onRefresh={() => loadStudentContext(accessToken, user.role === 'student' ? '' : viewedStudentUsername, true)} onCheckUpdate={() => pullAppUpdate({ manual: true })} checkingUpdate={checkingUpdate} onBack={user.role === 'admin' ? () => { setStudentContext(null); setViewedStudentUsername(''); setScreen('teacher'); } : undefined} onProfile={user.role === 'student' ? () => setScreen('student-profile') : undefined} onOpenSubject={(subject, exam) => { setActiveSubject(subject); setActiveExamName(exam?.name || ''); if (featureFlags.mobile_portal_v2) { loadAnswerSheet(subject.name, accessToken, user.role === 'student' ? '' : viewedStudentUsername); loadRechecks(accessToken, subject.name); } setScreen(user.role === 'student' ? 'student-subject' : 'admin-student-subject'); }} /></SafeAreaView>;
  }

  if (screen === 'teacher') return <SafeAreaView style={styles.page}>{teacherOffline ? <OfflineBanner onRetry={() => loadTeacherContext(accessToken, true)} /> : null}<AdminDashboard data={teacherContext} tests={featureFlags.mobile_portal_v2 ? tests : []} school={user.school} onLogout={requestSignOut} onBack={() => setScreen('home')} refreshing={roleDataLoading} onRefresh={() => loadTeacherContext(accessToken, true)} onLoadExamData={loadTeacherExamData} onProfile={() => { setProfileReturnScreen('teacher'); setScreen('school-profile'); }} onOpenStudent={async (student) => { const targetUsername = student.public_username || student.username; const loaded = await loadStudentContext(accessToken, targetUsername); if (loaded) { setViewedStudentUsername(targetUsername); setScreen('admin-student'); } else { Alert.alert('Could not open student', 'Check your connection and try again.'); } }} /></SafeAreaView>;

  if (screen === 'devices') return <SafeAreaView style={styles.page}><FlatList contentContainerStyle={styles.content} data={installations} keyExtractor={(item) => item.installation_id} ListHeaderComponent={<View><Pressable onPress={() => setScreen('home')} style={styles.textAction}><Text style={styles.textActionLabel}>‹ Tests</Text></Pressable><Text style={styles.title}>Device status</Text><Text style={styles.caption}>An installation appears after its signed-in admin or student opens the app. “Last seen” confirms the version currently in use.</Text><Pressable disabled={checkingUpdate} style={styles.secondary} onPress={() => pullAppUpdate({ manual: true })}><Text style={styles.secondaryText}>{checkingUpdate ? 'Checking for updates...' : 'Check for updates'}</Text></Pressable><Text style={styles.caption}>{`This device · runtime ${Updates.runtimeVersion || 'unknown'} · ${Updates.updateId || 'embedded bundle'}`}</Text></View>} renderItem={({ item }) => <View style={styles.testCard}><View style={styles.testCardCopy}><Text style={styles.studentName}>{item.username}</Text><Text style={styles.studentMeta}>{`${item.platform} · app ${item.app_version || 'unknown'} · runtime ${item.runtime_version || 'unknown'}`}</Text><Text style={styles.testTimestamp}>{`Last seen ${new Date(item.last_seen_at).toLocaleString()}`}</Text><Text numberOfLines={1} style={styles.studentMeta}>{item.update_id ? `Update ${item.update_id}` : 'Embedded app update'}</Text></View></View>} ListEmptyComponent={<View style={styles.empty}><Text style={styles.panelTitle}>No devices yet</Text><Text style={styles.caption}>Device status appears after an administrator or student signs in with the latest app.</Text></View>} /></SafeAreaView>;

  if (screen === 'home') return <SafeAreaView style={styles.page}><FlatList contentContainerStyle={styles.content} data={tests} keyExtractor={(item) => item.id} refreshControl={<RefreshControl refreshing={refreshingTests} onRefresh={async () => { setRefreshingTests(true); try { await loadTests(accessToken, true); } finally { setRefreshingTests(false); } }} />} ListHeaderComponent={<View><View style={styles.homeHeader}><View><Image source={skyllLogo} resizeMode="contain" style={styles.headerLogo} /><Text style={styles.title}>Skyll AI</Text><Text style={styles.caption}>{user.school}</Text></View><Pressable accessibilityRole="button" accessibilityLabel="Log out" onPress={requestSignOut} style={styles.textAction}><Text style={styles.textActionLabel}>Log out</Text></Pressable></View>{permissions.canCreateTests ? <Pressable accessibilityRole="button" style={({ pressed }) => [styles.primary, styles.primaryLarge, pressed && styles.primaryPressed]} onPress={startNewTest}><Text style={styles.primaryText}>Create new test</Text></Pressable> : null}{permissions.canViewClassInsights ? <Pressable accessibilityRole="button" style={styles.secondary} onPress={() => setScreen('teacher')}><Text style={styles.secondaryText}>Class insights</Text></Pressable> : null}{permissions.canViewClassInsights ? <Pressable accessibilityRole="button" style={styles.secondary} onPress={() => { setProfileReturnScreen('home'); setScreen('school-profile'); }}><Text style={styles.secondaryText}>School profile</Text></Pressable> : null}{permissions.canViewDeviceStatus ? <Pressable accessibilityRole="button" style={styles.secondary} onPress={openDeviceStatus}><Text style={styles.secondaryText}>Device and update status</Text></Pressable> : null}<Pressable accessibilityRole="button" accessibilityState={{ disabled: Boolean(checkingUpdate) }} disabled={checkingUpdate} style={styles.secondary} onPress={() => pullAppUpdate({ manual: true })}><Text style={styles.secondaryText}>{checkingUpdate ? 'Checking for updates...' : 'Check for updates'}</Text></Pressable>{permissions.canCreateTests && draftRestored ? <Pressable accessibilityRole="button" style={styles.secondary} onPress={resumeDraft}><Text style={styles.secondaryText}>Resume saved draft</Text></Pressable> : null}{lockedBanners}<Text style={styles.sectionTitle}>{permissions.canCreateTests ? 'Your tests' : 'Assigned tests'}</Text><Text style={styles.caption}>{permissions.canCreateTests ? 'Open a test to scan more scripts, attach files, or add batches before processing begins.' : 'Open an existing test and scan answer sheets. Test setup and processing are handled by the school administrator.'}</Text></View>} renderItem={({ item }) => <View style={styles.testCard}><View style={styles.testCardCopy}><Text style={styles.studentName}>{item.title}</Text><Text style={styles.studentMeta}>{[item.subject, item.grade, `${item.studentCount} students`].filter(Boolean).join(' · ')}</Text><Text style={styles.testTimestamp}>{item.jobStatus ? `Processing: ${item.jobStatus}` : item.status === 'uploading' ? 'Uploading in progress' : item.status.replaceAll('_', ' ')}</Text></View><View style={styles.testActions}><Pressable accessibilityRole="button" accessibilityLabel="Open test" style={styles.testOpenAction} onPress={() => openTest(item.id)}><Text style={styles.testOpenActionText}>Open test</Text></Pressable>{permissions.canRenameTests ? <Pressable accessibilityRole="button" accessibilityLabel="Rename test" onPress={() => openRenameTest(item)} style={styles.testAction}><Text style={styles.renameLabel}>Rename test</Text></Pressable> : null}{permissions.canDeleteTests && item.jobStatus !== 'running' ? <Pressable accessibilityRole="button" accessibilityLabel="Delete test" accessibilityState={{ disabled: Boolean(busy) }} disabled={busy} onPress={() => confirmDeleteTest(item)} style={styles.testAction}><Text style={styles.deleteLabel}>Delete test</Text></Pressable> : null}</View></View>} ListEmptyComponent={!busy ? <View style={styles.empty}><Text style={styles.panelTitle}>{permissions.canCreateTests ? 'No tests yet' : 'No assigned tests yet'}</Text><Text style={styles.caption}>{permissions.canCreateTests ? 'Create a test, choose existing batches, then scan each student’s paper.' : 'Ask the school administrator to create the test first. It will appear here automatically.'}</Text></View> : null} /><Modal visible={Boolean(renameTarget)} transparent animationType="fade" onRequestClose={() => setRenameTarget(null)}><Pressable style={styles.sheetBackdrop} onPress={() => setRenameTarget(null)}><View style={styles.sheetCard}><Text style={styles.sheetTitle}>Rename test</Text><Text style={styles.sheetMessage}>Set a new name for this test. Its ID, batches, students, uploads and processing history are unchanged.</Text><TextInput style={styles.input} value={renameTitle} onChangeText={setRenameTitle} placeholder="Test name" placeholderTextColor={palette.muted} autoFocus maxLength={MAX_TEST_TITLE_LENGTH} /><Pressable disabled={busy} style={({ pressed }) => [styles.sheetAction, styles.sheetActionPrimary, busy && styles.disabled, pressed && styles.primaryPressed]} onPress={renameTest}><Text style={styles.sheetActionLabelPrimary}>{busy ? 'Saving...' : 'Save name'}</Text></Pressable><Pressable style={[styles.sheetAction, styles.sheetCancelAction]} onPress={() => setRenameTarget(null)}><Text style={styles.sheetActionLabel}>Cancel</Text></Pressable></View></Pressable></Modal></SafeAreaView>;

  const sittingLocked = !canAcceptAnswerSheetUpload({ testStatus: test?.status, hasActiveProcessingJob: Boolean(job && (job.status === 'queued' || job.status === 'running')) });
  const sittingProgress = sittingTotal ? Math.min(1, sittingScanned / sittingTotal) : 0;
  const nextUpFirstName = nextUpStudent ? String(nextUpStudent.name || '').trim().split(/\s+/)[0] : '';
  const rosterPills = [
    { key: 'all', label: `All · ${sittingTotal}` },
    { key: 'to-scan', label: `To scan · ${Math.max(0, sittingTotal - sittingScanned)}` },
    { key: 'scanned', label: `Scanned · ${sittingScanned}` },
  ];
  const header = <View>
    <View style={styles.editorNav}>
      <Pressable accessibilityRole="button" accessibilityLabel="Back to tests" onPress={() => { rememberWorkspace('home'); setScreen('home'); loadTests(); }} style={({ pressed }) => [styles.backButton, pressed && styles.pressedDim]}><Text style={styles.backButtonText}>‹ Tests</Text></Pressable>
      <Pressable accessibilityRole="button" onPress={requestSignOut} style={styles.textAction}><Text style={styles.textActionLabel}>Log out</Text></Pressable>
    </View>
    <View style={styles.header}>
      <View style={styles.headerCopy}>
        <Text style={styles.eyebrow}>Assessment</Text>
        <Text style={styles.editorTitle}>{test ? test.title : 'Set up a test'}</Text>
        <Text style={styles.caption}>{[test?.subject, user.school].filter(Boolean).join(' · ')}{draftRestored ? ' · Draft restored' : ''}</Text>
        {permissions.canRenameTests && test ? <Pressable onPress={() => openRenameTest(test)} style={styles.textAction}><Text style={styles.textActionLabel}>Rename test</Text></Pressable> : null}
      </View>
      <Badge tone={job || test ? 'ready' : 'neutral'}>{job ? 'Queued' : test ? 'Roster ready' : 'Draft'}</Badge>
    </View>
    {!test ? <View style={styles.panel}>
      <Text style={styles.panelTitle}>Test details</Text>
      <TextInput style={styles.input} value={title} onChangeText={setTitle} placeholder="Exam name" placeholderTextColor={palette.muted} />
      <Text style={styles.sectionTitle}>Subject</Text>
      <View style={styles.choiceWrap}>{SUBJECTS.map((value) => <Pressable key={value} accessibilityRole="button" accessibilityState={{ selected: subject === value }} onPress={() => setSubject(value)} style={[styles.choicePill, subject === value && styles.choicePillActive]}><Text style={[styles.choicePillText, subject === value && styles.choicePillTextActive]}>{value}</Text></Pressable>)}</View>
      <Pressable style={[styles.input, styles.dateField]} onPress={() => { setCalendarMonth(() => { const d = examDate ? new Date(examDate + 'T00:00:00') : new Date(); return { year: d.getFullYear(), month: d.getMonth() }; }); setDatePickerOpen(true); }}><Text style={[styles.dateFieldText, !examDate && styles.dateFieldPlaceholder]}>{examDate || 'Select exam date'}</Text><Text style={styles.dateFieldAction}>Change</Text></Pressable>
      <Modal visible={datePickerOpen} animationType="slide" onRequestClose={() => setDatePickerOpen(false)}><SafeAreaView style={styles.reviewPage}>
        <View style={styles.reviewHeader}><View style={styles.headerCopy}><Text style={styles.panelTitle}>Exam date</Text><Text style={styles.caption}>Tap a date to select it.</Text></View><Pressable accessibilityRole="button" onPress={() => setDatePickerOpen(false)} style={styles.textAction}><Text style={styles.link}>Cancel</Text></Pressable></View>
        <View style={styles.calendarNav}>
          <Pressable accessibilityRole="button" accessibilityLabel="Previous month" style={styles.calendarNavButton} onPress={() => setCalendarMonth((cur) => { const m = cur.month - 1; return m < 0 ? { year: cur.year - 1, month: 11 } : { year: cur.year, month: m }; })}><Text style={styles.calendarNavArrow}>‹</Text></Pressable>
          <Text style={styles.calendarMonth}>{monthNames[calendarMonth.month]} {calendarMonth.year}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Next month" style={styles.calendarNavButton} onPress={() => setCalendarMonth((cur) => { const m = cur.month + 1; return m > 11 ? { year: cur.year + 1, month: 0 } : { year: cur.year, month: m }; })}><Text style={styles.calendarNavArrow}>›</Text></Pressable>
        </View>
        <View style={styles.calendarWeekdays}>{weekdayLabels.map((label, i) => <View key={i} style={styles.calendarCell}><Text style={styles.calendarWeekday}>{label}</Text></View>)}</View>
        <ScrollView contentContainerStyle={styles.calendarBody}>{calendarWeeks.map((week, weekIndex) => <View key={weekIndex} style={styles.calendarRow}>{week.map((day, dayIndex) => { if (!day) return <View key={`${weekIndex}-${dayIndex}`} style={styles.calendarDayCell} />; const dateStr = localDateString(day); const isSelected = dateStr === examDate; const isToday = dateStr === todayStr; return <Pressable key={`${weekIndex}-${dayIndex}`} accessibilityRole="button" accessibilityState={{ selected: isSelected }} accessibilityLabel={`${monthNames[calendarMonth.month]} ${day.getDate()}, ${calendarMonth.year}${isToday ? ', today' : ''}`} style={styles.calendarDayCell} onPress={() => { setExamDate(dateStr); setDatePickerOpen(false); }}><View style={[styles.calendarDay, isToday && !isSelected && styles.calendarDayToday, isSelected && styles.calendarDaySelected]}><Text style={[styles.calendarDayText, isSelected && styles.calendarDayTextSelected]}>{day.getDate()}</Text></View></Pressable>; })}</View>)}</ScrollView>
      </SafeAreaView></Modal>
      <Text style={styles.sectionTitle}>Exam type</Text>
      <View style={styles.choiceRow}>{EXAM_TYPES.map((value) => <Pressable key={value} accessibilityRole="button" accessibilityState={{ selected: examType === value }} onPress={() => setExamType(value)} style={[styles.choicePill, styles.choicePillFlex, examType === value && styles.choicePillActive]}><Text style={[styles.choicePillText, styles.choicePillTextCapitalize, examType === value && styles.choicePillTextActive]}>{value === 'mcq' ? 'MCQ' : value}</Text></Pressable>)}</View>
      <Text style={styles.sectionTitle}>Batches</Text>
      <Text style={styles.caption}>Select the existing class batch for this assessment. Its roster is locked in by the server.</Text>
      <Pressable style={({ pressed }) => [styles.secondary, pressed && styles.pressedDim]} onPress={() => openBatchPicker('create')}><Text style={styles.secondaryText}>{selectedBatches.length ? `${selectedBatches.map((batch) => batch.name).join(', ')} · ${selectedStudentCount} students` : batchesLoading ? 'Loading batches...' : 'Select batch'}</Text></Pressable>
      {!batchesLoading && !batches.length ? <Text style={[styles.caption, styles.cautionText]}>No active batches are available yet. Import the school roster before creating a test.</Text> : null}
      <Pressable disabled={busy || !selectedBatchIds.length} accessibilityRole="button" accessibilityState={{ disabled: busy || !selectedBatchIds.length }} style={({ pressed }) => [styles.primary, (busy || !selectedBatchIds.length) && styles.disabled, pressed && styles.primaryPressed]} onPress={createTest}><Text style={styles.primaryText}>{busy ? 'Creating...' : 'Create test'}</Text></Pressable>
    </View> : <View>
      {sittingTotal ? <View style={styles.progressRow}>
        <Text accessibilityLabel={`${sittingScanned} of ${sittingTotal} scanned`} style={styles.progressCount}>{sittingScanned}<Text style={styles.progressTotal}>{`/${sittingTotal}`}</Text></Text>
        <View style={styles.progressCopy}>
          <View accessibilityRole="progressbar" accessibilityLabel="Scanned" accessibilityValue={{ min: 0, max: sittingTotal, now: sittingScanned }} style={styles.progressTrack}><View style={[styles.progressFill, { width: `${Math.round(sittingProgress * 100)}%` }, sittingProgress > 0 && sittingProgress < 1 && styles.progressFillEdge]} /></View>
          <Text style={styles.progressCaption}>{sittingScanned >= sittingTotal ? 'every student has pages' : 'scanned'}</Text>
        </View>
      </View> : null}
      {nextUpStudent && !sittingLocked ? <View style={styles.nextCard}>
        <View style={styles.nextSticker}><Text style={styles.nextStickerText}>Next up</Text></View>
        <View style={styles.nextWho}>
          <View style={styles.avatar}><Text style={styles.avatarText}>{initialsOf(nextUpStudent.name)}</Text></View>
          <View style={styles.headerCopy}>
            <Text numberOfLines={1} style={styles.nextName}>{nextUpStudent.name}</Text>
            <Text style={styles.nextMeta}>No pages yet</Text>
          </View>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel={`Scan ${nextUpStudent.name}'s paper`} accessibilityState={{ disabled: busy, busy }} disabled={busy} style={({ pressed }) => [styles.scanHero, busy && styles.disabled, pressed && styles.primaryPressed]} onPress={() => startStudentScan(nextUpStudent)}>
          <ScanGlyph />
          <Text numberOfLines={1} style={styles.scanHeroText}>{`Scan ${nextUpFirstName || 'next'}'s paper`}</Text>
        </Pressable>
      </View> : null}
      {permissions.canManageReferenceFiles ? <View style={styles.panel}>
        <View style={styles.rowBetween}>
          <View style={styles.refHeaderCopy}><Text style={styles.panelTitle}>Reference material</Text><Text style={styles.caption}>Attach both PDFs, then preview them before processing.</Text></View>
          <Pressable disabled={Boolean(job)} style={({ pressed }) => [styles.compactAction, styles.refEditBatches, job && styles.disabled, pressed && styles.pressedDim]} onPress={() => openBatchPicker('edit')}><Text style={styles.compactActionText}>Edit batches</Text></Pressable>
        </View>
        <View style={styles.twoCol}>{['question_paper', 'answer_key'].map((kind) => { const label = kind === 'question_paper' ? 'Question paper' : 'Answer key'; const refState = referenceStateOf(kind); const stateLabel = refState.status === 'uploading' ? 'Uploading' : refState.status === 'failed' ? 'Failed' : refState.status === 'uploaded' ? 'Ready' : 'Not uploaded'; return <View key={kind} style={styles.assetButton}>
          <View style={styles.assetHeader}><Text style={styles.assetLabel}>{label}</Text>{refState.status === 'failed' ? <Text style={styles.assetStateFailed}>{stateLabel}</Text> : <Text style={refState.status === 'uploaded' ? styles.assetStateReady : styles.assetStateNeutral}>{stateLabel}</Text>}</View>
          {refState.status === 'failed' ? <Text style={styles.assetErrorText}>This file could not be uploaded.</Text> : null}
          <View style={styles.assetActions}>
            <Pressable accessibilityRole="button" accessibilityLabel={`${refState.status === 'uploaded' ? 'Replace' : 'Upload'} ${label}`} accessibilityState={{ disabled: Boolean(job) || refState.status === 'uploading' }} disabled={Boolean(job) || refState.status === 'uploading'} style={[styles.assetMgmtAction, (Boolean(job) || refState.status === 'uploading') && styles.disabled]} onPress={() => chooseReference(kind)}><Text style={styles.assetMgmtActionText}>{refState.status === 'uploaded' ? 'Replace' : 'Upload'}</Text></Pressable>
            {refState.status === 'uploaded' ? <Pressable accessibilityRole="button" accessibilityLabel={`Preview ${label}`} accessibilityState={{ disabled: Boolean(busy) }} disabled={busy} style={[styles.assetMgmtAction, styles.assetPrimaryAction, busy && styles.disabled]} onPress={() => previewReference(refState.asset)}><Text style={styles.assetPrimaryActionText}>Preview</Text></Pressable> : null}
          </View>
          {refState.status !== 'uploaded' && (Boolean(job) || refState.status === 'uploading') ? <Text style={styles.assetDisabledReason}>{refState.status === 'uploading' ? 'Available once this file finishes uploading.' : 'Available after processing finishes.'}</Text> : null}
        </View>; })}</View>
      </View> : <View style={styles.panel}><Text style={styles.panelTitle}>Scanning workspace</Text><Text style={styles.caption}>Question paper, answer key, batches, and processing are managed by the school administrator. Scan or replace student answer sheets below.</Text></View>}
      <Text style={styles.sectionTitle}>Answer sheets</Text>
      <Text style={styles.caption}>The scanner finds page edges and straightens each page. You check every page before it uploads.</Text>
      {test?.students?.length ? <View style={styles.searchRow}>
        <View style={styles.searchBox}>
          <SearchGlyph />
          <TextInput accessibilityLabel="Search students" style={styles.searchInput} value={studentSearchQuery} onChangeText={setStudentSearchQuery} placeholder={`Search ${test.students.length} student${test.students.length === 1 ? '' : 's'}`} placeholderTextColor={palette.muted} autoCapitalize="none" autoCorrect={false} returnKeyType="search" />
        </View>
        {studentSearchQuery ? <Pressable accessibilityRole="button" accessibilityLabel="Clear student search" style={styles.clearSearch} onPress={() => setStudentSearchQuery('')}><Text style={styles.clearSearchLabel}>Clear</Text></Pressable> : null}
      </View> : null}
      {test?.students?.length ? <View accessibilityRole="radiogroup" accessibilityLabel="Show" style={styles.filterRow}>{rosterPills.map((pill) => { const active = rosterFilter === pill.key; return <Pressable key={pill.key} accessibilityRole="radio" accessibilityState={{ selected: active, checked: active }} onPress={() => setRosterFilter(pill.key)} style={[styles.filterPill, active && styles.filterPillActive]}><Text numberOfLines={1} style={[styles.filterPillText, active && styles.filterPillTextActive]}>{pill.label}</Text></Pressable>; })}</View> : null}
      {studentSearchQuery.trim() && filteredStudents.length ? <Text style={styles.caption}>{filteredStudents.length} of {test?.students?.length || 0} student{filteredStudents.length === 1 ? '' : 's'} match “{studentSearchQuery.trim()}”</Text> : null}
    </View>}
  </View>;

  const showRecoveryBar = !queueBanner && test && localRecoveryNote;
  return <SafeAreaView style={styles.page}>
    <FlatList contentContainerStyle={styles.content} data={rosterStudents} keyExtractor={(item, index) => item.id || String(index)} ListHeaderComponent={header} keyboardShouldPersistTaps="handled"
      ListEmptyComponent={test ? <View style={styles.empty}><Text style={styles.panelTitle}>{studentSearchQuery.trim() ? 'No students match' : rosterFilter !== 'all' && filteredStudents.length ? (rosterFilter === 'scanned' ? 'Nobody scanned yet' : 'Everyone is scanned') : 'No students yet'}</Text><Text style={styles.caption}>{studentSearchQuery.trim() ? `No student names match “${studentSearchQuery.trim()}”.` : rosterFilter !== 'all' && filteredStudents.length ? 'Switch to All to see the full roster.' : 'Add batches to this test to load its students.'}</Text></View> : null}
      renderItem={({ item, index }) => { const counts = countsForStudent(uploadQueue, item.testStudentId); const allUploaded = (scansByStudent[item.testStudentId] || 0) > 0 && !counts.queuedCount && !counts.uploadingCount && !counts.failedCount; return <View style={[styles.student, index === 0 && styles.studentFirst, index === rosterStudents.length - 1 && styles.studentLast]}>
        <View style={styles.studentCopy}>
          <Text numberOfLines={1} style={styles.studentName}>{item.name}</Text>
          <Text style={[styles.studentMeta, counts.failedCount ? styles.studentMetaFailed : allUploaded && styles.studentMetaDone]}>{studentScanLine({ uploadedCount: scansByStudent[item.testStudentId] || 0, ...counts })}</Text>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel={`Scan answer sheet for ${item.name}`} accessibilityState={{ disabled: busy, busy }} disabled={busy} style={({ pressed }) => [styles.scan, busy && styles.disabled, pressed && styles.pressedDim]} onPress={() => startStudentScan(item)}><Text style={styles.scanText}>Scan</Text></Pressable>
      </View>; }}
      ListFooterComponent={test ? <View style={styles.footer}>
        <Text style={styles.sectionTitle}>Upload activity</Text>
        {assets.filter((asset) => asset.status !== 'superseded').map((asset) => <View key={asset.id} style={styles.activity}>
          <Text numberOfLines={1} style={styles.activityName}>{asset.label}{asset.error ? ` · ${asset.error}` : ''}</Text>
          <View style={styles.activityActions}>
            {asset.status === 'failed' ? <Pressable style={styles.retry} onPress={() => retryUpload(asset)}><Text style={styles.retryText}>Retry</Text></Pressable> : null}
            {['failed', 'registered', 'uploading'].includes(asset.status) ? <Pressable style={styles.retry} onPress={() => discardUpload(asset)}><Text style={styles.remove}>Discard</Text></Pressable> : null}
            <Badge tone={asset.status === 'uploaded' ? 'ready' : asset.status === 'failed' ? 'warn' : 'neutral'}>{asset.status}</Badge>
          </View>
        </View>)}
        {permissions.canQueueProcessing ? <Pressable disabled={busy || !canQueue || Boolean(job)} accessibilityRole="button" accessibilityState={{ disabled: busy || !canQueue || Boolean(job) }} style={({ pressed }) => [styles.primary, (busy || !canQueue || job) && styles.disabled, pressed && styles.primaryPressed]} onPress={queueTest}><Text style={styles.primaryText}>{job ? 'Processing queued' : busy ? 'Queuing...' : 'Queue processing'}</Text></Pressable> : <Text style={styles.caption}>Uploads are saved for the school administrator to process.</Text>}
        {permissions.canQueueProcessing && !canQueue && <Text style={styles.caption}>Attach both reference PDFs and at least one answer sheet to queue processing.</Text>}
      </View> : null} />
    {lockedBanners}
    {queueBanner ? <Pressable accessibilityRole={queueSummary.failed ? 'button' : 'text'} accessibilityLiveRegion="polite" onPress={queueSummary.failed ? openFailedUploadsActions : undefined} style={styles.queueBanner}>
      <UploadGlyph />
      <Text style={styles.queueBannerText}>{queueBanner}</Text>
      <Text style={styles.queueBannerAction}>{queueSummary.failed ? 'Retry' : 'Keep scanning'}</Text>
    </Pressable> : null}
    {showRecoveryBar ? <Pressable accessibilityRole="button" onPress={() => recoverLocalScans({ testId: test.id, uploadedCounts: scansByStudent, studentNames: Object.fromEntries((test.students || []).map((student) => [student.testStudentId, student.name])), announce: true })} style={styles.queueBanner}>
      <UploadGlyph />
      <Text style={styles.queueBannerText}>{localRecoveryNote}</Text>
    </Pressable> : null}
    <Modal visible={batchPickerOpen} animationType="slide" onRequestClose={() => { setBatchSearch(''); setBatchPickerOpen(false); }}><SafeAreaView style={styles.reviewPage}>
      <View style={styles.reviewHeader}><View style={styles.headerCopy}><Text style={styles.panelTitle}>{batchPickerMode === 'edit' ? 'Add batches' : 'Select batches'}</Text><Text style={styles.caption}>{selectedBatchIds.length} selected · {selectedStudentCount} students</Text></View><Pressable disabled={busy} style={({ pressed }) => [styles.headerDone, pressed && styles.primaryPressed]} onPress={() => { setBatchSearch(''); saveBatches(); }}><Text style={styles.headerDoneText}>{batchPickerMode === 'edit' ? 'Save' : 'Done'}</Text></Pressable></View>
      <View style={styles.pickerSearch}><TextInput style={styles.input} value={batchSearch} onChangeText={setBatchSearch} placeholder="Search batches" placeholderTextColor={palette.muted} autoCapitalize="none" /></View>
      <ScrollView contentContainerStyle={styles.reviewContent}>{filteredBatches.length ? filteredBatches.map((batch) => { const selected = selectedBatchIds.includes(batch.id); return <Pressable key={batch.id} accessibilityRole="checkbox" accessibilityState={{ checked: selected }} onPress={() => toggleBatch(batch.id)} style={[styles.batchRow, selected && styles.batchRowSelected]}>
        <View style={styles.batchRowMain}>
          <View style={[styles.checkbox, selected && styles.checkboxChecked]}>{selected ? <Text style={styles.checkboxMark}>✓</Text> : null}</View>
          <View style={styles.headerCopy}><Text style={styles.studentName}>{batch.name}</Text><Text style={styles.studentMeta}>{[batch.grade, batch.stream, `${batch.studentCount} students`].filter(Boolean).join(' · ')}</Text></View>
        </View>
        <Badge tone={selected ? 'ready' : 'neutral'}>{selected ? 'Selected' : 'Select'}</Badge>
      </Pressable>; }) : <View style={styles.pickerEmpty}><Text style={styles.caption}>{batches.length ? 'No batches match your search.' : 'No active batches available.'}</Text></View>}</ScrollView>
    </SafeAreaView></Modal>
    <ScanReviewModal pendingScan={pendingScan} busy={busy} onCancel={cancelPendingScan} onAddPages={() => { const { student, pages, replaceExisting } = pendingScan; chooseScan(student, pages, replaceExisting); }} onConfirm={confirmScan} onRemovePage={removePendingPage} onRetakePage={retakePendingPage} />
    <Modal visible={Boolean(scanOptionsStudent)} transparent animationType="fade" onRequestClose={() => setScanOptionsStudent(null)}><Pressable style={styles.sheetBackdrop} onPress={() => setScanOptionsStudent(null)}><View style={styles.sheetCard}>
      <Text style={styles.sheetTitle}>Existing paper found</Text>
      <Text style={styles.sheetMessage}>{scanOptionsStudent?.name} already has {scansByStudent[scanOptionsStudent?.testStudentId] || 0} uploaded page(s).</Text>
      <Pressable accessibilityRole="button" style={({ pressed }) => [styles.sheetAction, styles.sheetActionPrimary, pressed && styles.primaryPressed]} onPress={() => { const student = scanOptionsStudent; setScanOptionsStudent(null); previewStudentPaper(student); }}><Text style={styles.sheetActionLabelPrimary}>Preview paper</Text></Pressable>
      <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy, busy }} disabled={busy} style={({ pressed }) => [styles.sheetAction, busy && styles.disabled, pressed && styles.pressedDim]} onPress={() => { const student = scanOptionsStudent; setScanOptionsStudent(null); chooseScan(student); }}><Text style={styles.sheetActionLabel}>Add pages</Text></Pressable>
      {permissions.canScanExistingTests ? <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy, busy }} disabled={busy} style={({ pressed }) => [styles.sheetAction, busy && styles.disabled, pressed && styles.pressedDim]} onPress={() => { const student = scanOptionsStudent; if (studentHasBlockingUploads(uploadQueue, student.testStudentId)) { Alert.alert('Uploads in progress', `Wait for ${student.name}'s pages to finish sending, or retry failed uploads, before replacing this paper.`); return; } setScanOptionsStudent(null); chooseScan(student, [], true); }}><Text style={[styles.sheetActionLabel, styles.sheetActionDestructive]}>Replace paper</Text></Pressable> : null}
      {permissions.canDeleteTests ? <Pressable accessibilityRole="button" style={({ pressed }) => [styles.sheetAction, pressed && styles.pressedDim]} onPress={() => { const student = scanOptionsStudent; setScanOptionsStudent(null); confirmRemoveStudentScan(student); }}><Text style={[styles.sheetActionLabel, styles.sheetActionDestructive]}>Remove paper</Text></Pressable> : null}
      <Pressable accessibilityRole="button" style={[styles.sheetAction, styles.sheetCancelAction]} onPress={() => setScanOptionsStudent(null)}><Text style={styles.sheetActionLabel}>Cancel</Text></Pressable>
    </View></Pressable></Modal>
    <Modal visible={Boolean(studentPaperPreview)} animationType="slide" onRequestClose={() => setStudentPaperPreview(null)}><SafeAreaView style={styles.reviewPage}>
      <View style={styles.reviewHeader}><View style={styles.headerCopy}><Text style={styles.panelTitle}>Answer-sheet preview</Text><Text style={styles.caption}>{studentPaperPreview?.student.name} · Page {(studentPaperPreview?.index || 0) + 1} of {studentPaperPreview?.pages.length || 0}</Text></View><Pressable onPress={() => setStudentPaperPreview(null)} style={({ pressed }) => [styles.headerDone, pressed && styles.primaryPressed]}><Text style={styles.headerDoneText}>Done</Text></Pressable></View>
      <View style={styles.paperPreviewBody}>{studentPaperPreview?.previewUrl ? <Image source={{ uri: studentPaperPreview.previewUrl }} resizeMode="contain" style={styles.paperPreviewImage} accessibilityLabel={`Answer-sheet page ${(studentPaperPreview.index || 0) + 1} of ${studentPaperPreview.pages.length}`} /> : null}</View>
      <View style={[styles.paperPreviewActions, { paddingBottom: Platform.OS === 'android' ? 40 : 16 }]}>
        <Text accessibilityRole="header" accessibilityLabel={`Page ${(studentPaperPreview?.index || 0) + 1} of ${studentPaperPreview?.pages.length || 0}`} style={styles.paperPreviewPageIndicator}>{`Page ${(studentPaperPreview?.index || 0) + 1} of ${studentPaperPreview?.pages.length || 0}`}</Text>
        <Pressable accessibilityLabel="Previous page" disabled={busy || !studentPaperPreview?.index} style={[styles.secondary, styles.paperPreviewNavAction, (!studentPaperPreview?.index || busy) && styles.disabled]} onPress={() => selectStudentPaperPreviewPage(studentPaperPreview.index - 1)}><Text style={styles.secondaryText}>Previous</Text></Pressable>
        <Pressable accessibilityLabel="Next page" disabled={busy || !studentPaperPreview || studentPaperPreview.index >= studentPaperPreview.pages.length - 1} style={[styles.primary, styles.paperPreviewNavAction, (busy || !studentPaperPreview || studentPaperPreview.index >= studentPaperPreview.pages.length - 1) && styles.disabled]} onPress={() => selectStudentPaperPreviewPage(studentPaperPreview.index + 1)}><Text style={styles.primaryText}>Next</Text></Pressable>
      </View>
    </SafeAreaView></Modal>
    <Modal visible={Boolean(renameTarget)} transparent animationType="fade" onRequestClose={() => setRenameTarget(null)}><Pressable style={styles.sheetBackdrop} onPress={() => setRenameTarget(null)}><View style={styles.sheetCard}>
      <Text style={styles.sheetTitle}>Rename test</Text>
      <Text style={styles.sheetMessage}>Set a new name for this test. Its ID, batches, students, uploads and processing history are unchanged.</Text>
      <TextInput style={styles.input} value={renameTitle} onChangeText={setRenameTitle} placeholder="Test name" placeholderTextColor={palette.muted} autoFocus maxLength={MAX_TEST_TITLE_LENGTH} />
      <Pressable disabled={busy} style={({ pressed }) => [styles.sheetAction, styles.sheetActionPrimary, busy && styles.disabled, pressed && styles.primaryPressed]} onPress={renameTest}><Text style={styles.sheetActionLabelPrimary}>{busy ? 'Saving...' : 'Save name'}</Text></Pressable>
      <Pressable style={[styles.sheetAction, styles.sheetCancelAction]} onPress={() => setRenameTarget(null)}><Text style={styles.sheetActionLabel}>Cancel</Text></Pressable>
    </View></Pressable></Modal>
  </SafeAreaView>;
}

export default function AppWithErrorBoundary() {
  // Brand fonts load in the background and never gate rendering: the first
  // paint uses the system font, and this re-renders once they are available.
  useAppFonts();
  return <ErrorBoundary><SafeAreaProvider><App /></SafeAreaProvider></ErrorBoundary>;
}

// Skyll Notebook styles. Operator screens (login, tests, sitting mode, sheets)
// are LOUD: 2px ink borders, hard offset shadows, lime/coral accents and big
// touch targets. Admin-only setup (reference files, devices) stays QUIET.
const tabular = { fontVariant: ['tabular-nums'] };
const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: palette.paper },
  content: { padding: spacing.gutter, paddingBottom: spacing.contentBottom },
  splash: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 28 },

  // Login
  login: { marginTop: 96, marginLeft: spacing.gutter, marginRight: spacing.gutter + 5, backgroundColor: palette.white, borderRadius: radius.hero, padding: 24, borderWidth: 2, borderColor: palette.ink, boxShadow: shadow.xl },
  logo: { width: 72, height: 72, borderRadius: 16, backgroundColor: palette.white, borderWidth: 2, borderColor: palette.ink, alignItems: 'center', justifyContent: 'center', marginBottom: 18, overflow: 'hidden', transform: [{ rotate: '-4deg' }] },
  logoImage: { width: 64, height: 64 },
  loginTitle: { ...type.display, color: palette.ink, fontSize: 36, lineHeight: 40, letterSpacing: -1.2 },
  privacyAction: { alignSelf: 'center', marginTop: 16, minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 },
  privacyLink: { ...type.semibold, color: palette.textSecondary, fontSize: 13, textDecorationLine: 'underline' },
  passwordRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 },
  passwordInput: { flex: 1, marginTop: 0 },
  passwordToggle: { minHeight: 50, minWidth: 64, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 12, borderWidth: 2, borderColor: palette.ink, borderRadius: radius.control, backgroundColor: palette.white },
  passwordToggleText: { ...type.bold, color: palette.ink, fontSize: 14 },
  loginError: { ...type.semibold, color: palette.danger, fontSize: 14, lineHeight: 19, marginTop: 10 },

  // Type
  headerLogo: { width: 40, height: 40, marginBottom: 10 },
  title: { ...type.display, color: palette.ink, fontSize: 30, lineHeight: 34, letterSpacing: -0.8 },
  editorTitle: { ...type.display, color: palette.ink, fontSize: 26, lineHeight: 30, letterSpacing: -0.6 },
  caption: { ...type.regular, color: palette.textSecondary, fontSize: 14, lineHeight: 20, marginTop: 5 },
  cautionText: { ...type.semibold, color: palette.caution },
  eyebrow: { ...type.semibold, color: palette.textSecondary, fontSize: 12, letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 4 },
  sectionTitle: { ...type.display, color: palette.ink, fontSize: 20, lineHeight: 25, letterSpacing: -0.4, marginTop: 22, marginBottom: 2 },
  panelTitle: { ...type.display, color: palette.ink, fontSize: 19, lineHeight: 24, letterSpacing: -0.3, marginBottom: 10 },
  link: { ...type.bold, color: palette.action, fontSize: 15 },

  // Layout
  header: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 18 },
  headerCopy: { flex: 1, minWidth: 0 },
  homeHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 },
  editorNav: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  backButton: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 14, borderWidth: 2, borderColor: palette.ink, borderRadius: radius.control, backgroundColor: palette.white },
  backButtonText: { ...type.bold, color: palette.ink, fontSize: 15 },
  textAction: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 4, alignSelf: 'flex-start' },
  textActionLabel: { ...type.bold, color: palette.action, fontSize: 15 },
  panel: { backgroundColor: palette.white, borderWidth: 1, borderColor: palette.hairline, borderRadius: radius.card, padding: 16, marginTop: 14 },
  twoCol: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  rowBetween: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 },
  refHeaderCopy: { flexGrow: 1, flexShrink: 1, flexBasis: 200, minWidth: 0 },
  refEditBatches: { flexShrink: 0 },

  // Inputs
  input: { ...type.regular, minHeight: 50, backgroundColor: palette.white, borderWidth: 2, borderColor: palette.ink, borderRadius: radius.control, paddingHorizontal: 14, paddingVertical: 12, marginTop: 10, color: palette.ink, fontSize: 16 },
  dateField: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  dateFieldText: { ...type.semibold, color: palette.ink, fontSize: 16 },
  dateFieldPlaceholder: { ...type.regular, color: palette.muted },
  dateFieldAction: { ...type.bold, color: palette.action, fontSize: 14 },
  choiceWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  choiceRow: { flexDirection: 'row', gap: 8, marginTop: 10 },
  choicePill: { minHeight: 44, justifyContent: 'center', alignItems: 'center', borderWidth: 2, borderColor: palette.ink, backgroundColor: palette.white, borderRadius: radius.pill, paddingHorizontal: 14 },
  choicePillFlex: { flex: 1, paddingHorizontal: 8 },
  choicePillActive: { backgroundColor: palette.ink },
  choicePillText: { ...type.semibold, color: palette.ink, fontSize: 14 },
  choicePillTextActive: { ...type.bold, color: palette.lime },
  choicePillTextCapitalize: { textTransform: 'capitalize' },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 12 },
  searchBox: { flex: 1, minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: palette.white, borderWidth: 2, borderColor: palette.ink, borderRadius: radius.control, paddingHorizontal: 12 },
  searchInput: { ...type.regular, flex: 1, paddingVertical: 10, color: palette.ink, fontSize: 16 },
  searchGlyph: { width: 18, height: 18 },
  searchGlyphRing: { position: 'absolute', left: 0, top: 0, width: 13, height: 13, borderRadius: 7, borderWidth: 2, borderColor: palette.ink },
  searchGlyphHandle: { position: 'absolute', left: 11, top: 12, width: 7, height: 2.5, borderRadius: 2, backgroundColor: palette.ink, transform: [{ rotate: '45deg' }] },
  clearSearch: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 6 },
  clearSearchLabel: { ...type.bold, color: palette.action, fontSize: 15 },

  // Buttons
  primary: { minHeight: 50, backgroundColor: palette.action, borderWidth: 2, borderColor: palette.ink, borderRadius: radius.control, boxShadow: shadow.lg, alignItems: 'center', justifyContent: 'center', paddingVertical: 12, paddingHorizontal: 16, marginTop: 14, marginRight: 4 },
  primaryLarge: { minHeight: 56, borderRadius: 14 },
  primaryPressed: pressedSink,
  primaryText: { ...type.bold, color: palette.white, fontSize: 16 },
  secondary: { minHeight: 48, borderWidth: 2, borderColor: palette.ink, borderRadius: radius.control, backgroundColor: palette.white, paddingVertical: 11, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center', marginTop: 10 },
  secondaryText: { ...type.semibold, color: palette.ink, fontSize: 15 },
  compactAction: { minHeight: 40, justifyContent: 'center', borderWidth: 1, borderColor: palette.hairlineStrong, borderRadius: radius.button, paddingHorizontal: 12, backgroundColor: palette.white },
  compactActionText: { ...type.bold, color: palette.action, fontSize: 14 },
  disabled: { opacity: 0.45 },
  pressedDim: { opacity: 0.7 },

  // Badges (words always present; tone is a second cue)
  badge: { alignSelf: 'flex-start', backgroundColor: palette.sunken, paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill },
  badgeText: { ...type.bold, color: palette.textSecondary, fontSize: 12, textTransform: 'capitalize' },
  readyBadge: { backgroundColor: palette.successSoft },
  readyBadgeText: { color: palette.success },
  warnBadge: { backgroundColor: palette.cautionSoft },
  warnBadgeText: { color: palette.caution },

  // Reference material (quiet admin setup)
  assetButton: { flex: 1, minWidth: 0, minHeight: 106, borderWidth: 1, borderColor: palette.hairline, borderRadius: radius.control, padding: 12, marginTop: 12, backgroundColor: palette.paperSoft },
  assetLabel: { ...type.bold, color: palette.ink, fontSize: 14, flexShrink: 1, minWidth: 0 },
  assetHeader: { flexDirection: 'column', alignItems: 'flex-start', gap: 4, marginBottom: 10 },
  assetStateNeutral: { ...type.semibold, color: palette.textSecondary, fontSize: 12, textTransform: 'capitalize', flexShrink: 1, minWidth: 0 },
  assetStateReady: { ...type.bold, color: palette.success, fontSize: 12, textTransform: 'capitalize', flexShrink: 1, minWidth: 0 },
  assetStateFailed: { ...type.bold, color: palette.danger, fontSize: 12, textTransform: 'capitalize', flexShrink: 1, minWidth: 0 },
  assetErrorText: { ...type.regular, color: palette.danger, fontSize: 13, marginTop: 6, lineHeight: 18 },
  assetActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  assetMgmtAction: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, borderWidth: 1, borderColor: palette.hairlineStrong, borderRadius: radius.button, backgroundColor: palette.white },
  assetMgmtActionText: { ...type.bold, color: palette.ink, fontSize: 14 },
  assetPrimaryAction: { borderColor: palette.ink, backgroundColor: palette.ink },
  assetPrimaryActionText: { ...type.bold, color: palette.white, fontSize: 14 },
  assetDisabledReason: { ...type.regular, color: palette.muted, fontSize: 13, marginTop: 8, lineHeight: 18 },

  // Sitting mode: progress, next up, filters, roster
  progressRow: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 18 },
  progressCount: { ...type.display, ...tabular, color: palette.ink, fontSize: 44, lineHeight: 48, letterSpacing: -1.8 },
  progressTotal: { ...type.display, ...tabular, color: palette.textSecondary, fontSize: 20, letterSpacing: -0.4 },
  progressCopy: { flex: 1, gap: 6 },
  progressTrack: { height: 16, backgroundColor: palette.white, borderWidth: 2, borderColor: palette.ink, borderRadius: radius.pill, overflow: 'hidden' },
  progressFill: { height: '100%', backgroundColor: palette.lime },
  progressFillEdge: { borderRightWidth: 2, borderRightColor: palette.ink },
  progressCaption: { ...type.regular, color: palette.textSecondary, fontSize: 14 },
  nextCard: { position: 'relative', backgroundColor: palette.white, borderWidth: 2, borderColor: palette.ink, borderRadius: radius.hero, boxShadow: shadow.xl, padding: 16, paddingTop: 18, gap: 14, marginTop: 6, marginBottom: 8, marginRight: 5 },
  nextSticker: { position: 'absolute', right: 14, top: -13, transform: [{ rotate: '4deg' }], backgroundColor: palette.coral, borderWidth: 2, borderColor: palette.ink, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 3 },
  nextStickerText: { ...type.bold, color: palette.ink, fontSize: 13 },
  nextWho: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  avatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: palette.lime, borderWidth: 2, borderColor: palette.ink, alignItems: 'center', justifyContent: 'center' },
  avatarText: { ...type.bold, color: palette.ink, fontSize: 16 },
  nextName: { ...type.display, color: palette.ink, fontSize: 22, lineHeight: 27, letterSpacing: -0.4 },
  nextMeta: { ...type.regular, color: palette.textSecondary, fontSize: 14 },
  scanHero: { minHeight: 58, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 16, backgroundColor: palette.action, borderWidth: 2, borderColor: palette.ink, borderRadius: 14, boxShadow: shadow.lg, marginRight: 4 },
  scanHeroText: { ...type.bold, color: palette.white, fontSize: 18, flexShrink: 1 },
  scanGlyph: { width: 22, height: 22 },
  scanGlyphCorner: { position: 'absolute', width: 7, height: 7, borderColor: palette.white },
  scanGlyphTL: { left: 1, top: 1, borderLeftWidth: 2.2, borderTopWidth: 2.2, borderTopLeftRadius: 2 },
  scanGlyphTR: { right: 1, top: 1, borderRightWidth: 2.2, borderTopWidth: 2.2, borderTopRightRadius: 2 },
  scanGlyphBL: { left: 1, bottom: 1, borderLeftWidth: 2.2, borderBottomWidth: 2.2, borderBottomLeftRadius: 2 },
  scanGlyphBR: { right: 1, bottom: 1, borderRightWidth: 2.2, borderBottomWidth: 2.2, borderBottomRightRadius: 2 },
  scanGlyphLine: { position: 'absolute', left: 5, right: 5, top: 10, height: 2.2, borderRadius: 1, backgroundColor: palette.white },
  filterRow: { flexDirection: 'row', gap: 8, marginTop: 12, marginBottom: 12 },
  filterPill: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6, borderWidth: 2, borderColor: palette.ink, borderRadius: radius.pill, backgroundColor: palette.white },
  filterPillActive: { backgroundColor: palette.ink },
  filterPillText: { ...type.semibold, color: palette.ink, fontSize: 14 },
  filterPillTextActive: { ...type.bold, color: palette.lime },
  student: { minHeight: 64, paddingVertical: 8, paddingLeft: 14, paddingRight: 10, borderLeftWidth: 2, borderRightWidth: 2, borderBottomWidth: 1, borderColor: palette.ink, borderBottomColor: palette.hairline, backgroundColor: palette.white, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 },
  studentFirst: { borderTopWidth: 2, borderTopLeftRadius: radius.card, borderTopRightRadius: radius.card },
  studentLast: { borderBottomWidth: 2, borderBottomColor: palette.ink, borderBottomLeftRadius: radius.card, borderBottomRightRadius: radius.card },
  studentCopy: { flex: 1, minWidth: 0 },
  studentName: { ...type.bold, color: palette.ink, fontSize: 16 },
  studentMeta: { ...type.regular, color: palette.textSecondary, fontSize: 13, marginTop: 2 },
  studentMetaDone: { ...type.semibold, color: palette.success },
  studentMetaFailed: { ...type.bold, color: palette.danger },
  scan: { minHeight: 44, minWidth: 84, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: palette.ink, borderRadius: radius.control, backgroundColor: palette.white, paddingHorizontal: 14 },
  scanText: { ...type.bold, color: palette.action, fontSize: 15 },
  empty: { marginTop: 14, padding: 18, borderRadius: radius.card, backgroundColor: palette.white, borderWidth: 2, borderColor: palette.ink },

  // Upload status: a black bar pinned to the bottom of the sitting screen
  lockedStack: { gap: 8, marginHorizontal: 14, marginTop: 8 },
  lockedBanner: { gap: 8, paddingVertical: 12, paddingHorizontal: 14, borderWidth: 2, borderColor: palette.caution, borderRadius: radius.card, backgroundColor: palette.cautionSoft },
  lockedBannerText: { ...type.semibold, color: palette.ink, fontSize: 14, lineHeight: 19 },
  lockedActions: { flexDirection: 'row', gap: 8 },
  lockedAction: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: palette.ink, borderRadius: radius.control, backgroundColor: palette.white },
  lockedActionText: { ...type.bold, color: palette.ink, fontSize: 14 },
  lockedDiscardText: { ...type.bold, color: palette.danger, fontSize: 14 },
  queueBanner: { flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: 14, marginTop: 8, marginBottom: 10, paddingVertical: 12, paddingHorizontal: 14, minHeight: 52, backgroundColor: palette.ink, borderRadius: radius.card },
  queueBannerText: { ...type.semibold, flex: 1, color: palette.white, fontSize: 14, lineHeight: 19 },
  queueBannerAction: { ...type.bold, color: palette.lime, fontSize: 13 },
  uploadGlyph: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: palette.lime, alignItems: 'center', justifyContent: 'center' },
  uploadGlyphText: { ...type.bold, color: palette.lime, fontSize: 14, lineHeight: 17 },

  // Upload activity + processing
  footer: { marginTop: 24 },
  activity: { minHeight: 52, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, paddingVertical: 8, paddingHorizontal: 12, backgroundColor: palette.white, borderRadius: radius.control, borderWidth: 1, borderColor: palette.hairline },
  activityName: { ...type.regular, flex: 1, color: palette.ink, fontSize: 13, marginRight: 10 },
  activityActions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  retry: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 },
  retryText: { ...type.bold, color: palette.action, fontSize: 14 },
  remove: { ...type.bold, color: palette.danger, fontSize: 14 },

  // Tests list
  testCard: { marginTop: 12, padding: 16, borderWidth: 2, borderColor: palette.ink, borderRadius: radius.card, backgroundColor: palette.white, flexDirection: 'row', alignItems: 'center', gap: 12 },
  testCardCopy: { flex: 1, minWidth: 0 },
  testActions: { alignItems: 'flex-end', gap: 2 },
  testAction: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 4 },
  testOpenAction: { minHeight: 46, minWidth: 104, justifyContent: 'center', alignItems: 'center', backgroundColor: palette.ink, borderRadius: radius.control, paddingHorizontal: 14 },
  testOpenActionText: { ...type.bold, color: palette.white, fontSize: 15 },
  testTimestamp: { ...type.semibold, alignSelf: 'flex-start', color: palette.ink, backgroundColor: palette.sunken, borderRadius: radius.pill, overflow: 'hidden', paddingHorizontal: 10, paddingVertical: 3, fontSize: 13, marginTop: 8, textTransform: 'capitalize' },
  renameLabel: { ...type.bold, color: palette.action, fontSize: 14 },
  deleteLabel: { ...type.bold, color: palette.danger, fontSize: 14 },

  // Full-screen pickers and previews
  reviewPage: { flex: 1, backgroundColor: palette.paper },
  reviewHeader: { paddingHorizontal: spacing.gutter, paddingVertical: 12, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12, borderBottomWidth: 2, borderColor: palette.ink, backgroundColor: palette.paper },
  headerDone: { minHeight: 44, minWidth: 76, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 14, backgroundColor: palette.action, borderWidth: 2, borderColor: palette.ink, borderRadius: radius.control, boxShadow: shadow.md },
  headerDoneText: { ...type.bold, color: palette.white, fontSize: 15 },
  reviewContent: { padding: spacing.card, gap: 10 },
  pickerSearch: { paddingHorizontal: spacing.gutter, paddingBottom: 4 },
  pickerEmpty: { padding: 20, alignItems: 'center' },
  batchRow: { minHeight: 64, padding: 12, borderWidth: 2, borderColor: palette.ink, borderRadius: radius.card, backgroundColor: palette.white, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  batchRowSelected: { backgroundColor: palette.actionTint },
  batchRowMain: { flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 },
  checkbox: { width: 26, height: 26, borderRadius: 7, borderWidth: 2, borderColor: palette.ink, backgroundColor: palette.white, alignItems: 'center', justifyContent: 'center' },
  checkboxChecked: { backgroundColor: palette.ink },
  checkboxMark: { ...type.bold, color: palette.lime, fontSize: 15, lineHeight: 18 },
  calendarNav: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12 },
  calendarNavButton: { width: 44, height: 44, borderRadius: radius.control, borderWidth: 2, borderColor: palette.ink, backgroundColor: palette.white, alignItems: 'center', justifyContent: 'center' },
  calendarNavArrow: { ...type.bold, color: palette.ink, fontSize: 22, lineHeight: 24 },
  calendarMonth: { ...type.display, color: palette.ink, fontSize: 19, letterSpacing: -0.3 },
  calendarWeekdays: { flexDirection: 'row', paddingHorizontal: 20, paddingBottom: 6 },
  calendarCell: { flex: 1, alignItems: 'center' },
  calendarWeekday: { ...type.semibold, color: palette.textSecondary, fontSize: 12 },
  calendarBody: { paddingHorizontal: 20, paddingBottom: 24 },
  calendarRow: { flexDirection: 'row' },
  calendarDayCell: { flex: 1, height: 48, alignItems: 'center', justifyContent: 'center' },
  calendarDay: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  calendarDayToday: { borderWidth: 2, borderColor: palette.ink },
  calendarDaySelected: { backgroundColor: palette.ink },
  calendarDayText: { ...type.semibold, ...tabular, color: palette.ink, fontSize: 15 },
  calendarDayTextSelected: { ...type.bold, color: palette.lime },
  paperPreviewBody: { flex: 1, padding: 16 },
  paperPreviewImage: { width: '100%', height: '100%', backgroundColor: palette.sunken, borderRadius: radius.control },
  paperPreviewActions: { flexDirection: 'row', gap: 12, paddingHorizontal: spacing.card, paddingTop: spacing.card, backgroundColor: palette.white, borderTopWidth: 2, borderColor: palette.ink },
  paperPreviewPageIndicator: { ...type.bold, ...tabular, color: palette.ink, fontSize: 14, textAlign: 'center', paddingBottom: 10 },
  paperPreviewNavAction: { flex: 1, minHeight: 50, marginTop: 0, justifyContent: 'center', alignItems: 'center', flexDirection: 'row' },

  // Bottom sheets
  sheetBackdrop: { flex: 1, backgroundColor: palette.scrim, justifyContent: 'flex-end' },
  sheetCard: { backgroundColor: palette.paper, borderTopLeftRadius: radius.hero, borderTopRightRadius: radius.hero, borderWidth: 2, borderBottomWidth: 0, borderColor: palette.ink, paddingHorizontal: spacing.gutter, paddingTop: spacing.gutter, paddingBottom: spacing.card + 8 },
  sheetTitle: { ...type.display, color: palette.ink, fontSize: 22, lineHeight: 27, letterSpacing: -0.4 },
  sheetMessage: { ...type.regular, color: palette.textSecondary, fontSize: 15, lineHeight: 21, marginTop: 6, marginBottom: 4 },
  sheetAction: { minHeight: 52, alignItems: 'center', justifyContent: 'center', paddingVertical: 12, marginTop: 10, borderRadius: 14, borderWidth: 2, borderColor: palette.ink, backgroundColor: palette.white },
  sheetActionPrimary: { backgroundColor: palette.action, boxShadow: shadow.lg, marginRight: 4 },
  sheetCancelAction: { backgroundColor: 'transparent', borderColor: 'transparent' },
  sheetActionLabel: { ...type.semibold, color: palette.ink, fontSize: 16 },
  sheetActionLabelPrimary: { ...type.bold, color: palette.white, fontSize: 16 },
  sheetActionDestructive: { ...type.bold, color: palette.danger },
});
