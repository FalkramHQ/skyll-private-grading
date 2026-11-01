import {
  ACTIVE_QUEUE_STATUSES,
  LOCKED_QUEUE_STATUS,
  appendQueueItems,
  discardableItems,
  lockItemsForTests,
  lockedBannerText,
  lockedPagesByTest,
  queuePageNumber,
  unlockItemsForTest,
  unsentLocalPageCount,
  PRESIGN_MAX_AGE_MS,
  UPLOAD_CONCURRENCY,
  UPLOAD_STUCK_MS,
  buildScanQueueItems,
  claimNextQueueItems,
  classifyUploadError,
  countsForStudent,
  dropBlockingItemsForStudent,
  dropItemsForBlockedTests,
  hasActiveUploads,
  nextAttemptAt,
  nextDrainAt,
  normalizePersistedQueue,
  pendingLocalPageCount,
  pickNextQueueItem,
  pickPendingReplaceGroupId,
  queueBannerText,
  queueBlocksProcessing,
  queueStorageKey,
  reclaimStuckUploads,
  reconcileUploadQueue,
  replaceGroupItems,
  replaceGroupReady,
  retryFailedItems,
  shouldRecreateUploadTarget,
  studentHasBlockingUploads,
  studentScanLine,
  summarizeQueue,
  wakeQueuedUploads,
  withExpectedPageCount,
} from '../src/uploadQueue';

const student = { testStudentId: 'ts1', name: 'Asha' };

describe('uploadQueue', () => {
  test('scopes persisted queue keys to the signed-in user', () => {
    expect(queueStorageKey({ username: 'mahadmin' })).toBe('skyll:intake:upload-queue:v1:mahadmin');
  });

  test('reopens in-flight items as queued after a process death', () => {
    expect(normalizePersistedQueue([
      { id: 'q1', testId: 't1', testStudentId: 'ts1', uri: 'file://a.jpg', status: 'uploading', nextAttemptAt: 999 },
      { id: 'q2', testId: 't1', testStudentId: 'ts1', uri: 'file://b.jpg', status: 'uploaded' },
      { id: 'q3', testId: 't1', testStudentId: 'ts1', uri: 'file://c.jpg', status: 'uploaded', replaceGroupId: 'g1', remoteAssetId: 'a1' },
      null,
    ])).toEqual([
      expect.objectContaining({ id: 'q1', status: 'queued', nextAttemptAt: 0 }),
      expect.objectContaining({ id: 'q3', status: 'uploaded', replaceGroupId: 'g1' }),
    ]);
  });

  test('claims several queued pages at once for parallel upload', () => {
    const items = [
      { id: 'a', testId: 't1', testStudentId: 'ts1', status: 'queued', createdAt: 1, nextAttemptAt: 0 },
      { id: 'b', testId: 't1', testStudentId: 'ts1', status: 'queued', createdAt: 2, nextAttemptAt: 0 },
      { id: 'c', testId: 't1', testStudentId: 'ts2', status: 'queued', createdAt: 3, nextAttemptAt: 0 },
    ];
    const { claimed, items: next } = claimNextQueueItems(items, 2);
    expect(claimed.map((item) => item.id)).toEqual(['a', 'b']);
    expect(claimed.every((item) => item.status === 'uploading')).toBe(true);
    expect(next.find((item) => item.id === 'c').status).toBe('queued');
    expect(UPLOAD_CONCURRENCY).toBe(3);
  });

  test('does not starve an older test while a newer test is mid-upload', () => {
    const items = [
      { id: 'old-a', testId: 'cyclic3', testStudentId: 'ts-old', status: 'queued', createdAt: 1, nextAttemptAt: 0 },
      { id: 'old-b', testId: 'cyclic3', testStudentId: 'ts-old', status: 'queued', createdAt: 2, nextAttemptAt: 0 },
      { id: 'new-a', testId: 'cycle2', testStudentId: 'ts-new', status: 'uploading', createdAt: 10, nextAttemptAt: 0, remoteAssetId: 'a1' },
      { id: 'new-b', testId: 'cycle2', testStudentId: 'ts-new', status: 'queued', createdAt: 11, nextAttemptAt: 0, attempts: 1 },
      { id: 'new-c', testId: 'cycle2', testStudentId: 'ts-new', status: 'queued', createdAt: 12, nextAttemptAt: 0 },
    ];
    expect(pickNextQueueItem(items)?.id).toBe('old-a');
    const { claimed } = claimNextQueueItems(items, 2);
    expect(claimed.map((item) => item.id)).toEqual(['old-a', 'old-b']);
  });

  test('dropItemsForBlockedTests still filters by test (kept for callers outside the queue)', () => {
    const next = dropItemsForBlockedTests([
      { id: 'a', testId: 'cyclic3', status: 'queued' },
      { id: 'b', testId: 'cycle2', status: 'queued' },
    ], ['cycle2']);
    expect(next.map((item) => item.id)).toEqual(['a']);
  });

  test('classifies locked answer-sheet creates as terminal', () => {
    expect(classifyUploadError({
      status: 409,
      code: 'answer_sheet_upload_locked',
      message: 'This assessment is locked (ready for review).',
    })).toBe('locked');
  });

  test('wakes queued backoff when returning to the foreground', () => {
    expect(wakeQueuedUploads([
      { id: 'q1', status: 'queued', nextAttemptAt: 9_999_999 },
      { id: 'q2', status: 'failed', nextAttemptAt: 9_999_999 },
    ])).toEqual([
      expect.objectContaining({ id: 'q1', nextAttemptAt: 0 }),
      expect.objectContaining({ id: 'q2', nextAttemptAt: 9_999_999 }),
    ]);
  });

  test('append items record the expected final page count; replace items wait for commit', () => {
    const pages = [{ uri: 'file://1.jpg', byteSize: 10 }, { uri: 'file://2.jpg', byteSize: 10 }];
    const appended = buildScanQueueItems({ testId: 't1', student, pages, uploadedCount: 3, now: 1000 });
    expect(appended).toHaveLength(2);
    expect(appended[0].expectedPageCount).toBe(5);
    expect(appended[0].replaceGroupId).toBeNull();

    const replaced = buildScanQueueItems({ testId: 't1', student, pages, replaceExisting: true, uploadedCount: 3, now: 1000 });
    expect(replaced[0].expectedPageCount).toBeNull();
    expect(replaced[0].replaceGroupId).toBe('replace-ts1-1000');
    expect(replaced.every((item) => item.replaceGroupId === replaced[0].replaceGroupId)).toBe(true);

    const first = [{ testStudentId: 'ts1', expectedPageCount: 2, replaceGroupId: null }];
    expect(withExpectedPageCount([...first, ...appended], 'ts1', 5)[0].expectedPageCount).toBe(5);
    expect(pendingLocalPageCount([{ testStudentId: 'ts1', status: 'queued', replaceGroupId: null }], 'ts1')).toBe(1);
  });

  test('prefers finishing a student who already has pages in flight', () => {
    const items = [
      { id: 'b1', testStudentId: 'ts2', status: 'queued', createdAt: 1, nextAttemptAt: 0 },
      { id: 'a2', testStudentId: 'ts1', status: 'queued', createdAt: 3, nextAttemptAt: 0, remoteAssetId: null, attempts: 0 },
      { id: 'a1', testStudentId: 'ts1', status: 'queued', createdAt: 2, nextAttemptAt: 0, remoteAssetId: 'asset_1', attempts: 1 },
    ];
    expect(pickNextQueueItem(items).id).toBe('a1');
  });

  test('treats a 10-minute-old create as a stale upload target', () => {
    const now = 1_000_000;
    expect(shouldRecreateUploadTarget({ remoteAssetId: 'a1', urlCreatedAt: now - PRESIGN_MAX_AGE_MS }, now)).toBe(true);
    expect(shouldRecreateUploadTarget({ remoteAssetId: 'a1', urlCreatedAt: now - 1000 }, now)).toBe(false);
    expect(shouldRecreateUploadTarget({ remoteAssetId: null }, now)).toBe(true);
  });

  test('classifies auth, expired URL, and offline failures separately', () => {
    expect(classifyUploadError({ status: 401 })).toBe('auth');
    expect(classifyUploadError(new Error('Request has expired'))).toBe('stale-url');
    expect(classifyUploadError(new Error('Network request failed'))).toBe('offline');
    expect(classifyUploadError(new Error('Storage upload failed (500)'))).toBe('unknown');
    expect(classifyUploadError({ status: 404, message: 'Test not found' })).toBe('permanent');
    expect(classifyUploadError({ status: 400, message: 'Uploaded file size does not match registered size' })).toBe('permanent');
    // A DB blip during session lookup returns 503: retry, never sign out.
    expect(classifyUploadError({ status: 503, message: 'Session store unavailable' })).toBe('offline');
  });

  test('builds roster and banner copy from queue counts', () => {
    expect(studentScanLine({ uploadedCount: 2 })).toBe('2 page(s) uploaded');
    expect(studentScanLine({ uploadedCount: 2, queuedCount: 1 })).toBe('2 uploaded · 1 waiting');
    expect(studentScanLine({ uploadedCount: 2, uploadingCount: 1 })).toBe('2 uploaded · 1 sending');
    expect(studentScanLine({ uploadedCount: 2, failedCount: 1 })).toBe('2 uploaded · 1 failed');
    expect(queueBannerText({ uploading: 1, queued: 3 })).toBe('Uploading 1 page in parallel · 3 waiting. Keep the app open.');
    expect(queueBannerText({ failed: 2 })).toBe('2 scans failed to upload. Tap Retry.');
    expect(classifyUploadError({ status: 408, message: 'timed out' })).toBe('offline');
  });

  test('manual retry resets the attempt counter so a failed scan can recover', () => {
    // Items are marked `failed` only after hitting the >=4 attempt cap. If the
    // retry left `attempts` at the cap, the next single failure would immediately
    // re-mark it `failed` — the banner could never be cleared.
    const items = [{ id: 'q1', testId: 't1', testStudentId: 'ts1', status: 'failed', attempts: 4, lastError: 'boom' }];
    const [retried] = retryFailedItems(items, 't1');
    expect(retried).toMatchObject({ status: 'queued', attempts: 0, lastError: null, nextAttemptAt: 0 });
    expect(items[0].attempts).toBe(4);
  });

  test('blocks replace/remove and processing while a student still has open uploads', () => {
    const items = [
      { id: 'q1', testId: 't1', testStudentId: 'ts1', status: 'queued' },
      { id: 'q2', testId: 't1', testStudentId: 'ts2', status: 'failed' },
    ];
    expect(studentHasBlockingUploads(items, 'ts1')).toBe(true);
    expect(queueBlocksProcessing(items, 't1')).toBe(true);
    expect(queueBlocksProcessing(items, 't2')).toBe(false);
    expect(hasActiveUploads(items)).toBe(true);
    expect(countsForStudent(items, 'ts2')).toEqual({ queuedCount: 0, uploadingCount: 0, failedCount: 1 });
    expect(dropBlockingItemsForStudent(items, 'ts1')).toEqual([items[1]]);
    expect(retryFailedItems(items)[1]).toMatchObject({ id: 'q2', status: 'queued' });
    expect(ACTIVE_QUEUE_STATUSES).toContain('failed');
    expect(nextAttemptAt(1, 1000)).toBe(2000);
    expect(replaceGroupItems([{ replaceGroupId: 'g1' }, { replaceGroupId: 'g2' }], 'g1')).toHaveLength(1);
    expect(nextDrainAt([{ status: 'queued', nextAttemptAt: 5000 }], 1000)).toBe(5000);
  });

  test('replace groups commit only when every page has a remote id', () => {
    const items = [
      { replaceGroupId: 'g1', status: 'uploaded', remoteAssetId: 'a1' },
      { replaceGroupId: 'g1', status: 'queued', remoteAssetId: null },
    ];
    expect(replaceGroupReady(items, 'g1')).toBe(false);
    items[1] = { replaceGroupId: 'g1', status: 'uploaded', remoteAssetId: 'a2' };
    expect(replaceGroupReady(items, 'g1')).toBe(true);
    expect(pickPendingReplaceGroupId(items)).toBe('g1');
    expect(summarizeQueue(items)).toEqual({ queued: 0, uploading: 0, failed: 0, locked: 0 });
  });

  test('reclaims uploading rows that exceeded the stuck budget', () => {
    const now = 200_000;
    expect(reclaimStuckUploads([
      { id: 'fresh', status: 'uploading', uploadingStartedAt: now - 1_000 },
      { id: 'stuck', status: 'uploading', uploadingStartedAt: now - UPLOAD_STUCK_MS - 1 },
      { id: 'queued', status: 'queued', nextAttemptAt: 9 },
    ], now)).toEqual([
      expect.objectContaining({ id: 'fresh', status: 'uploading' }),
      expect.objectContaining({ id: 'stuck', status: 'queued', nextAttemptAt: 0 }),
      expect.objectContaining({ id: 'queued', status: 'queued' }),
    ]);
  });

  test('reconcile drops missing-file ghosts and satisfied server counts', () => {
    const items = [
      { id: 'a', testStudentId: 's1', uri: 'file://gone.jpg', status: 'failed', expectedPageCount: 10 },
      { id: 'b', testStudentId: 's1', uri: 'file://keep.jpg', status: 'queued', expectedPageCount: 12 },
      { id: 'c', testStudentId: 's2', uri: 'file://done.jpg', status: 'failed', expectedPageCount: 7 },
      { id: 'd', testStudentId: 's3', uri: 'file://replace.jpg', status: 'failed', replaceGroupId: 'g1', expectedPageCount: null },
    ];
    expect(reconcileUploadQueue(items, {
      missingUris: ['file://gone.jpg'],
      uploadedCounts: { s2: 7 },
    }).map((item) => item.id)).toEqual(['b', 'd']);
  });

  test('claims stamp uploadingStartedAt for stuck detection', () => {
    const { claimed } = claimNextQueueItems([
      { id: 'a', testStudentId: 'ts1', status: 'queued', createdAt: 1, nextAttemptAt: 0 },
    ], 1, 42);
    expect(claimed[0].uploadingStartedAt).toBe(42);
  });

  test('upload filenames carry the durable per-student page number, not the batch index', () => {
    // A second batch for a student who already has pages 1-3 on the server.
    const pages = [
      { uri: 'file:///doc/intake-outbox/t1/ts1/1700000000000-4.jpg', byteSize: 10 },
      { uri: 'file:///doc/intake-outbox/t1/ts1/1700000000000-5.jpg', byteSize: 10 },
    ];
    const items = buildScanQueueItems({ testId: 't1', student, pages, uploadedCount: 3, now: 2000 });
    expect(items.map((item) => item.filename)).toEqual(['Asha-page-2000-4.jpg', 'Asha-page-2000-5.jpg']);
    // Without a page number in the path, numbering continues after the uploaded count.
    const bare = buildScanQueueItems({ testId: 't1', student, pages: [{ uri: 'file://x.jpg' }], uploadedCount: 3, now: 2000 });
    expect(bare[0].filename).toBe('Asha-page-2000-4.jpg');
    const replaced = buildScanQueueItems({ testId: 't1', student, pages: [{ uri: 'file://x.jpg' }], replaceExisting: true, uploadedCount: 3, now: 2000 });
    expect(replaced[0].filename).toBe('Asha-page-2000-1.jpg');
    expect(queuePageNumber({ pageNumber: 7, uri: 'file://1-2.jpg' })).toBe(7);
  });

  test('new filenames sort after pages uploaded with the old per-batch naming', () => {
    // Mirrors apps/processing-worker/ocrText.js answerSheetPageNumber.
    const workerPageNumber = (key) => {
      const match = /(?:^|[-_/])(\d{1,3})\.[a-z0-9]+$/i.exec(String(key || ''));
      return match ? Number(match[1]) : Infinity;
    };
    const oldBatch = ['Asha-page-1000-1.jpg', 'Asha-page-1000-2.jpg', 'Asha-page-1000-3.jpg'];
    const newBatch = buildScanQueueItems({
      testId: 't1',
      student,
      pages: [{ uri: 'file:///doc/intake-outbox/t1/ts1/9-4.jpg' }, { uri: 'file:///doc/intake-outbox/t1/ts1/9-5.jpg' }],
      uploadedCount: 3,
      now: 5000,
    }).map((item) => item.filename);
    const sorted = [...newBatch, ...oldBatch].sort((a, b) => workerPageNumber(a) - workerPageNumber(b));
    expect(sorted).toEqual([...oldBatch, ...newBatch]);
  });

  test('a file can only be queued once', () => {
    const existing = [{ id: 'a', uri: 'file://1.jpg', status: 'failed' }];
    const next = appendQueueItems(existing, [
      { id: 'b', uri: 'file://1.jpg', status: 'queued' },
      { id: 'c', uri: 'file://2.jpg', status: 'queued' },
      { id: 'd', uri: 'file://2.jpg', status: 'queued' },
    ]);
    expect(next.map((item) => item.id)).toEqual(['a', 'c']);
    expect(appendQueueItems(existing, [{ id: 'b', uri: 'file://1.jpg' }])).toBe(existing);
  });

  test('claims stamp a unique attempt id', () => {
    const { claimed } = claimNextQueueItems([
      { id: 'a', testId: 't1', testStudentId: 'ts1', status: 'queued', createdAt: 1, nextAttemptAt: 0 },
      { id: 'b', testId: 't1', testStudentId: 'ts1', status: 'queued', createdAt: 2, nextAttemptAt: 0 },
    ], 2, 42);
    expect(claimed[0].attemptId).toBeTruthy();
    expect(claimed[0].attemptId).not.toBe(claimed[1].attemptId);
  });

  test('with live-attempt tracking, orphans are requeued at once and live attempts only past the backstop', () => {
    const now = 1_000_000;
    const items = [
      { id: 'orphan', status: 'uploading', uploadingStartedAt: now - 1000, attemptId: 'x' },
      { id: 'live', status: 'uploading', uploadingStartedAt: now - 1000, attemptId: 'y' },
      { id: 'hung', status: 'uploading', uploadingStartedAt: now - UPLOAD_STUCK_MS - 1, attemptId: 'z' },
    ];
    const next = reclaimStuckUploads(items, now, new Set(['live', 'hung']));
    expect(next.map((item) => item.status)).toEqual(['queued', 'uploading', 'queued']);
    expect(next[0].attemptId).toBeNull();
    expect(next[2].attemptId).toBeNull();
  });

  test('locked tests keep their pages as locked rows instead of dropping them', () => {
    const items = [
      { id: 'a', testId: 't1', uri: 'file:///doc/intake-outbox/t1/s1/1-1.jpg', status: 'queued', remoteAssetId: 'r1', attemptId: 'x' },
      { id: 'b', testId: 't1', uri: 'file:///doc/intake-outbox/t1/s1/1-2.jpg', status: 'uploading', attemptId: 'y' },
      { id: 'c', testId: 't2', uri: 'file:///doc/intake-outbox/t2/s1/1-1.jpg', status: 'queued' },
      { id: 'd', testId: 't1', uri: 'file:///doc/r.jpg', status: 'uploaded', replaceGroupId: 'g', remoteAssetId: 'r9' },
    ];
    const locked = lockItemsForTests(items, ['t1'], { a: 'file:///doc/intake-quarantine/t1/s1/1-1.jpg' }, new Set(['a']));
    expect(locked.map((item) => item.status)).toEqual([LOCKED_QUEUE_STATUS, 'uploading', 'queued', 'uploaded']);
    expect(locked[0]).toMatchObject({ uri: 'file:///doc/intake-quarantine/t1/s1/1-1.jpg', remoteAssetId: null, attemptId: null });
    expect(lockItemsForTests(items, ['t1']).filter((item) => item.status === LOCKED_QUEUE_STATUS)).toHaveLength(2);
    expect(lockItemsForTests(items, [])).toBe(items);

    const groups = lockedPagesByTest(locked);
    expect(groups).toEqual([expect.objectContaining({ testId: 't1', count: 1 })]);
    expect(lockedBannerText(2)).toBe('2 pages not sent — this test was locked for processing. Ask an admin to reopen it, then Retry.');
    expect(summarizeQueue(locked, 't1').locked).toBe(1);

    // Locked rows are not auto-uploaded and survive a restart.
    expect(pickNextQueueItem(locked.filter((item) => item.testId === 't1'))).toBeNull();
    expect(normalizePersistedQueue(locked.map((item) => ({ ...item, testStudentId: 's1' }))).map((item) => item.id)).toContain('a');
    // Reconcile never drops a locked row, even if its file check failed.
    expect(reconcileUploadQueue(locked, { missingUris: [locked[0].uri] }).map((item) => item.id)).toContain('a');

    const unlocked = unlockItemsForTest(locked, 't1', { a: 'file:///doc/intake-outbox/t1/s1/1-1.jpg' });
    expect(unlocked[0]).toMatchObject({ status: 'queued', attempts: 0, uri: 'file:///doc/intake-outbox/t1/s1/1-1.jpg' });
  });

  test('failed and locked pages can be discarded; unsent counts include both', () => {
    const items = [
      { id: 'a', testId: 't1', status: 'failed', permanent: true },
      { id: 'b', testId: 't1', status: LOCKED_QUEUE_STATUS },
      { id: 'c', testId: 't1', status: 'queued' },
      { id: 'd', testId: 't2', status: 'failed' },
      { id: 'e', testId: 't1', status: 'uploaded', replaceGroupId: 'g' },
    ];
    expect(discardableItems(items, 't1').map((item) => item.id)).toEqual(['a', 'b']);
    expect(unsentLocalPageCount(items)).toBe(4);
    expect(unsentLocalPageCount(items, 't1')).toBe(3);
    expect(retryFailedItems(items, 't1')[0]).toMatchObject({ status: 'queued', permanent: false });
  });
});
