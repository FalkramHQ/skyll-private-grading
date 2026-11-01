import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, BookOpen, LogOut } from 'lucide-react';
import { loginPathForSchool } from '../lib/auth';
import { getStudentProfile } from '../lib/db';
import { signOut } from '../lib/session';
import { track } from '../lib/analytics';
import { Button } from '../components/ui/Button';
import Loader from '../components/Loader';

const LOUD_CARD = 'rounded-[20px] border-2 border-ink bg-card';
const ICON_BUTTON = 'inline-flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-xl border-2 border-ink bg-card px-3 text-sm font-semibold text-ink transition-colors hover:bg-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background';

function ProfileField({ label, value }) {
  return <div className="rounded-2xl border border-border bg-paper-soft px-4 py-3"><dt className="text-[13px] font-semibold text-foreground-secondary">{label}</dt><dd className={`mt-1 text-base font-semibold ${value ? 'text-foreground' : 'font-normal text-muted-foreground'}`}>{value || 'Not provided by your school'}</dd></div>;
}

export default function StudentProfile() {
  const navigate = useNavigate();
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const initial = useMemo(() => (profile?.name || '?').trim().charAt(0).toUpperCase(), [profile]);

  async function loadProfile() {
    setLoading(true);
    setLoadError('');
    try {
      const response = await getStudentProfile();
      setProfile(response.profile);
    } catch (error) {
      setLoadError(error.message || 'Could not load your profile');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadProfile(); track('profile_viewed', { surface: 'web_student' }); }, []);

  async function handleLogout() {
    const loginPath = loginPathForSchool();
    await signOut();
    navigate(loginPath, { replace: true });
  }

  if (loading) return <div className="notebook-grid flex min-h-screen items-center justify-center"><div className="flex flex-col items-center gap-3 rounded-[20px] border-2 border-ink bg-card px-8 py-6 text-sm font-semibold text-foreground shadow-hard-lg"><Loader size="inline" />Loading your profile...</div></div>;
  if (loadError) return <div className="notebook-grid flex min-h-screen items-center justify-center px-4"><div className={`${LOUD_CARD} max-w-sm p-6 text-center shadow-hard-lg`}><h1 className="font-display text-xl text-foreground">We couldn’t load your profile</h1><p className="mt-2 text-sm text-foreground-secondary">{loadError}</p><div className="mt-5 flex flex-wrap justify-center gap-3"><Button onClick={loadProfile} className="h-11 px-4 text-sm">Try again</Button><Button variant="outline" onClick={() => navigate('/dashboard')} className="h-11 border-2 px-4 text-sm">Dashboard</Button></div></div></div>;

  return <div className="notebook-grid min-h-screen text-foreground">
    <header className="sticky top-0 z-50 border-b-2 border-ink bg-paper"><div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-2.5 sm:px-6"><div className="flex min-w-0 items-center gap-3"><img src="/skyll-logo.svg" alt="Skyll" className="hidden h-7 w-7 sm:block" /><div className="min-w-0"><p className="truncate text-[15px] font-bold text-foreground">My Profile</p><p className="truncate text-[13px] text-foreground-secondary">Academic details</p></div></div><button type="button" onClick={() => navigate('/dashboard')} className={ICON_BUTTON}><ArrowLeft className="h-5 w-5" aria-hidden="true" /><span className="hidden sm:inline">Dashboard</span><span className="sr-only sm:hidden">Back to dashboard</span></button></div></header>
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-8 sm:px-6 sm:py-10">
      <section className={`${LOUD_CARD} p-5 shadow-hard-lg sm:p-7`}><div className="flex items-center gap-4"><div className="flex h-16 w-16 shrink-0 rotate-[-4deg] items-center justify-center rounded-2xl border-2 border-ink bg-lime font-display text-2xl font-extrabold text-ink" aria-hidden="true">{initial}</div><div className="min-w-0"><h1 className="truncate font-display text-[26px] font-extrabold leading-tight tracking-[-0.02em] text-foreground sm:text-[32px]">{profile.name}</h1><p className="mt-1 truncate text-[15px] text-foreground-secondary">Class {profile.class || 'not provided'} · {profile.school}</p></div></div></section>
      <section className={`${LOUD_CARD} p-5 sm:p-7`}><div className="flex items-start gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border-[1.5px] border-ink bg-action-tint" aria-hidden="true"><BookOpen className="h-5 w-5 text-ink" /></span><div><h2 className="font-display text-[21px] leading-tight text-foreground">Academic information</h2><p className="mt-1 text-sm text-foreground-secondary">These school-managed details are read-only.</p></div></div><dl className="mt-5 grid gap-3 sm:grid-cols-2"><ProfileField label="Name" value={profile.name} /><ProfileField label="Username" value={profile.username} /><ProfileField label="Class / grade" value={profile.class} /><ProfileField label="School" value={profile.school} /><ProfileField label="Batch" value={profile.batches?.join(', ')} /><ProfileField label="Board" value={profile.board} /></dl><p className="mt-4 text-[13px] leading-relaxed text-foreground-secondary">Need a correction or a password reset? Please contact your school administrator. This helps keep class rosters and assessment records accurate.</p></section>
      <section className="flex justify-end"><Button variant="outline" onClick={handleLogout} className="h-11 gap-2 border-2 px-4 text-sm"><LogOut className="h-4 w-4" aria-hidden="true" />Log out</Button></section>
    </main>
  </div>;
}
