import { PRODUCTION_API_ORIGIN, resolveApiOrigin } from '../src/runtimeConfig';

describe('intake runtime configuration', () => {
  test('defaults a release bundle to the production API', () => {
    expect(resolveApiOrigin('')).toBe(PRODUCTION_API_ORIGIN);
  });

  test('rejects emulator, localhost, insecure, and malformed API origins', () => {
    for (const origin of ['http://10.0.2.2:5173', 'http://localhost:5173', 'http://127.0.0.1:5173', 'http://example.com', 'not-a-url']) {
      expect(resolveApiOrigin(origin)).toBe(PRODUCTION_API_ORIGIN);
    }
  });

  test('accepts an explicit HTTPS API origin', () => {
    expect(resolveApiOrigin('https://staging.skyllai.com/path')).toBe('https://staging.skyllai.com');
  });
});
