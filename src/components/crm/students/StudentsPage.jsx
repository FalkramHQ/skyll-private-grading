// Students section (CRM-007, FLKRM-326 S4): the school's canonical roster with
// batches, tags and — for people with contact access — the primary guardian.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Search } from 'lucide-react';
import { Alert, AlertDescription } from '../../ui/Alert';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Input } from '../../ui/Input';
import { Select } from '../../ui/Select';
import { Skeleton } from '../../ui/Skeleton';
import { crmFetch } from '../../../lib/crm/api';
import { TagChips } from '../records/TagPicker';
import { Segmented } from '../tasks/TasksPage';

export const STATUS_LABELS = { active: 'Active', inactive: 'Inactive', alumni: 'Alumni', archived: 'Archived' };
const PAGE = 100;

export default function StudentsPage({ me }) {
  const showContacts = me.capabilities.includes('crm.contacts.read');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('active');
  const [batchId, setBatchId] = useState('');
  const [batches, setBatches] = useState([]);
  const [state, setState] = useState({ status: 'loading', items: [], nextCursor: null, error: null });

  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    crmFetch('students/batches').then((result) => setBatches(result.items)).catch(() => setBatches([]));
  }, []);

  const load = useCallback(async (cursor) => {
    const params = new URLSearchParams({ limit: String(PAGE), status });
    if (search) params.set('q', search);
    if (batchId) params.set('batchId', batchId);
    if (cursor) params.set('cursor', cursor);
    try {
      const page = await crmFetch(`students?${params}`);
      setState((current) => ({ status: 'ready', items: cursor ? [...current.items, ...page.items] : page.items, nextCursor: page.nextCursor, error: null }));
    } catch (error) {
      setState((current) => ({ ...current, status: 'error', error }));
    }
  }, [status, search, batchId]);

  useEffect(() => { load(null); }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[12rem] flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input aria-label="Search students by name" placeholder="Search student name" className="pl-9" value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>
        <Segmented label="Status" options={[['active', 'Active'], ['inactive', 'Inactive'], ['alumni', 'Alumni'], ['all', 'All']]} value={status} onChange={setStatus} />
        <Select aria-label="Filter by batch" className="w-auto min-w-[12rem]" value={batchId} onChange={(event) => setBatchId(event.target.value)}>
          <option value="">All batches</option>
          {batches.map((batch) => <option key={batch.id} value={batch.id}>{batch.name}</option>)}
        </Select>
      </div>

      {state.status === 'loading' && <Skeleton className="h-64 w-full" />}
      {state.status === 'error' && <Alert variant="destructive"><AlertDescription>{state.error.message}</AlertDescription></Alert>}
      {state.status === 'ready' && !state.items.length && <p className="text-sm text-muted-foreground">No students match.</p>}
      {state.status === 'ready' && state.items.length > 0 && (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="p-3 font-medium">Student</th>
                <th className="p-3 font-medium">Batches</th>
                <th className="p-3 font-medium">Class</th>
                {showContacts && <th className="p-3 font-medium">Primary guardian</th>}
                <th className="p-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {state.items.map((student) => (
                <tr key={student.id}>
                  <td className="p-3">
                    <Link to={`/crm/students/${student.id}`} className="font-medium hover:underline">{student.name}</Link>
                    {student.tags.length > 0 && <div className="mt-1"><TagChips tags={student.tags} max={3} /></div>}
                  </td>
                  <td className="p-3 text-muted-foreground">{student.batches.map((batch) => batch.name).join(', ') || '—'}</td>
                  <td className="p-3 text-muted-foreground">{student.standard || '—'}</td>
                  {showContacts && (
                    <td className="p-3">
                      {student.primaryGuardian
                        ? <>{student.primaryGuardian.name || 'Unnamed'} <span className="text-xs text-muted-foreground">{student.primaryGuardian.phone}</span></>
                        : <span className="text-xs text-warning-soft-foreground">None on file</span>}
                    </td>
                  )}
                  <td className="p-3"><Badge variant={student.status === 'active' ? 'success' : 'secondary'}>{STATUS_LABELS[student.status] || student.status}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {state.nextCursor && <Button variant="outline" onClick={() => load(state.nextCursor)}>Load more</Button>}
    </div>
  );
}
