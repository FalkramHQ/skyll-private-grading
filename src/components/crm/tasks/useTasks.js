import { useCallback, useEffect, useRef, useState } from 'react';
import { crmFetch } from '../../../lib/crm/api';
import { useTasksChanged } from '../../../lib/crm/tasks';

const LIMIT = 200;

/** Loads a task list and keeps it in sync after writes anywhere in the CRM. */
export function useTasks({ view = 'mine', status = 'open', relatedType, relatedId, enabled = true }) {
  const [state, setState] = useState({ status: 'loading', tasks: [], truncated: false, error: null });
  // Latest request wins: a slow answer for an earlier filter must not replace a newer one.
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    if (!enabled) return;
    const seq = ++seqRef.current;
    const params = new URLSearchParams({ view, status, limit: String(LIMIT) });
    if (relatedType) { params.set('relatedType', relatedType); params.set('relatedId', relatedId); }
    try {
      const page = await crmFetch(`tasks?${params}`);
      if (seq !== seqRef.current) return;
      setState({ status: 'ready', tasks: page.items, truncated: Boolean(page.nextCursor), error: null });
    } catch (error) {
      if (seq !== seqRef.current) return;
      setState((current) => ({ ...current, status: 'error', error }));
    }
  }, [view, status, relatedType, relatedId, enabled]);

  useEffect(() => { load(); }, [load]);
  useTasksChanged(load);
  return { ...state, reload: load };
}

/** People a task can be assigned to (only yourself for own-only roles). */
export function useAssignees(enabled) {
  const [assignees, setAssignees] = useState([]);
  useEffect(() => {
    if (!enabled) return;
    crmFetch('tasks/assignees').then((result) => setAssignees(result.items)).catch(() => setAssignees([]));
  }, [enabled]);
  return assignees;
}
