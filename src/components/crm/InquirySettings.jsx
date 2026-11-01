// Settings → Inquiry form (CRM-009, FLKRM-326 S6, D8): turn the public
// admissions form on or off, choose who receives new inquiries, and copy the
// link to share. The server re-checks the owner and the version.
import { useCallback, useEffect, useState } from 'react';
import { Copy, ExternalLink } from 'lucide-react';
import { Alert, AlertDescription } from '../ui/Alert';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/Card';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { Skeleton } from '../ui/Skeleton';
import { crmFetch, newIdempotencyKey } from '../../lib/crm/api';

export default function InquirySettings() {
  const [settings, setSettings] = useState(null);
  const [owner, setOwner] = useState('');
  const [status, setStatus] = useState('loading');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);

  const show = (data) => { setSettings(data); setOwner(data.ownerEligible ? data.defaultOwnerUserId : ''); };

  const load = useCallback(async () => {
    setStatus('loading');
    setError(null);
    try {
      show(await crmFetch('settings/inquiry'));
      setStatus('ready');
    } catch (err) {
      setError(err);
      setStatus('error');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = async (enabled) => {
    setBusy(true);
    setError(null);
    try {
      show(await crmFetch('settings/inquiry', {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
        body: { enabled, defaultOwnerUserId: owner || null, expectedVersion: settings.version },
      }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (status === 'loading') return <Skeleton className="h-64 w-full" />;
  if (status === 'error') return <Alert variant="destructive"><AlertDescription>{error.message}</AlertDescription></Alert>;

  const link = settings.publicPath ? `${window.location.origin}${settings.publicPath}` : null;
  const ownerChanged = (owner || null) !== (settings.ownerEligible ? settings.defaultOwnerUserId : null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked: the link is still selectable in the box.
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        A public page where parents can send an admissions inquiry without logging in. Each one becomes a lead in your first stage, with a follow-up task.
      </p>
      {error && (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            <span>{error.code === 'version_conflict' ? 'Someone else changed these settings while you were editing.' : error.message}</span>
            {error.code === 'version_conflict' && <Button size="sm" variant="outline" onClick={load}>Reload latest</Button>}
          </AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-base">Inquiry form</CardTitle>
            <Badge variant={settings.enabled ? 'success' : 'secondary'}>{settings.enabled ? 'On' : 'Off'}</Badge>
          </div>
          <CardDescription>
            {settings.enabled ? 'Parents with the link can send inquiries.' : 'The link shows “This form isn’t available” until you turn it on.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="inquiry-owner" className="text-sm font-medium">New inquiries go to</label>
            <Select id="inquiry-owner" value={owner} disabled={busy} onChange={(event) => setOwner(event.target.value)} className="sm:w-72">
              <option value="">Choose a team member</option>
              {settings.owners.map((member) => <option key={member.userId} value={member.userId}>{member.name || member.userId}</option>)}
            </Select>
            <p className="text-xs text-muted-foreground">They own the new lead and get its follow-up task.</p>
            {settings.enabled && !settings.ownerEligible && (
              <p className="text-xs text-destructive">The chosen person can no longer own leads, so new inquiries arrive unowned. Choose someone else.</p>
            )}
          </div>
          {link && (
            <div className="space-y-1.5">
              <label htmlFor="inquiry-link" className="text-sm font-medium">Link to share</label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input id="inquiry-link" readOnly value={link} onFocus={(event) => event.target.select()} />
                <Button type="button" variant="outline" onClick={copy}>
                  <Copy className="mr-1 h-4 w-4" aria-hidden="true" />{copied ? 'Copied' : 'Copy link'}
                </Button>
                <Button type="button" variant="outline" asChild>
                  <a href={settings.publicPath} target="_blank" rel="noreferrer"><ExternalLink className="mr-1 h-4 w-4" aria-hidden="true" />Open</a>
                </Button>
              </div>
            </div>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            {settings.enabled && (
              <>
                <Button variant="outline" disabled={busy} onClick={() => save(false)}>Turn off</Button>
                <Button disabled={busy || !owner || !ownerChanged} onClick={() => save(true)}>Save</Button>
              </>
            )}
            {!settings.enabled && <Button disabled={busy || !owner} onClick={() => save(true)}>Turn on</Button>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
