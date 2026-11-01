import { useCallback, useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { Alert, AlertDescription } from '../ui/Alert';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/Card';
import { Select } from '../ui/Select';
import { Skeleton } from '../ui/Skeleton';
import { crmFetch, newIdempotencyKey } from '../../lib/crm/api';
import { capabilityLabel } from './capabilityLabels';

function MemberCard({ member, presets, grantable, onChange }) {
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async (path, body) => {
    setBusy(true);
    setError('');
    try {
      const result = await crmFetch(path, { method: 'POST', body, idempotencyKey: newIdempotencyKey() });
      onChange(member.userId, result.grants);
      setChoice('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const grant = () => {
    if (!choice) return;
    const [kind, value] = choice.split(':');
    run('permissions/grants', kind === 'preset' ? { userId: member.userId, preset: value } : { userId: member.userId, capabilities: [value] });
  };

  const extra = member.grants.filter((cap) => !member.defaults.includes(cap));
  const available = grantable.filter((cap) => !member.defaults.includes(cap) && !member.grants.includes(cap));

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">{member.name || member.username || member.userId}</CardTitle>
          <Badge variant="secondary">{member.role}</Badge>
          {member.username && <span className="text-xs text-muted-foreground">{member.username}</span>}
        </div>
        {member.defaults.length > 0 && (
          <CardDescription>Included with the {member.role} role: {member.defaults.map(capabilityLabel).join(', ')}</CardDescription>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2" aria-label={`Access granted to ${member.name}`}>
          {extra.length === 0 && <span className="text-sm text-muted-foreground">No extra access</span>}
          {extra.map((cap) => (
            <Badge key={cap} variant="outline" className="gap-1 pr-1">
              {capabilityLabel(cap)}
              <button
                type="button"
                className="rounded-full p-0.5 hover:bg-muted disabled:opacity-50"
                aria-label={`Remove ${capabilityLabel(cap)}`}
                disabled={busy}
                onClick={() => run('permissions/revoke', { userId: member.userId, capability: cap })}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Select aria-label={`Add access for ${member.name}`} value={choice} onChange={(event) => setChoice(event.target.value)} disabled={busy}>
            <option value="">Add access…</option>
            <optgroup label="Bundles">
              {presets.map((preset) => <option key={preset.key} value={`preset:${preset.key}`}>{preset.label}</option>)}
            </optgroup>
            <optgroup label="Single permission">
              {available.map((cap) => <option key={cap} value={`cap:${cap}`}>{capabilityLabel(cap)}</option>)}
            </optgroup>
          </Select>
          <Button onClick={grant} disabled={!choice || busy} className="sm:w-28">Grant</Button>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}

/** Settings → Team access: grant and remove CRM access for teachers and staff. */
export default function TeamAccess({ myCapabilities }) {
  const [state, setState] = useState({ status: 'loading', items: [], presets: [], error: '' });

  const load = useCallback(async () => {
    try {
      const data = await crmFetch('permissions/team?limit=200');
      setState({ status: 'ready', items: data.items, presets: data.presets, error: '' });
    } catch (error) {
      setState({ status: 'error', items: [], presets: [], error: error.message });
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const updateGrants = (userId, grants) => {
    setState((current) => ({ ...current, items: current.items.map((item) => (item.userId === userId ? { ...item, grants } : item)) }));
  };

  if (state.status === 'loading') return <Skeleton className="h-40 w-full" />;
  if (state.status === 'error') return <Alert variant="destructive"><AlertDescription>{state.error}</AlertDescription></Alert>;
  if (!state.items.length) return <p className="text-sm text-muted-foreground">No teachers or staff logins in this school yet.</p>;

  // You can only hand out access you hold yourself (the server enforces this too).
  const grantable = myCapabilities;
  const presets = state.presets.filter((preset) => preset.capabilities.every((cap) => myCapabilities.includes(cap)));

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {state.items.map((member) => (
        <MemberCard key={member.userId} member={member} presets={presets} grantable={grantable} onChange={updateGrants} />
      ))}
    </div>
  );
}
