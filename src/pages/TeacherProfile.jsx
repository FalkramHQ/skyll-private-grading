import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Copy, KeyRound, LogOut, Pencil, Plus, Trash2 } from 'lucide-react';
import { changePassword, getTeacherProfile, getTeacherRoster, saveTeacherRoster } from '../lib/db';
import { loginPathForSchool } from '../lib/auth';
import { signOut } from '../lib/session';
import { track } from '../lib/analytics';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Input as UIInput } from '../components/ui/Input';
import { Alert as UIAlert, AlertDescription } from '../components/ui/Alert';
import Loader from '../components/Loader';

const blankBatch = { name: '', grade: '', board: '', stream: '', academicYear: '' };
const blankStudent = { name: '', username: '', standard: '', batchIds: [] };
const passwordPattern = /^[A-Za-z0-9_-]{12,24}$/;

function Alert({ children }) { return children ? <UIAlert variant="destructive" className="mb-4"><AlertDescription>{children}</AlertDescription></UIAlert> : null; }

function Field({ label, children }) { return <label className="block text-sm font-semibold text-foreground">{label}{children}</label>; }
function Input({ ...props }) { return <UIInput {...props} className="mt-1 h-10" />; }
function SectionTitle({ title, description }) { return <div><h2 className="font-headline text-[21px] font-extrabold leading-tight text-ink">{title}</h2>{description && <p className="mt-0.5 text-sm text-foreground-secondary">{description}</p>}</div>; }

function BatchEditor({ draft, setDraft, save, cancel, saving }) {
  return <form onSubmit={save} className="mt-4 grid gap-3 border-t border-border pt-4 sm:grid-cols-2">
    <Field label="Batch name"><Input required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></Field>
    <Field label="Grade"><Input value={draft.grade} onChange={(event) => setDraft({ ...draft, grade: event.target.value })} /></Field>
    <Field label="Board"><Input value={draft.board} onChange={(event) => setDraft({ ...draft, board: event.target.value })} /></Field>
    <Field label="Stream"><Input value={draft.stream} onChange={(event) => setDraft({ ...draft, stream: event.target.value })} /></Field>
    <Field label="Academic year"><Input value={draft.academicYear} placeholder="2026–27" onChange={(event) => setDraft({ ...draft, academicYear: event.target.value })} /></Field>
    <div className="flex items-end gap-2"><Button disabled={saving}>{saving ? 'Saving...' : 'Save batch'}</Button><Button type="button" variant="secondary" onClick={cancel}>Cancel</Button></div>
  </form>;
}

function StudentEditor({ draft, setDraft, batches, save, cancel, saving }) {
  const toggle = (batchId) => setDraft({ ...draft, batchIds: draft.batchIds.includes(batchId) ? draft.batchIds.filter((id) => id !== batchId) : [...draft.batchIds, batchId] });
  return <form onSubmit={save} className="mt-4 space-y-4 border-t border-border pt-4">
    <div className="grid gap-3 sm:grid-cols-3"><Field label="Student name"><Input required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></Field><Field label="Username (optional)"><Input value={draft.username} placeholder="Generated if blank" maxLength={6} pattern="[a-z0-9]{6}" onChange={(event) => setDraft({ ...draft, username: event.target.value.toLowerCase() })} /></Field><Field label="Class / grade"><Input value={draft.standard} onChange={(event) => setDraft({ ...draft, standard: event.target.value })} /></Field></div>
    <fieldset><legend className="text-sm font-semibold text-foreground">Active batches</legend><div className="mt-2 grid gap-2 sm:grid-cols-2">{batches.map((batch) => <label key={batch.id} className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-[10px] border border-border px-3 py-2 text-sm hover:border-hairline-strong has-[:checked]:border-ink"><input type="checkbox" className="h-4 w-4 accent-ink" checked={draft.batchIds.includes(batch.id)} onChange={() => toggle(batch.id)} />{batch.name}{batch.grade ? ` · ${batch.grade}` : ''}</label>)}</div>{!batches.length && <p className="mt-2 text-sm font-medium text-warning">Create a batch before adding a student.</p>}</fieldset>
    <div className="flex gap-2"><Button disabled={saving || !draft.batchIds.length}>{saving ? 'Saving...' : 'Save student'}</Button><Button type="button" variant="secondary" onClick={cancel}>Cancel</Button></div>
  </form>;
}

export default function TeacherProfile() {
  const navigate = useNavigate();
  const [profile, setProfile] = useState(null); const [roster, setRoster] = useState({ batches: [], students: [] });
  const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false); const [error, setError] = useState('');
  const [batchDraft, setBatchDraft] = useState(null); const [studentDraft, setStudentDraft] = useState(null); const [credentials, setCredentials] = useState(null);
  const [currentPassword, setCurrentPassword] = useState(''); const [newPassword, setNewPassword] = useState(''); const [confirmation, setConfirmation] = useState(''); const [passwordMessage, setPasswordMessage] = useState('');

  async function load() { setLoading(true); setError(''); try { const [profileResponse, rosterResponse] = await Promise.all([getTeacherProfile(), getTeacherRoster()]); setProfile(profileResponse.profile); setRoster(rosterResponse); } catch (loadError) { setError(loadError.message || 'Could not load the teacher profile'); } finally { setLoading(false); } }
  useEffect(() => { load(); track('school_profile_viewed', { surface: 'web_teacher' }); }, []);
  async function logout() { const path = loginPathForSchool(); await signOut(); navigate(path, { replace: true }); }
  async function mutate(method, body) { setSaving(true); setError(''); try { const result = await saveTeacherRoster(method, body); setRoster({ batches: result.batches, students: result.students }); return result; } catch (mutationError) { setError(mutationError.message || 'Could not update the roster'); return null; } finally { setSaving(false); } }
  async function saveBatch(event) { event.preventDefault(); const result = await mutate(batchDraft.id ? 'PATCH' : 'POST', { resource: 'batch', ...batchDraft }); if (result) setBatchDraft(null); }
  async function saveStudent(event) { event.preventDefault(); const result = await mutate(studentDraft.id ? 'PATCH' : 'POST', { resource: 'student', ...studentDraft }); if (result) { setCredentials(result.result?.password ? result.result : null); setStudentDraft(null); } }
  async function archive(resource, item) { if (window.confirm(`Archive ${item.name}? Historical assessment data will be retained.`)) await mutate('DELETE', { resource, id: item.id }); }
  async function savePassword(event) { event.preventDefault(); setPasswordMessage(''); if (!passwordPattern.test(newPassword)) return setPasswordMessage('Use 12–24 letters, digits, hyphens, or underscores.'); if (newPassword !== confirmation) return setPasswordMessage('New password and confirmation do not match.'); setSaving(true); try { const result = await changePassword(currentPassword, newPassword); setPasswordMessage(result.message); setCurrentPassword(''); setNewPassword(''); setConfirmation(''); window.setTimeout(logout, 1200); } catch (passwordError) { setPasswordMessage(passwordError.message || 'Could not change password'); } finally { setSaving(false); } }
  async function copyCredentials() { await navigator.clipboard?.writeText(`Username: ${credentials.username}\nTemporary password: ${credentials.password}`); }

  if (loading) return <div className="flex min-h-screen items-center justify-center gap-2 bg-background text-sm text-muted-foreground"><Loader size="inline" />Loading teacher profile...</div>;
  if (!profile) return <div className="flex min-h-screen items-center justify-center bg-background px-4"><Card className="max-w-sm p-6"><Alert>{error}</Alert><Button onClick={load} className="mt-4">Try again</Button></Card></div>;
  
  return <main className="min-h-screen bg-background text-foreground"><header className="border-b border-border bg-card"><div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-2 px-4 sm:px-6"><Button variant="ghost" onClick={() => navigate('/dashboard')} className="-ml-2 h-9 gap-1.5 px-2.5 text-sm text-foreground-secondary hover:text-foreground"><ArrowLeft size={16} aria-hidden="true" />Dashboard</Button><Button variant="ghost" onClick={logout} className="h-9 gap-1.5 px-2.5 text-sm text-foreground-secondary hover:text-foreground"><LogOut size={16} aria-hidden="true" />Log out</Button></div></header>
    <div className="mx-auto flex max-w-6xl flex-col gap-5 px-4 pb-14 pt-8 sm:px-6 sm:pt-10">
      <div className="flex flex-col gap-1"><h1 className="font-headline text-[32px] font-extrabold leading-[1.05] tracking-[-0.03em] text-ink sm:text-[44px]">Teacher profile</h1><p className="text-sm text-foreground-secondary">Account security and school roster</p></div>
      <Alert>{error}</Alert>
      <Card className="flex items-center gap-4 p-5"><span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border-[1.5px] border-ink bg-lime text-sm font-bold text-ink" aria-hidden="true">{String(profile.name || profile.username || '?').split(/\s+/).filter(Boolean).map((part) => part[0]).join('').slice(0, 2).toUpperCase()}</span><div className="min-w-0"><h2 className="truncate font-headline text-[21px] font-extrabold text-ink">{profile.name}</h2><p className="mt-0.5 truncate text-sm text-foreground-secondary">{profile.school} · {profile.username}</p></div></Card>
      <Card className="p-5"><SectionTitle title="Account security" description="Changing your password signs you out of every device." /><form onSubmit={savePassword} className="mt-4 grid gap-3 md:grid-cols-3"><Input required type="password" autoComplete="current-password" aria-label="Current password" placeholder="Current password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /><Input required type="password" autoComplete="new-password" aria-label="New password" placeholder="New password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /><Input required type="password" autoComplete="new-password" aria-label="Confirm new password" placeholder="Confirm new password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /><div className="flex flex-wrap items-center gap-3 md:col-span-3"><Button variant="secondary" disabled={saving} className="gap-2"><KeyRound size={16} aria-hidden="true" />Change password</Button>{passwordMessage && <p role="status" className="text-sm text-foreground-secondary">{passwordMessage}</p>}</div></form></Card>
      {credentials && <Card className="border-[1.5px] border-ink p-5"><div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="font-headline text-[21px] font-extrabold text-ink">New student credentials</h2><p className="mt-2 font-data text-sm text-foreground">Username: <strong>{credentials.username}</strong><br />Temporary password: <strong>{credentials.password}</strong></p><p className="mt-2 text-[13px] font-semibold text-warning">Copy these now. The temporary password is shown only once.</p></div><Button variant="secondary" onClick={copyCredentials} className="gap-2"><Copy size={16} aria-hidden="true" />Copy</Button></div></Card>}
      <Card className="p-5"><div className="flex flex-wrap items-center justify-between gap-3"><SectionTitle title="Batches" description="Create and maintain your school’s batches." /><Button variant="secondary" onClick={() => setBatchDraft({ ...blankBatch })} className="gap-2"><Plus size={16} aria-hidden="true" />Add batch</Button></div>{batchDraft && <BatchEditor draft={batchDraft} setDraft={setBatchDraft} save={saveBatch} cancel={() => setBatchDraft(null)} saving={saving} />}<RosterTable rows={roster.batches} kind="batch" edit={setBatchDraft} archive={archive} /></Card>
      <Card className="p-5"><div className="flex flex-wrap items-center justify-between gap-3"><SectionTitle title="Students" description="Add students to active batches and keep the roster up to date." /><Button variant="secondary" onClick={() => setStudentDraft({ ...blankStudent })} className="gap-2"><Plus size={16} aria-hidden="true" />Add student</Button></div>{studentDraft && <StudentEditor draft={studentDraft} setDraft={setStudentDraft} batches={roster.batches} save={saveStudent} cancel={() => setStudentDraft(null)} saving={saving} />}<RosterTable rows={roster.students} kind="student" edit={(student) => setStudentDraft({ ...student, standard: '' })} archive={archive} /></Card>
    </div></main>;
}

function RosterTable({ rows, kind, edit, archive }) {
  const batch = kind === 'batch';
  return <div className="mt-4 overflow-x-auto"><table className="w-full text-left text-sm"><thead className="border-b border-border"><tr className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground"><th className="pb-2 pr-3 font-semibold">{batch ? 'Batch' : 'Student'}</th><th className="pb-2 pr-3 font-semibold">{batch ? 'Grade' : 'Username'}</th><th className="pb-2 pr-3 font-semibold">{batch ? 'Students' : 'Batches'}</th><th className="pb-2"><span className="sr-only">Actions</span></th></tr></thead><tbody>{rows.map((row) => <tr key={row.id} className="border-b border-border last:border-0"><td className="py-2.5 pr-3"><span className="font-semibold text-ink">{row.name}</span>{batch && <span className="block text-[12px] text-muted-foreground">{[row.board, row.stream, row.academicYear].filter(Boolean).join(' · ')}</span>}</td><td className={`pr-3 ${batch ? '' : 'font-data text-[12px]'}`}>{batch ? row.grade || '-' : row.username || '-'}</td><td className="pr-3 tabular-nums text-foreground-secondary">{batch ? row.studentCount : row.batches.join(', ') || '-'}</td><td className="whitespace-nowrap text-right"><button type="button" onClick={() => edit(row)} aria-label={`Edit ${row.name}`} className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-foreground-secondary transition-colors hover:bg-sunken hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><Pencil size={15} aria-hidden="true" /></button><button type="button" onClick={() => archive(kind, row)} aria-label={`Archive ${row.name}`} className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-destructive transition-colors hover:bg-destructive-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><Trash2 size={15} aria-hidden="true" /></button></td></tr>)}{!rows.length && <tr><td colSpan="4" className="py-5 text-center text-muted-foreground">No active {batch ? 'batches' : 'students'} yet.</td></tr>}</tbody></table></div>;
}
