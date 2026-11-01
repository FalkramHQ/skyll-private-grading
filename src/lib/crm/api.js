// CRM API client. All calls go to /api/auth/crm/<path>. Platform staff pick a
// school in the shell; that choice travels as X-Skyll-School and the server
// ignores it for everyone else.
import { useCallback, useEffect, useState } from 'react';

const SUPPORT_SCHOOL_KEY = 'skyll.crm.supportSchoolId';

export function getSupportSchoolId() {
  try { return sessionStorage.getItem(SUPPORT_SCHOOL_KEY) || ''; } catch { return ''; }
}

export function setSupportSchoolId(schoolId) {
  try {
    if (schoolId) sessionStorage.setItem(SUPPORT_SCHOOL_KEY, schoolId);
    else sessionStorage.removeItem(SUPPORT_SCHOOL_KEY);
  } catch {
    // Storage unavailable (private mode); the picker simply shows again.
  }
}

export class CrmApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'CrmApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function crmFetch(path, { method = 'GET', body, schoolId = getSupportSchoolId(), idempotencyKey } = {}) {
  const headers = { Accept: 'application/json' };
  if (schoolId) headers['X-Skyll-School'] = schoolId;
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`/api/auth/crm/${path}`, {
    method,
    credentials: 'same-origin',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new CrmApiError(response.status, data?.error?.code || 'error', data?.error?.message || 'Request failed', data?.error?.details);
  }
  return data;
}

/** GETs a file (a fee PDF) with the same headers as crmFetch and saves it in the browser. */
export async function crmDownload(path, filename, { schoolId = getSupportSchoolId() } = {}) {
  const headers = { Accept: 'application/pdf' };
  if (schoolId) headers['X-Skyll-School'] = schoolId;
  const response = await fetch(`/api/auth/crm/${path}`, { credentials: 'same-origin', headers });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new CrmApiError(response.status, data?.error?.code || 'error', data?.error?.message || 'Download failed');
  }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A fresh key per user action, so a double-click or retry is applied once. */
export function newIdempotencyKey() {
  return globalThis.crypto?.randomUUID?.() || `k${Date.now()}${Math.random().toString(36).slice(2)}`;
}

/** Loads GET /crm/me for the current school scope. */
export function useCrmMe(schoolId) {
  const [state, setState] = useState({ status: 'loading', me: null, error: null });

  const load = useCallback(async () => {
    setState({ status: 'loading', me: null, error: null });
    try {
      const me = await crmFetch('me', { schoolId });
      setState({ status: 'ready', me, error: null });
    } catch (error) {
      setState({ status: 'error', me: null, error });
    }
  }, [schoolId]);

  useEffect(() => { load(); }, [load]);

  return { ...state, reload: load };
}
