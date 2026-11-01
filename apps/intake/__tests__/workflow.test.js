import {
  canQueueProcessing,
  processingBlockReason,
  MAX_TEST_TITLE_LENGTH,
  mobileRoleCapabilities,
  draftKey,
  workspaceKey,
  isResumableDraft,
  normalizeDraft,
  normalizeWorkspace,
  parseStoredWorkspace,
  resumeEditorTestId,
  pendingScanForOpenedTest,
  singleActiveQueueTestId,
  normalizeExamDate,
  normalizeExamType,
  normalizeUploadAssets,
  scanQualityWarnings,
  mobileAnswerSheetPath,
  canSubmitRecheck,
  normalizeRecheckReason,
  RECHECK_REASON_MIN,
  RECHECK_REASON_MAX,
  removeUploadedAnswerSheets,
  studentPageCounterKey,
  extractPageNumberFromFilename,
  calculateNextPageNumber,
  filterStudentsByName,
  buildCalendarWeeks,
} from '../src/workflow';

describe('intake workflow', () => {
  test('keeps scanner accounts limited to existing-test answer-sheet uploads', () => {
    expect(mobileRoleCapabilities('scanner')).toMatchObject({
      canUseMobileApp: true,
      canScanExistingTests: true,
      canCreateTests: false,
      canManageReferenceFiles: false,
      canDeleteTests: false,
      canQueueProcessing: false,
      canViewClassInsights: false,
      canViewDeviceStatus: false,
    });
  });

  test('keeps school admins on the full intake and dashboard surface', () => {
    expect(mobileRoleCapabilities('admin')).toMatchObject({
      canUseMobileApp: true,
      canScanExistingTests: true,
      canCreateTests: true,
      canManageReferenceFiles: true,
      canDeleteTests: true,
      canQueueProcessing: true,
      canViewClassInsights: true,
      canViewDeviceStatus: true,
    });
  });

  test('does not allow unsupported roles into the mobile app', () => {
    expect(mobileRoleCapabilities('reviewer').canUseMobileApp).toBe(false);
  });

  test('grants rename only to test-management roles (admin and skyll_admin)', () => {
    expect(mobileRoleCapabilities('admin').canRenameTests).toBe(true);
    expect(mobileRoleCapabilities('skyll_admin').canRenameTests).toBe(true);
    expect(mobileRoleCapabilities('scanner').canRenameTests).toBe(false);
    expect(mobileRoleCapabilities('student').canRenameTests).toBe(false);
    expect(mobileRoleCapabilities('reviewer').canRenameTests).toBe(false);
  });

  test('caps test titles on the client at the same limit the API enforces', () => {
    expect(MAX_TEST_TITLE_LENGTH).toBe(120);
  });

  test('keeps drafts separate by signed-in administrator', () => {
    expect(draftKey({ username: 'partnerb_admin' })).toBe('skyll:intake:draft:v1:partnerb_admin');
    expect(draftKey({ id: 'admin_2' })).toBe('skyll:intake:draft:v1:admin_2');
    expect(draftKey()).toBe('skyll:intake:draft:v1:admin');
  });

  test('turns interrupted uploads into explicit retryable failures on restore', () => {
    const draft = normalizeDraft({
      title: 'Weekly chemistry',
      assets: [{ id: 'a1', status: 'uploading', kind: 'answer_sheet' }],
      test: { id: 'test_1' },
    });
    expect(draft.assets[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/interrupted/i) });
    expect(isResumableDraft(draft)).toBe(true);
  });

  test('turns stale loaded uploads into discardable failures', () => {
    expect(normalizeUploadAssets([
      { id: 'a1', status: 'uploading', kind: 'question_paper' },
      { id: 'a2', status: 'registered', kind: 'answer_sheet' },
      { id: 'a3', status: 'uploaded', kind: 'answer_key' },
    ])).toEqual([
      { id: 'a1', status: 'failed', kind: 'question_paper', error: 'Upload interrupted. Tap retry or discard to continue.' },
      { id: 'a2', status: 'failed', kind: 'answer_sheet', error: 'Upload interrupted. Tap retry or discard to continue.' },
      { id: 'a3', status: 'uploaded', kind: 'answer_key' },
    ]);
  });

  test('restores a safe empty draft when persisted state is incomplete or malformed', () => {
    const draft = normalizeDraft({
      title: null,
      subject: '',
      selectedBatchIds: 'batch_1',
      assets: [null, 'not-an-asset', { id: 'complete', status: 'uploaded' }],
      job: 'not-a-job',
    });
    expect(draft).toMatchObject({
      title: '',
      subject: 'Chemistry',
      selectedBatchIds: [],
      job: 'not-a-job',
      pendingScan: null,
    });
    expect(draft.assets).toEqual([{ id: 'complete', status: 'uploaded' }]);
    expect(isResumableDraft(draft)).toBe(false);
  });

  test('reopens the editor after a scanner remount when that test was still open', () => {
    expect(workspaceKey({ username: 'partnere' })).toBe('skyll:intake:workspace:v1:partnere');
    expect(normalizeWorkspace('{"screen":"editor","testId":"test_12phys"}')).toEqual({
      screen: 'editor',
      testId: 'test_12phys',
    });
    expect(resumeEditorTestId({
      workspace: { screen: 'editor', testId: 'test_12phys' },
      draft: { test: { id: 'test_old' } },
    })).toBe('test_12phys');
    expect(resumeEditorTestId({
      workspace: { screen: 'home', testId: '' },
      draft: { test: { id: 'test_12phys' }, pendingScan: { student: { testStudentId: 's1' } } },
    })).toBe('test_12phys');
    expect(resumeEditorTestId({
      workspace: { screen: 'home', testId: '' },
      draft: { test: { id: 'test_12phys' } },
    })).toBe('');
    expect(parseStoredWorkspace(null)).toBeNull();
    expect(singleActiveQueueTestId([
      { status: 'failed', testId: 'test_12phys' },
      { status: 'failed', testId: 'test_12phys' },
    ])).toBe('test_12phys');
    expect(resumeEditorTestId({
      workspace: null,
      draft: { test: { id: 'test_old' } },
      queueTestId: 'test_12phys',
    })).toBe('test_12phys');
    expect(resumeEditorTestId({
      workspace: { screen: 'home', testId: '' },
      queueTestId: 'test_12phys',
    })).toBe('');
  });

  test('keeps an in-review scan only when that student still belongs to the opened test', () => {
    const pending = { student: { testStudentId: 's1', name: 'Aarzu' }, pages: [{ uri: 'file://a.jpg' }] };
    expect(pendingScanForOpenedTest(pending, ['s1', 's2'])).toBe(pending);
    expect(pendingScanForOpenedTest(pending, ['s2'])).toBeNull();
    expect(pendingScanForOpenedTest(null, ['s1'])).toBeNull();
  });

  test('does not overwrite a useful failure reason while restoring a draft', () => {
    const draft = normalizeDraft({
      assets: [{ id: 'a1', status: 'failed', error: 'Storage upload failed' }],
    });
    expect(draft.assets[0]).toMatchObject({ status: 'failed', error: 'Storage upload failed' });
  });

  test('only queues when both references and a student answer sheet are uploaded', () => {
    const references = [
      { kind: 'question_paper', status: 'uploaded' },
      { kind: 'answer_key', status: 'uploaded' },
    ];
    expect(canQueueProcessing(references)).toBe(false);
    expect(canQueueProcessing([...references, { kind: 'answer_sheet', status: 'uploaded', testStudentId: 'student_1' }])).toBe(true);
  });

  test('does not queue processing while answer-sheet uploads are still in flight', () => {
    const references = [
      { kind: 'question_paper', status: 'uploaded' },
      { kind: 'answer_key', status: 'uploaded' },
      { kind: 'answer_sheet', status: 'uploaded', testStudentId: 'student_1' },
    ];
    expect(canQueueProcessing(references, [{ status: 'queued', testId: 't1' }])).toBe(false);
    expect(canQueueProcessing(references, [])).toBe(true);
  });

  test('does not let leftover failed queue rows block processing when enough pages already uploaded', () => {
    const assets = [
      { kind: 'question_paper', status: 'uploaded' },
      { kind: 'answer_key', status: 'uploaded' },
      { kind: 'answer_sheet', status: 'uploaded', testStudentId: 'student_1' },
      { kind: 'answer_sheet', status: 'uploaded', testStudentId: 'student_1' },
    ];
    const failed = [{ status: 'failed', testStudentId: 'student_1', expectedPageCount: 2 }];
    expect(processingBlockReason(assets, failed)).toBe('');
    expect(canQueueProcessing(assets, failed)).toBe(true);
    expect(processingBlockReason(assets, [{ status: 'failed', testStudentId: 'student_1', expectedPageCount: 3 }])).toMatch(/failed/i);
  });

  test('never queues on failed assets, unassigned sheets, or malformed asset entries', () => {
    const references = [
      { kind: 'question_paper', status: 'uploaded' },
      { kind: 'answer_key', status: 'uploaded' },
    ];
    expect(canQueueProcessing([...references, { kind: 'answer_sheet', status: 'failed', testStudentId: 'student_1' }])).toBe(false);
    expect(canQueueProcessing([...references, { kind: 'answer_sheet', status: 'uploaded', testStudentId: '   ' }])).toBe(false);
    expect(canQueueProcessing([null, 'bad-data', ...references, { kind: 'answer_sheet', status: 'uploaded', testStudentId: 'student_1' }])).toBe(true);
  });

  test('removes every scan-history row for only the selected student from local intake state', () => {
    const assets = [
      { id: 'answer_1', kind: 'answer_sheet', status: 'uploaded', testStudentId: 'student_1' },
      { id: 'answer_2', kind: 'answer_sheet', status: 'uploaded', testStudentId: 'student_2' },
      { id: 'old_answer', kind: 'answer_sheet', status: 'superseded', testStudentId: 'student_1' },
      { id: 'key_1', kind: 'answer_key', status: 'uploaded' },
    ];

    expect(removeUploadedAnswerSheets(assets, 'student_1')).toEqual([
      assets[1],
      assets[3],
    ]);
  });

  test('filters the scanning roster by student name without case sensitivity', () => {
    const students = [{ name: 'Asha Rao' }, { name: 'Kabir Singh' }, { name: 'Meera Shah' }];

    expect(filterStudentsByName(students, '  SHa  ')).toEqual([students[0], students[2]]);
    expect(filterStudentsByName(students, '')).toBe(students);
    expect(filterStudentsByName(students, 'missing')).toEqual([]);
    expect(filterStudentsByName(null, 'asha')).toEqual([]);
    expect(filterStudentsByName(null, '')).toEqual([]);
  });

  test('does not flag a legible high-resolution page just because device OCR found little text', () => {
    expect(scanQualityWarnings({ width: 2400, height: 1600, byteSize: 500000, readableCharacters: 0, ocrConfidence: 0.1 })).toEqual([]);
    expect(scanQualityWarnings({ width: 800, height: 600, byteSize: 90000, readableCharacters: 20, ocrConfidence: 0.9 }))
      .toEqual(expect.arrayContaining([
        'Low resolution. Retake this page if handwriting is not crisp.',
        'Very little image detail was captured. Check for blur, glare, or an incomplete page.',
      ]));
  });

  test('allows a high-quality handwritten page without false warnings', () => {
    expect(scanQualityWarnings({
      width: 2480,
      height: 3508,
      byteSize: 900000,
      readableCharacters: 180,
      ocrConfidence: 0.92,
    })).toEqual([]);
  });

  test('does not flag a 1181px short edge as low resolution', () => {
    expect(scanQualityWarnings({ width: 1181, height: 1607, byteSize: 700000, readableCharacters: 0, ocrConfidence: 0 })).toEqual([]);
  });

  test('treats missing or non-numeric scanner metadata as a review signal, never a crash', () => {
    expect(scanQualityWarnings({ width: 'unknown', height: null, byteSize: 'n/a', readableCharacters: undefined, ocrConfidence: 'bad' }))
      .toEqual(['Could not verify image dimensions. Inspect this page before upload.']);
  });

  test('uses the same protected answer-sheet contract as the web report', () => {
    expect(mobileAnswerSheetPath({ subject: 'Chemistry', student: 'student one' }))
      .toBe('/api/student-answer-sheet?subject=Chemistry&student=student+one');
  });

  test('only permits complete, non-spam recheck requests', () => {
    const request = { submissionId: 'submission_1', subject: 'Chemistry', questionNumber: 'Q4', reason: 'The marked answer has been corrected in my working.' };
    expect(canSubmitRecheck(request)).toBe(true);
    expect(canSubmitRecheck({ ...request, reason: '12345678901' })).toBe(false);
    expect(canSubmitRecheck({ ...request, reason: '123456789012' })).toBe(true);
    expect(canSubmitRecheck({ ...request, reason: 'x'.repeat(800) })).toBe(true);
    expect(canSubmitRecheck({ ...request, reason: 'x'.repeat(801) })).toBe(false);
    expect(canSubmitRecheck({ ...request, submissionId: '' })).toBe(false);
  });

  test('normalizes a recheck reason exactly like the API before measuring it', () => {
    expect(RECHECK_REASON_MIN).toBe(12);
    expect(RECHECK_REASON_MAX).toBe(800);
    expect(normalizeRecheckReason('  fix   this\tmarking \n ')).toBe('fix this marking');
    const base = { submissionId: 'submission_1', subject: 'Chemistry', questionNumber: 'Q4' };
    // 13 raw chars but only 9 once whitespace collapses — rejected like the server.
    expect(canSubmitRecheck({ ...base, reason: 'a  b  c  d  e' })).toBe(false);
    // Padding that collapses to at least the minimum is accepted.
    expect(canSubmitRecheck({ ...base, reason: 'recheck   this  mark' })).toBe(true);
  });

  test('normalizeExamDate accepts valid YYYY-MM-DD and rejects everything else', () => {
    expect(normalizeExamDate('2026-08-06')).toBe('2026-08-06');
    expect(normalizeExamDate('  2026-01-15  ')).toBe('2026-01-15');
    expect(normalizeExamDate('06-08-2026')).toBe('');
    expect(normalizeExamDate('2026/08/06')).toBe('');
    expect(normalizeExamDate('')).toBe('');
    expect(normalizeExamDate(null)).toBe('');
    expect(normalizeExamDate(undefined)).toBe('');
  });

  test('normalizeExamType returns the value when valid, defaults to subjective', () => {
    expect(normalizeExamType('mcq')).toBe('mcq');
    expect(normalizeExamType('subjective')).toBe('subjective');
    expect(normalizeExamType('mixed')).toBe('mixed');
    expect(normalizeExamType('invalid')).toBe('subjective');
    expect(normalizeExamType('')).toBe('subjective');
    expect(normalizeExamType(null)).toBe('subjective');
    expect(normalizeExamType(undefined)).toBe('subjective');
  });

  test('normalizeDraft round-trips examDate and examType from a saved draft', () => {
    const draft = normalizeDraft({
      title: 'Unit test 3',
      subject: 'Physics',
      examDate: '2026-07-20',
      examType: 'mcq',
      selectedBatchIds: ['batch_1'],
    });
    expect(draft).toMatchObject({ examDate: '2026-07-20', examType: 'mcq' });

    const fallback = normalizeDraft({ examDate: 'garbage', examType: 'nope' });
    expect(fallback.examDate).toBe('');
    expect(fallback.examType).toBe('subjective');
  });

  describe('page counter logic', () => {
    test('studentPageCounterKey generates correct key format', () => {
      expect(studentPageCounterKey('test_100', 'student_200')).toBe('@page_counter_test_100_student_200');
    });

    test('extractPageNumberFromFilename extracts trailing page number cleanly', () => {
      expect(extractPageNumberFromFilename('Student-page-12345678-1.jpg')).toBe(1);
      expect(extractPageNumberFromFilename('/cache/intake/test1/student2/172300000-5.jpg')).toBe(5);
      expect(extractPageNumberFromFilename('reference.pdf')).toBe(0);
      expect(extractPageNumberFromFilename('invalid-file.png')).toBe(0);
      expect(extractPageNumberFromFilename('')).toBe(0);
      expect(extractPageNumberFromFilename(null)).toBe(0);
    });

    test('calculateNextPageNumber defaults to 1 for empty state', () => {
      expect(calculateNextPageNumber({ testStudentId: 's1' })).toBe(1);
    });

    test('calculateNextPageNumber increments from storedCounter', () => {
      expect(calculateNextPageNumber({ storedCounter: 3, testStudentId: 's1' })).toBe(4);
    });

    test('calculateNextPageNumber increments from existing assets when storage is empty', () => {
      const assets = [
        { kind: 'answer_sheet', testStudentId: 's1', status: 'uploaded', label: 'Student-page-100-1.jpg' },
        { kind: 'answer_sheet', testStudentId: 's1', status: 'uploaded', label: 'Student-page-100-3.jpg' },
        { kind: 'answer_sheet', testStudentId: 's2', status: 'uploaded', label: 'Other-page-100-10.jpg' },
        { kind: 'answer_sheet', testStudentId: 's1', status: 'superseded', label: 'Student-page-100-99.jpg' },
      ];
      expect(calculateNextPageNumber({ assets, testStudentId: 's1' })).toBe(4);
    });

    test('calculateNextPageNumber resets to 1 when reset is true AND existingPages is empty', () => {
      expect(calculateNextPageNumber({ storedCounter: 5, reset: true, existingPages: [], testStudentId: 's1' })).toBe(1);
    });

    test('calculateNextPageNumber does NOT reset when reset is true BUT existingPages is non-empty (in-progress replace)', () => {
      const existingPages = [
        { uri: 'file:///cache/1000-1.jpg' },
        { uri: 'file:///cache/1001-2.jpg' },
        { uri: 'file:///cache/1002-3.jpg' },
      ];
      expect(calculateNextPageNumber({ storedCounter: 3, reset: true, existingPages, testStudentId: 's1' })).toBe(4);
    });

    test('calculateNextPageNumber handles NaN / corrupted storage gracefully', () => {
      expect(calculateNextPageNumber({ storedCounter: 'invalid', testStudentId: 's1' })).toBe(1);
      expect(calculateNextPageNumber({ storedCounter: NaN, testStudentId: 's1' })).toBe(1);
    });
  });

  describe('buildCalendarWeeks', () => {
    test('chunks days into exactly 7-day rows with Saturday in column index 6', () => {
      // August 2026: Aug 1 is Saturday (startWeekday = 6)
      const weeks = buildCalendarWeeks({ year: 2026, month: 7 }); // 0-indexed: 7 = August
      expect(weeks.length).toBeGreaterThanOrEqual(4);
      weeks.forEach((week) => {
        expect(week).toHaveLength(7);
      });

      // First week: Sunday-Friday are null, Saturday is Aug 1
      expect(weeks[0][0]).toBeNull();
      expect(weeks[0][5]).toBeNull();
      expect(weeks[0][6]).not.toBeNull();
      expect(weeks[0][6].getDate()).toBe(1);

      // Verify all Saturdays (index 6) across the month
      const saturdays = weeks.map((w) => w[6]).filter(Boolean).map((d) => d.getDate());
      expect(saturdays).toEqual([1, 8, 15, 22, 29]);
    });

    test('correctly handles a month starting on Sunday', () => {
      // February 2026: Feb 1 is Sunday (startWeekday = 0)
      const weeks = buildCalendarWeeks({ year: 2026, month: 1 }); // Feb 2026 (non-leap: 28 days)
      expect(weeks).toHaveLength(4);
      expect(weeks[0][0].getDate()).toBe(1);
      expect(weeks[3][6].getDate()).toBe(28);
      weeks.forEach((week) => {
        expect(week).toHaveLength(7);
        week.forEach((day) => expect(day).not.toBeNull());
      });
    });

    test('correctly handles leap years and month boundaries', () => {
      // February 2024: 29 days, starts on Thursday (index 4)
      const weeks = buildCalendarWeeks({ year: 2024, month: 1 });
      expect(weeks[0][0]).toBeNull();
      expect(weeks[0][3]).toBeNull();
      expect(weeks[0][4].getDate()).toBe(1); // Thursday Feb 1
      expect(weeks[0][6].getDate()).toBe(3); // Saturday Feb 3

      // Collect all non-null days in order
      const allDays = weeks.flatMap((w) => w).filter(Boolean).map((d) => d.getDate());
      expect(allDays).toHaveLength(29);
      expect(allDays[0]).toBe(1);
      expect(allDays[28]).toBe(29);
    });

    test('defaults to current month if arguments are omitted or invalid', () => {
      const weeks = buildCalendarWeeks();
      expect(weeks.length).toBeGreaterThanOrEqual(4);
      weeks.forEach((week) => expect(week).toHaveLength(7));
    });
  });
});
