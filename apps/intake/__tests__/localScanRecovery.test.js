import {
  collectLocalScanPages,
  parseLocalScanPath,
  planLocalScanRecovery,
} from '../src/localScanRecovery';

describe('localScanRecovery', () => {
  test('parseLocalScanPath reads durable intake folders', () => {
    expect(parseLocalScanPath('file:///data/intake/test_1/ts_2/172300000-5.jpg')).toEqual({
      area: 'legacy',
      testId: 'test_1',
      testStudentId: 'ts_2',
      filename: '172300000-5.jpg',
      pageNumber: 5,
    });
    expect(parseLocalScanPath('file:///data/intake/test_1/references/q.pdf')).toBeNull();
  });

  test('collectLocalScanPages keeps only answer-sheet jpegs and sorts them', () => {
    const pages = collectLocalScanPages([
      { uri: 'file:///data/intake/t1/s2/2-2.jpg', byteSize: 20, modificationTime: 2 },
      { uri: 'file:///data/intake/t1/s2/1-1.jpg', byteSize: 10, modificationTime: 1 },
      { uri: 'file:///data/intake/t1/references/key.pdf', byteSize: 99 },
      { uri: 'file:///other/path.jpg', byteSize: 5 },
    ]);
    expect(pages.map((page) => page.uri)).toEqual([
      'file:///data/intake/t1/s2/1-1.jpg',
      'file:///data/intake/t1/s2/2-2.jpg',
    ]);
  });

  test('planLocalScanRecovery appends leftover local pages and skips queued uris', () => {
    const localPages = collectLocalScanPages([
      { uri: 'file:///data/intake/t1/s1/1-1.jpg', byteSize: 11 },
      { uri: 'file:///data/intake/t1/s1/2-2.jpg', byteSize: 22 },
      { uri: 'file:///data/intake/t1/s2/9-1.jpg', byteSize: 33 },
    ]);
    const recovered = planLocalScanRecovery({
      localPages,
      existingQueue: [{ uri: 'file:///data/intake/t1/s1/1-1.jpg', status: 'queued' }],
      uploadedCounts: { s1: 3 },
      studentNames: { s1: 'Asha', s2: 'Bala' },
      testId: 't1',
      now: 1000,
    });
    expect(recovered).toHaveLength(2);
    expect(recovered[0]).toEqual(expect.objectContaining({
      testId: 't1',
      testStudentId: 's1',
      studentName: 'Asha',
      uri: 'file:///data/intake/t1/s1/2-2.jpg',
      expectedPageCount: 4,
      status: 'queued',
    }));
    expect(recovered[1]).toEqual(expect.objectContaining({
      testStudentId: 's2',
      studentName: 'Bala',
      expectedPageCount: 1,
    }));
  });

  test('planLocalScanRecovery surfaces delivered / locked tests as locked rows, never queued', () => {
    const localPages = collectLocalScanPages([
      { uri: 'file:///data/intake/delivered/s1/1-1.jpg', byteSize: 11 },
      { uri: 'file:///data/intake/open/s1/1-1.jpg', byteSize: 22 },
    ]);
    const recovered = planLocalScanRecovery({
      localPages,
      blockedTestIds: ['delivered'],
      now: 1000,
    });
    expect(recovered).toHaveLength(2);
    expect(recovered.find((item) => item.testId === 'open').status).toBe('queued');
    expect(recovered.find((item) => item.testId === 'delivered').status).toBe('locked');
  });

  test('pages awaiting review are never recovered; outbox and legacy pages are', () => {
    const localPages = collectLocalScanPages([
      { uri: 'file:///doc/intake-review/t1/s1/5-1.jpg', byteSize: 1 },
      { uri: 'file:///doc/intake-review/t1/s1/5-2.jpg', byteSize: 1 },
      { uri: 'file:///doc/intake-outbox/t1/s2/6-1.jpg', byteSize: 1 },
      { uri: 'file:///doc/intake/t1/s3/7-4.jpg', byteSize: 1 },
    ]);
    const recovered = planLocalScanRecovery({ localPages, now: 1000 });
    expect(recovered.map((item) => item.uri)).toEqual([
      'file:///doc/intake-outbox/t1/s2/6-1.jpg',
      'file:///doc/intake/t1/s3/7-4.jpg',
    ]);
    expect(recovered.every((item) => item.status === 'queued')).toBe(true);
    // The durable page number from the file name is the upload's trailing number.
    expect(recovered[1].filename).toMatch(/-4\.jpg$/);
  });

  test('a kill during review cannot double-queue: open review pages and queued files are skipped', () => {
    const legacy = 'file:///doc/intake/t1/s1/5-1.jpg';
    const queued = 'file:///doc/intake-outbox/t1/s1/5-2.jpg';
    const localPages = collectLocalScanPages([
      { uri: legacy, byteSize: 1 },
      { uri: queued, byteSize: 1 },
    ]);
    expect(planLocalScanRecovery({
      localPages,
      existingQueue: [{ uri: queued, status: 'queued' }],
      excludeUris: [legacy],
      now: 1,
    })).toEqual([]);
  });

  test('quarantined pages come back as locked even when the test is open again', () => {
    const localPages = collectLocalScanPages([
      { uri: 'file:///doc/intake-quarantine/t1/s1/5-1.jpg', byteSize: 1 },
    ]);
    const [item] = planLocalScanRecovery({ localPages, blockedTestIds: [], now: 1 });
    expect(item).toMatchObject({ status: 'locked', testId: 't1', uri: 'file:///doc/intake-quarantine/t1/s1/5-1.jpg' });
  });

  test('only tests this account can see are recovered when the list is known', () => {
    const localPages = collectLocalScanPages([
      { uri: 'file:///doc/intake-outbox/mine/s1/5-1.jpg', byteSize: 1 },
      { uri: 'file:///doc/intake-outbox/other/s1/5-1.jpg', byteSize: 1 },
    ]);
    expect(planLocalScanRecovery({ localPages, knownTestIds: new Set(['mine']), now: 1 }).map((item) => item.testId)).toEqual(['mine']);
  });
});
