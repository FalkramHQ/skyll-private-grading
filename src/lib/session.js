import { clearSession, setSession, invalidateSessionCache } from './auth';

export async function signIn(username, password, constraints = {}) {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ username, password, ...constraints }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Unable to sign in');
  setSession(body.user);
  invalidateSessionCache();
  return body.user;
}

export async function signOut() {
  try { await fetch('/api/auth/session', { method: 'DELETE', credentials: 'same-origin' }); } finally { clearSession(); invalidateSessionCache(); }
}

export async function restoreSession() {
  const response = await fetch('/api/auth/session', { credentials: 'same-origin' });
  if (!response.ok) return null;
  const { user } = await response.json();
  if (user) setSession(user);
  return user || null;
}
