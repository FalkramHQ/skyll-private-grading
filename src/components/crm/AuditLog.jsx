import { useCallback, useEffect, useState } from 'react';
import { Alert, AlertDescription } from '../ui/Alert';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Skeleton } from '../ui/Skeleton';
import { crmFetch } from '../../lib/crm/api';
import { auditActionLabel, capabilityLabel } from './capabilityLabels';

function formatSummary(summary) {
  return Object.entries(summary || {})
    .map(([key, value]) => (key === 'capability' ? capabilityLabel(value) : `${key}: ${value}`))
    .join(' · ');
}

function formatTime(iso) {
  try {
    return new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

/** Settings → Audit log: read-only, newest first, paged by cursor. */
export default function AuditLog() {
  const [items, setItems] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');

  const load = useCallback(async (after) => {
    setStatus('loading');
    try {
      const data = await crmFetch(`audit?limit=50${after ? `&cursor=${encodeURIComponent(after)}` : ''}`);
      setItems((current) => (after ? [...current, ...data.items] : data.items));
      setCursor(data.nextCursor);
      setStatus('ready');
    } catch (err) {
      setError(err.message);
      setStatus('error');
    }
  }, []);

  useEffect(() => { load(null); }, [load]);

  if (status === 'error') return <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>;
  if (status === 'loading' && !items.length) return <Skeleton className="h-40 w-full" />;
  if (!items.length) return <p className="text-sm text-muted-foreground">No CRM activity recorded yet.</p>;

  return (
    <div className="space-y-3">
      <Card className="divide-y divide-border">
        {items.map((item) => (
          <div key={item.id} className="flex flex-col gap-1 p-4 sm:flex-row sm:items-center sm:gap-4">
            <div className="min-w-0 flex-1">
              <p className="font-medium text-foreground">{auditActionLabel(item.action)}</p>
              <p className="truncate text-sm text-muted-foreground">{formatSummary(item.summary)}</p>
            </div>
            <div className="flex items-center gap-2 text-sm text-foreground-secondary">
              <span>{item.actor.name || item.actor.userId || 'System'}</span>
              {item.actor.role === 'skyll_admin' && <Badge variant="warning">Skyll support</Badge>}
            </div>
            <time className="text-xs text-muted-foreground sm:w-40 sm:text-right" dateTime={item.createdAt}>{formatTime(item.createdAt)}</time>
          </div>
        ))}
      </Card>
      {cursor && (
        <Button variant="outline" onClick={() => load(cursor)} disabled={status === 'loading'}>Load more</Button>
      )}
    </div>
  );
}
