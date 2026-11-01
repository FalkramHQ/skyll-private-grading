// Auth-token storage extracted from App.js for maintainability.
// The token lives in SecureStore (Android Keystore backed) for encryption,
// but on many budget Android OEM ROMs the Keystore is reset when the OS
// kills the app under memory pressure — exactly what happens when the
// native document scanner opens on a low-RAM device. A resilient
// AsyncStorage copy (file-backed, no Keystore dependency) serves as a
// fallback so a lost Keystore entry does not sign the user out.

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

const TOKEN_KEY = 'skyll_access_token';
const TOKEN_FALLBACK_KEY = 'skyll_access_token_fallback';
const USER_KEY = 'skyll_cached_user';

// Bumped on every sign-in, sign-out, and session-restore attempt. A slow
// background session validation captures the value it started with and
// aborts if it changed — so a stale validation can never re-apply its
// result (e.g. overwrite a newer user's token) after the user signed out
// or switched.
let sessionGeneration = 0;

export function getSessionGeneration() { return sessionGeneration; }
export function bumpSessionGeneration() { sessionGeneration += 1; return sessionGeneration; }

export function isValidUser(parsed) {
  return parsed && typeof parsed === 'object' && typeof parsed.username === 'string' && parsed.username && ['student', 'scanner', 'admin'].includes(parsed.role);
}

// A valid-but-expired session comes back as HTTP 200 with `user: null`. A
// thrown error (dropped connection, or a brief 4xx/5xx from the database)
// only means "could not verify right now", not "session is invalid". Retry a
// few times so a momentary hiccup does not sign the scanner out.
export async function fetchSessionWithRetry(api, token, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await api('/api/auth/session', {}, token);
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
  throw lastError;
}

export async function readStoredToken() {
  try {
    const secure = await SecureStore.getItemAsync(TOKEN_KEY);
    if (secure) return secure;
  } catch { /* Keystore unavailable on this device — use the fallback below. */ }
  try {
    return await AsyncStorage.getItem(TOKEN_FALLBACK_KEY);
  } catch {
    return null;
  }
}

export async function writeStoredToken(token, user = null) {
  try { await AsyncStorage.setItem(TOKEN_FALLBACK_KEY, token); } catch { /* best effort */ }
  try { await SecureStore.setItemAsync(TOKEN_KEY, token); } catch { /* best effort */ }
  if (user) {
    try { await AsyncStorage.setItem(USER_KEY, JSON.stringify(user)); } catch { /* best effort */ }
  }
}

// The cached user JSON powers the optimistic session restore: the app can
// paint the signed-in home screen straight from disk before the session
// endpoint confirms the token is still valid.
export async function readStoredUser() {
  try {
    const raw = await AsyncStorage.getItem(USER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isValidUser(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function clearStoredToken() {
  try { await AsyncStorage.removeItem(TOKEN_FALLBACK_KEY); } catch { /* best effort */ }
  try { await SecureStore.deleteItemAsync(TOKEN_KEY); } catch { /* best effort */ }
  try { await AsyncStorage.removeItem(USER_KEY); } catch { /* best effort */ }
}
