export const PRODUCTION_API_ORIGIN = 'https://www.skyllai.com';

export function resolveApiOrigin(configuredOrigin = process.env.EXPO_PUBLIC_API_ORIGIN) {
  const candidate = String(configuredOrigin || '').trim();
  if (!candidate) return PRODUCTION_API_ORIGIN;

  try {
    const parsed = new URL(candidate);
    const isEmulator = parsed.hostname === '10.0.2.2' || parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    if (parsed.protocol !== 'https:' || isEmulator) return PRODUCTION_API_ORIGIN;
    return parsed.origin;
  } catch {
    return PRODUCTION_API_ORIGIN;
  }
}
