// Client helpers for CRM tasks (FLKRM-326 S2): a "tasks changed" signal so the
// nav badge and dashboard refresh after any task write, and the summary hook.
import { useCallback, useEffect, useState } from 'react';
import { crmFetch, newIdempotencyKey } from './api';

const TASKS_CHANGED = 'skyll:crm-tasks-changed';

export function notifyTasksChanged() {
  window.dispatchEvent(new Event(TASKS_CHANGED));
}

export function useTasksChanged(callback) {
  useEffect(() => {
    window.addEventListener(TASKS_CHANGED, callback);
    return () => window.removeEventListener(TASKS_CHANGED, callback);
  }, [callback]);
}

/** The current time, re-read every minute so "overdue" labels stay true on an open page. */
export function useNow(intervalMs = 60_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** GET tasks/summary, refreshed whenever tasks change or the tab regains focus. */
export function useTaskSummary(enabled) {
  const [summary, setSummary] = useState(null);
  const load = useCallback(async () => {
    if (!enabled) return;
    try {
      setSummary(await crmFetch('tasks/summary'));
    } catch {
      // The badge is a convenience; a failed refresh keeps the last value.
    }
  }, [enabled]);
  useEffect(() => { load(); }, [load]);
  useTasksChanged(load);
  useEffect(() => {
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, [load]);
  return summary;
}

/** POSTs a task write with a fresh idempotency key and announces the change. */
export async function taskWrite(path, body) {
  const result = await crmFetch(path, { method: 'POST', body, idempotencyKey: newIdempotencyKey() });
  notifyTasksChanged();
  return result;
}
