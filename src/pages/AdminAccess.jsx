import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Copy, KeyRound, RefreshCw, ToggleLeft, ToggleRight, UserPlus } from 'lucide-react';
import { Button } from '../components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/Card';
import { Input } from '../components/ui/Input';
import { Select } from '../components/ui/Select';
import { Alert } from '../components/ui/Alert';
import { StatusBadge } from '../components/ui/StatusBadge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/Tabs';
import Loader from '../components/Loader';
import { useSession } from '../lib/auth';

function formatDate(value) {
  if (!value) return 'Never';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

const FILTER_LABEL = 'mb-1 block text-[13px] font-semibold text-foreground-secondary';
const TAB_PILL = 'h-9 shrink-0 rounded-full border border-border bg-card px-4 text-sm font-semibold text-foreground hover:border-hairline-strong hover:text-foreground data-[state=active]:border-ink data-[state=active]:bg-ink data-[state=active]:text-lime';

const ROLE_LABELS = { skyll_admin: 'Platform admin', admin: 'School admin', teacher: 'Teacher', scanner: 'Scanner', staff: 'Office staff', student: 'Student' };
const FEATURE_LABELS = { review_scale_v2: 'Review scale v2', review_focus_layout: 'Reviewer focus layout', mobile_portal_v2: 'Mobile portal v2', deep_signals: 'Deep signals (Hive)', crm: 'CRM' };

async function request(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'Request failed.');
  return payload;
}

function SchoolSelect({ schools, value, onChange, allowAll = false, id }) {
  return <Select id={id} value={value} onChange={(event) => onChange(event.target.value)} className="sm:w-72">
    {allowAll && <option value="">All schools</option>}
    {!allowAll && !value && <option value="">Select a school</option>}
    {schools.map((school) => <option key={school.id} value={school.id}>{school.name}</option>)}
  </Select>;
}

function UsersTab({ isPlatformAdmin, onSchools }) {
  const [schoolId, setSchoolId] = useState('');
  const [role, setRole] = useState('');
  const [data, setData] = useState({ users: [], schools: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams();
      if (schoolId) params.set('schoolId', schoolId);
      if (role) params.set('role', role);
      const query = params.toString();
      const payload = await request(`/api/auth/admin/users${query ? `?${query}` : ''}`);
      setData(payload);
      onSchools?.(payload.schools || []);
    } catch (requestError) { setError(requestError.message); } finally { setLoading(false); }
  }, [schoolId, role, onSchools]);

  useEffect(() => { load(); }, [load]);

  return <Card>
    <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div><CardTitle className="text-[21px] font-extrabold">Users</CardTitle><CardDescription>Every login with a school membership: who they are, where they belong, and when they last signed in.</CardDescription></div>
      <div className="flex flex-wrap items-end gap-2">
        {isPlatformAdmin && <div><label htmlFor="users-school" className={FILTER_LABEL}>School</label><SchoolSelect id="users-school" schools={data.schools} value={schoolId} onChange={setSchoolId} allowAll /></div>}
        <div><label htmlFor="users-role" className={FILTER_LABEL}>Role</label><Select id="users-role" value={role} onChange={(event) => setRole(event.target.value)} className="sm:w-44"><option value="">Staff roles</option>{Object.entries(ROLE_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select></div>
        <Button variant="secondary" onClick={load} disabled={loading} className="gap-2">{loading ? <Loader size="inline" /> : <RefreshCw size={16} aria-hidden="true" />}Refresh</Button>
      </div>
    </CardHeader>
    <CardContent>
      {error && <Alert variant="destructive" className="mb-4">{error}</Alert>}
      {loading && !data.users.length ? <div className="flex justify-center py-10 text-muted-foreground"><Loader size="inline" /></div> : data.users.length === 0 ? <p className="rounded-xl border border-dashed border-hairline-strong p-6 text-center text-sm text-muted-foreground">No users match this filter.</p> : <div className="max-h-[70vh] overflow-auto"><table className="w-full text-sm"><thead className="sticky top-0 z-10 bg-card"><tr className="border-b border-border text-left text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground"><th className="py-2.5 pr-3 font-semibold">Login</th><th className="py-2.5 pr-3 font-semibold">Name</th><th className="py-2.5 pr-3 font-semibold">Role</th><th className="py-2.5 pr-3 font-semibold">School</th><th className="py-2.5 pr-3 font-semibold">Status</th><th className="py-2.5 font-semibold">Last session</th></tr></thead><tbody>{data.users.map((user) => <tr key={user.membershipId} className="border-b border-border last:border-b-0"><td className="py-2.5 pr-3 font-data text-[12px]">{user.loginId || '—'}</td><td className="py-2.5 pr-3 font-semibold text-ink">{user.displayName}</td><td className="py-2.5 pr-3">{ROLE_LABELS[user.role] || user.role}</td><td className="py-2.5 pr-3 text-foreground-secondary">{user.school}</td><td className="py-2.5 pr-3"><StatusBadge status={user.status === 'active' ? 'positive' : 'neutral'}>{user.status}</StatusBadge></td><td className="py-2.5 tabular-nums text-foreground-secondary">{formatDate(user.lastSessionAt)}</td></tr>)}</tbody></table></div>}
      {data.users.length >= 500 && <p className="mt-3 text-[13px] text-muted-foreground">Showing the first 500 memberships. Narrow the filter to see the rest.</p>}
    </CardContent>
  </Card>;
}

function TeacherTab({ isPlatformAdmin, schools }) {
  const [schoolId, setSchoolId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [loginId, setLoginId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState(null);
  const [copied, setCopied] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setSaving(true); setError(''); setCreated(null);
    try {
      const payload = await request('/api/auth/admin/teachers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schoolId: isPlatformAdmin ? schoolId : undefined, displayName, loginId: loginId || undefined }) });
      setCreated(payload); setDisplayName(''); setLoginId('');
    } catch (requestError) { setError(requestError.message); } finally { setSaving(false); }
  }

  async function copyCredentials() {
    if (!created) return;
    try { await navigator.clipboard.writeText(`Login: ${created.teacher.loginId}\nPassword: ${created.password}`); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setCopied(false); }
  }

  return <div className="grid gap-4 lg:grid-cols-2">
    <Card>
      <CardHeader><CardTitle className="text-[21px] font-extrabold">Add a teacher</CardTitle><CardDescription>Creates a teacher login with a generated password. The password is shown once and never stored in plain text.</CardDescription></CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid gap-4">
          {isPlatformAdmin && <div><label htmlFor="teacher-school" className="mb-1 block text-sm font-medium">School</label><SchoolSelect id="teacher-school" schools={schools} value={schoolId} onChange={setSchoolId} /></div>}
          <div><label htmlFor="teacher-name" className="mb-1 block text-sm font-medium">Display name</label><Input id="teacher-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Priya Sharma" required minLength={2} /></div>
          <div><label htmlFor="teacher-login" className="mb-1 block text-sm font-medium">Login id <span className="text-muted-foreground">(optional)</span></label><Input id="teacher-login" value={loginId} onChange={(event) => setLoginId(event.target.value)} placeholder="Generated from the school and name when blank" pattern="[a-z0-9][a-z0-9_.\-]{3,39}" /></div>
          {error && <Alert variant="destructive">{error}</Alert>}
          <Button type="submit" disabled={saving || (isPlatformAdmin && !schoolId)} className="gap-2 justify-self-start">{saving ? <Loader size="inline" /> : <UserPlus size={16} aria-hidden="true" />}Create teacher login</Button>
        </form>
      </CardContent>
    </Card>
    {created && <Card className="border-[1.5px] border-ink">
      <CardHeader><CardTitle className="flex items-center gap-2 text-[21px] font-extrabold"><KeyRound size={18} aria-hidden="true" />Credentials for {created.teacher.displayName}</CardTitle><CardDescription>Share these with the teacher now. They will not be shown again.</CardDescription></CardHeader>
      <CardContent className="grid gap-3 text-sm">
        <div className="grid gap-1 rounded-xl bg-paper-soft p-4 font-data text-sm"><p><span className="text-muted-foreground">Login: </span><span data-testid="teacher-login-id">{created.teacher.loginId}</span></p><p><span className="text-muted-foreground">Password: </span><span data-testid="teacher-password">{created.password}</span></p><p className="font-sans text-[13px] text-muted-foreground">School: {created.teacher.school}{created.teacher.loginUrl ? ` · sign in at ${created.teacher.loginUrl}` : ''}</p></div>
        <Button variant="secondary" onClick={copyCredentials} className="gap-2 justify-self-start"><Copy size={16} aria-hidden="true" />{copied ? 'Copied' : 'Copy credentials'}</Button>
      </CardContent>
    </Card>}
  </div>;
}

function FlagsTab() {
  const [schoolId, setSchoolId] = useState('');
  const [data, setData] = useState({ features: [], flags: [], schools: [] });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setData(await request('/api/auth/admin/flags')); } catch (requestError) { setError(requestError.message); } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const flagsFor = (targetSchoolId) => Object.fromEntries(data.flags.filter((flag) => flag.schoolId === targetSchoolId).map((flag) => [flag.featureKey, flag]));

  async function toggle(targetSchoolId, featureKey, enabled) {
    setSaving(`${targetSchoolId}:${featureKey}`); setError('');
    try {
      const payload = await request('/api/auth/admin/flags', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schoolId: targetSchoolId, featureKey, enabled }) });
      setData((current) => ({ ...current, flags: [...current.flags.filter((flag) => !(flag.schoolId === targetSchoolId && flag.featureKey === featureKey)), payload.flag] }));
    } catch (requestError) { setError(requestError.message); } finally { setSaving(''); }
  }

  const visibleSchools = schoolId ? data.schools.filter((school) => school.id === schoolId) : data.schools;

  return <Card>
    <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div><CardTitle className="text-[21px] font-extrabold">Feature flags</CardTitle><CardDescription>Guarded rollouts per school. Platform admins always see every feature; these switches decide what a school's own users get.</CardDescription></div>
      <div className="flex flex-wrap items-end gap-2"><div><label htmlFor="flags-school" className={FILTER_LABEL}>School</label><SchoolSelect id="flags-school" schools={data.schools} value={schoolId} onChange={setSchoolId} allowAll /></div><Button variant="secondary" onClick={load} disabled={loading} className="gap-2">{loading ? <Loader size="inline" /> : <RefreshCw size={16} aria-hidden="true" />}Refresh</Button></div>
    </CardHeader>
    <CardContent>
      {error && <Alert variant="destructive" className="mb-4">{error}</Alert>}
      {loading && !data.schools.length ? <div className="flex justify-center py-10 text-muted-foreground"><Loader size="inline" /></div> : <div className="grid gap-4">{visibleSchools.map((school) => {
        const flags = flagsFor(school.id);
        return <div key={school.id} className="rounded-xl border border-border p-4"><p className="text-[15px] font-bold text-ink">{school.name}</p><div className="mt-3 grid gap-2 sm:grid-cols-2">{data.features.map((featureKey) => {
          const flag = flags[featureKey];
          const enabled = Boolean(flag?.enabled);
          const busy = saving === `${school.id}:${featureKey}`;
          return <div key={featureKey} className="flex items-center justify-between gap-3 rounded-[10px] border border-border px-3 py-2"><div className="min-w-0"><p className="text-sm font-semibold text-ink">{FEATURE_LABELS[featureKey] || featureKey}</p><p className="text-[12px] text-muted-foreground">{flag ? `Set by ${flag.updatedBy || 'unknown'} · ${formatDate(flag.updatedAt)}` : 'Never set (off)'}</p></div><Button variant={enabled ? 'ink' : 'secondary'} size="sm" disabled={busy} onClick={() => toggle(school.id, featureKey, !enabled)} aria-label={`${enabled ? 'Disable' : 'Enable'} ${FEATURE_LABELS[featureKey] || featureKey} for ${school.name}`} aria-pressed={enabled} className={`h-9 shrink-0 gap-1 px-3 ${enabled ? 'text-lime' : ''}`}>{busy ? <Loader size="inline" /> : enabled ? <ToggleRight size={16} aria-hidden="true" /> : <ToggleLeft size={16} aria-hidden="true" />}{enabled ? 'On' : 'Off'}</Button></div>;
        })}</div></div>;
      })}</div>}
    </CardContent>
  </Card>;
}

export default function AdminAccess() {
  const { user } = useSession();
  const role = user?.role || localStorage.getItem('userRole');
  const isPlatformAdmin = role === 'skyll_admin';
  // The users list already carries the school directory; the teacher form
  // reuses it instead of fetching again.
  const [schools, setSchools] = useState([]);

  return <main className="min-h-screen bg-background text-foreground">
    <header className="border-b border-border bg-card"><div className="mx-auto flex h-14 max-w-6xl items-center px-4 sm:px-8"><Button asChild variant="ghost" className="-ml-2 h-9 gap-1.5 px-2.5 text-sm text-foreground-secondary hover:text-foreground"><Link to="/admin-dashboard"><ArrowLeft size={16} aria-hidden="true" />Operations</Link></Button></div></header>
    <div className="mx-auto max-w-6xl px-4 pb-14 pt-8 sm:px-8 sm:pt-10">
      <div className="mb-6 flex flex-col gap-1"><h1 className="font-headline text-[32px] font-extrabold leading-[1.05] tracking-[-0.03em] text-ink sm:text-[44px]">Access</h1><p className="text-sm text-foreground-secondary">{isPlatformAdmin ? 'Logins, teacher accounts and feature flags across every school.' : 'Logins and teacher accounts for your school.'}</p></div>
      <Tabs defaultValue="users">
        <TabsList className="mb-5 h-auto justify-start gap-2 overflow-x-auto border-b-0 bg-transparent no-scrollbar"><TabsTrigger value="users" className={TAB_PILL}>Users</TabsTrigger><TabsTrigger value="teachers" className={TAB_PILL}>Add teacher</TabsTrigger>{isPlatformAdmin && <TabsTrigger value="flags" className={TAB_PILL}>Feature flags</TabsTrigger>}</TabsList>
        <TabsContent value="users"><UsersTab isPlatformAdmin={isPlatformAdmin} onSchools={setSchools} /></TabsContent>
        <TabsContent value="teachers"><TeacherTab isPlatformAdmin={isPlatformAdmin} schools={schools} /></TabsContent>
        {isPlatformAdmin && <TabsContent value="flags"><FlagsTab /></TabsContent>}
      </Tabs>
    </div>
  </main>;
}
