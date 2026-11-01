// Centralised auth/session helpers so logout and unauthenticated redirects
// always return the user to the correct school login portal.

import { useState, useEffect } from 'react';

const SCHOOL_LOGIN_PATHS = {
  "Partner Academy B": '/partnerb',
  'Partner Academy C': '/partnerc',
  "Partner Academy A": '/partnera',
  'Partner Academy D': '/partnerd',
  'Partner Academy E': '/partnere',
  'Partner Academy F': '/partnerf',
  'Skyll Individual': '/individual',
};

// localStorage is used only as a display cache — it is NOT a security gate.
// The actual auth check is the HttpOnly skyll_session cookie validated by the
// server via useSession() → GET /api/auth/session.
export function setSession({ username, role, school }) {
  if (username) localStorage.setItem('username', username);
  if (role) localStorage.setItem('userRole', role);
  if (school) localStorage.setItem('userSchool', school);
}

export function clearSession() {
  localStorage.removeItem('userRole');
  localStorage.removeItem('username');
  localStorage.removeItem('userSchool');
}

// ─── Server-validated session hook ───────────────────────────────────────
// Module-level cache so multiple components calling useSession() share a
// single fetch. Cleared by invalidateSessionCache() on logout.
let _sessionUser = null;
let _sessionResolved = false;
let _sessionPromise = null;
// True when the last answer came from the localStorage cache because the
// server could not answer. The next useSession() mount revalidates quietly.
let _sessionStale = false;

async function fetchSession() {
  if (_sessionPromise) return _sessionPromise;
  _sessionPromise = (async () => {
    try {
      const res = await fetch('/api/auth/session', { credentials: 'same-origin' });
      // A 4xx (or 200 with no user) means signed out. A 5xx/503 is the
      // server failing to look the session up, not a verdict on it.
      if (res.status >= 400 && res.status < 500) { clearSession(); _sessionUser = null; _sessionStale = false; return null; }
      if (!res.ok) throw new Error(`Session lookup failed (${res.status})`);
      const { user: serverUser } = await res.json();
      _sessionStale = false;
      if (serverUser) {
        setSession(serverUser);
        _sessionUser = serverUser;
        return serverUser;
      }
      clearSession();
      _sessionUser = null;
      return null;
    } catch {
      // Network or server error — fall back to localStorage cache so the app
      // doesn't lock users out during transient failures.
      _sessionStale = true;
      _sessionUser = localStorage.getItem('username')
        ? { username: localStorage.getItem('username'), role: localStorage.getItem('userRole'), school: localStorage.getItem('userSchool') }
        : null;
      return _sessionUser;
    } finally {
      _sessionResolved = true;
      _sessionPromise = null;
    }
  })();
  return _sessionPromise;
}

export function invalidateSessionCache() {
  _sessionUser = null;
  _sessionResolved = false;
  _sessionPromise = null;
  _sessionStale = false;
}

export function useSession() {
  const [user, setUser] = useState(_sessionUser);
  const [loading, setLoading] = useState(!_sessionResolved);

  useEffect(() => {
    if (_sessionResolved && !_sessionStale) return;
    let cancelled = false;
    fetchSession().then((resolvedUser) => {
      if (cancelled) return;
      setUser(resolvedUser);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  return { user, loading, isAuthenticated: !!user };
}

// Resolve the login portal for the current user. Falls back to a stored school,
// then infers from the username prefix, else the landing page.
export function loginPathForSchool(school) {
  const resolved = school || localStorage.getItem('userSchool');
  if (resolved && SCHOOL_LOGIN_PATHS[resolved]) return SCHOOL_LOGIN_PATHS[resolved];

  const username = localStorage.getItem('username') || '';
  const lower = username.toLowerCase();
  if (lower.startsWith('partnerb_') || lower.startsWith('rk')) return SCHOOL_LOGIN_PATHS["Partner Academy B"];
  return '/';
}
