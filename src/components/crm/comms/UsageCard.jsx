// This month's WhatsApp use and its estimated cost (CRM M2 phase 2 S2, D15).
// Meta bills the class; this is Skyll's estimate so the class can set a limit.
import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/Card';
import { crmFetch } from '../../../lib/crm/api';
import { formatMoney } from '../../../../shared/crm/fees.js';

export default function UsageCard({ refreshKey }) {
  const [usage, setUsage] = useState(null);
  useEffect(() => {
    let live = true;
    crmFetch('settings/whatsapp/usage').then((data) => { if (live) setUsage(data); }).catch(() => {});
    return () => { live = false; };
  }, [refreshKey]);
  if (!usage) return null;
  const share = usage.limitPaise ? Math.min(100, Math.round((usage.estimatedPaise / usage.limitPaise) * 100)) : null;
  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>This month</CardTitle>
        <CardDescription>Skyll’s estimate of what Meta will bill your class, including GST. Replies to parents within 24 hours are free for the first 1,000 a month.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <dl className="grid grid-cols-3 gap-4 text-sm">
          <div><dt className="text-muted-foreground">Messages</dt><dd className="text-2xl font-semibold tabular-nums">{usage.messages}</dd></div>
          <div><dt className="text-muted-foreground">Notices and reminders</dt><dd className="text-2xl font-semibold tabular-nums">{usage.counts.utility}</dd></div>
          <div><dt className="text-muted-foreground">Estimated cost</dt><dd className="text-2xl font-semibold tabular-nums">{formatMoney(usage.estimatedPaise)}</dd></div>
        </dl>
        {share !== null && (
          <div className="space-y-1">
            <div className="h-2 overflow-hidden rounded-full bg-sunken" role="progressbar" aria-valuenow={share} aria-valuemin={0} aria-valuemax={100} aria-label="Share of the monthly limit used">
              <div className={`h-full ${share >= 100 ? 'bg-destructive' : share >= 80 ? 'bg-warning' : 'bg-success'}`} style={{ width: `${share}%` }} />
            </div>
            <p className="text-xs text-muted-foreground">{share}% of your {formatMoney(usage.limitPaise)} monthly limit</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
