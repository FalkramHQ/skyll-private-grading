import { putFileWithTimeout } from '../src/uploadTransfer';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

describe('putFileWithTimeout', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function taskFs() {
    const pending = deferred();
    let progress;
    const task = {
      uploadAsync: jest.fn(() => pending.promise),
      cancelAsync: jest.fn(async () => { pending.resolve(null); }),
    };
    const fs = {
      FileSystemUploadType: { BINARY_CONTENT: 0 },
      createUploadTask: jest.fn((url, uri, options, callback) => { progress = callback; return task; }),
      uploadAsync: jest.fn(),
    };
    return { fs, task, pending, emit: (bytes) => progress({ totalBytesSent: bytes, totalBytesExpectedToSend: 100 }) };
  }

  test('cancels the native transfer when it stops making progress', async () => {
    const { fs, task } = taskFs();
    const result = putFileWithTimeout(fs, { url: 'https://r2/put', fileUri: 'file://a.jpg', idleTimeoutMs: 10_000, maxTimeoutMs: 600_000, checkEveryMs: 1000 });
    const assertion = expect(result).rejects.toMatchObject({ status: 408, timedOut: true });
    await jest.advanceTimersByTimeAsync(11_000);
    await assertion;
    expect(task.cancelAsync).toHaveBeenCalled();
  });

  test('keeps a slow transfer alive while bytes are still moving', async () => {
    const { fs, task, pending, emit } = taskFs();
    const result = putFileWithTimeout(fs, { url: 'u', fileUri: 'f', idleTimeoutMs: 10_000, maxTimeoutMs: 600_000, checkEveryMs: 1000 });
    for (let sent = 10; sent <= 50; sent += 10) {
      await jest.advanceTimersByTimeAsync(8000);
      emit(sent);
    }
    pending.resolve({ status: 200 });
    await expect(result).resolves.toEqual({ status: 200 });
    expect(task.cancelAsync).not.toHaveBeenCalled();
  });

  test('holds the idle clock while progress is paused (app in background)', async () => {
    const { fs, task, pending } = taskFs();
    const result = putFileWithTimeout(fs, { url: 'u', fileUri: 'f', idleTimeoutMs: 10_000, maxTimeoutMs: 600_000, checkEveryMs: 1000, isProgressPaused: () => true });
    await jest.advanceTimersByTimeAsync(30_000);
    expect(task.cancelAsync).not.toHaveBeenCalled();
    pending.resolve({ status: 200 });
    await expect(result).resolves.toEqual({ status: 200 });
  });

  test('enforces the hard ceiling even with progress', async () => {
    const { fs, task, emit } = taskFs();
    const result = putFileWithTimeout(fs, { url: 'u', fileUri: 'f', idleTimeoutMs: 10_000, maxTimeoutMs: 20_000, checkEveryMs: 1000 });
    const assertion = expect(result).rejects.toMatchObject({ status: 408 });
    for (let sent = 1; sent <= 5; sent += 1) {
      await jest.advanceTimersByTimeAsync(5000);
      emit(sent);
    }
    await assertion;
    expect(task.cancelAsync).toHaveBeenCalled();
  });

  test('falls back to uploadAsync with a timeout when the task API is missing', async () => {
    const fs = { FileSystemUploadType: { BINARY_CONTENT: 0 }, uploadAsync: jest.fn(async () => ({ status: 200 })) };
    await expect(putFileWithTimeout(fs, { url: 'u', fileUri: 'f' })).resolves.toEqual({ status: 200 });
    expect(fs.uploadAsync).toHaveBeenCalledWith('u', 'f', expect.objectContaining({ httpMethod: 'PUT' }));
  });

  test('falls back when the native module lacks the task methods', async () => {
    const fs = {
      FileSystemUploadType: { BINARY_CONTENT: 0 },
      createUploadTask: () => ({
        uploadAsync: async () => { throw Object.assign(new Error('uploadTaskStartAsync is not available'), { code: 'ERR_UNAVAILABLE' }); },
        cancelAsync: async () => {},
      }),
      uploadAsync: jest.fn(async () => ({ status: 201 })),
    };
    await expect(putFileWithTimeout(fs, { url: 'u', fileUri: 'f' })).resolves.toEqual({ status: 201 });
  });
});
