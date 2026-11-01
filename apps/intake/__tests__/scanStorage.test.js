import { moveScanFile, parseScanPath, relocateScanUri, scanAreaRoot, scanFolder } from '../src/scanStorage';

function fakeFs(files = []) {
  const present = new Set(files);
  return {
    present,
    getInfoAsync: jest.fn(async (uri) => ({ exists: present.has(uri) })),
    makeDirectoryAsync: jest.fn(async () => {}),
    moveAsync: jest.fn(async ({ from, to }) => { present.delete(from); present.add(to); }),
    copyAsync: jest.fn(async ({ to }) => { present.add(to); }),
    deleteAsync: jest.fn(async (uri) => { present.delete(uri); }),
  };
}

describe('scanStorage', () => {
  test('builds area folders', () => {
    expect(scanAreaRoot('file:///doc/', 'outbox')).toBe('file:///doc/intake-outbox/');
    expect(scanFolder('file:///doc/', 'review', 't1', 's1')).toBe('file:///doc/intake-review/t1/s1/');
    expect(scanFolder('file:///doc/', 'quarantine', 't1', 's1')).toBe('file:///doc/intake-quarantine/t1/s1/');
    expect(scanFolder('file:///doc/', 'outbox', '', 's1')).toBeNull();
  });

  test('parses every area and relocates by area', () => {
    expect(parseScanPath('file:///doc/intake-review/t1/s1/9-3.jpg')).toMatchObject({ area: 'review', testId: 't1', testStudentId: 's1', filename: '9-3.jpg' });
    expect(parseScanPath('file:///doc/intake/t1/s1/9-3.jpg')).toMatchObject({ area: 'legacy' });
    expect(parseScanPath('file:///doc/intake/t1/references/q.jpg')).toBeNull();
    expect(relocateScanUri('file:///doc/intake-review/t1/s1/9-3.jpg', 'outbox')).toBe('file:///doc/intake-outbox/t1/s1/9-3.jpg');
    expect(relocateScanUri('file:///doc/intake/t1/s1/9-3.jpg', 'quarantine')).toBe('file:///doc/intake-quarantine/t1/s1/9-3.jpg');
  });

  test('moves are idempotent across a crash between move and bookkeeping', async () => {
    const from = 'file:///doc/intake-review/t1/s1/9-3.jpg';
    const to = 'file:///doc/intake-outbox/t1/s1/9-3.jpg';
    const fs = fakeFs([from]);
    await expect(moveScanFile(fs, from, 'outbox')).resolves.toBe(to);
    expect(fs.present.has(from)).toBe(false);
    // Second confirm after a restart: the source is gone, the destination is there.
    await expect(moveScanFile(fs, from, 'outbox')).resolves.toBe(to);
    // Neither exists: report the page as missing.
    await expect(moveScanFile(fakeFs([]), from, 'outbox')).resolves.toBeNull();
  });

  test('falls back to copy + delete when rename is refused', async () => {
    const from = 'file:///doc/intake-outbox/t1/s1/9-3.jpg';
    const fs = fakeFs([from]);
    fs.moveAsync.mockRejectedValueOnce(new Error('EXDEV'));
    await expect(moveScanFile(fs, from, 'quarantine')).resolves.toBe('file:///doc/intake-quarantine/t1/s1/9-3.jpg');
    expect(fs.copyAsync).toHaveBeenCalled();
    expect(fs.present.has(from)).toBe(false);
  });
});
