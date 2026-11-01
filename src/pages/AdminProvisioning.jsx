import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Download, Plus, Trash2, Upload } from 'lucide-react';
import { Button } from '../components/ui/Button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../components/ui/Card';
import { Input } from '../components/ui/Input';
import { Select } from '../components/ui/Select';
import { Alert, AlertTitle, AlertDescription } from '../components/ui/Alert';
import { StatusBadge } from '../components/ui/StatusBadge';

export default function AdminProvisioning() {
  const navigate = useNavigate();
  const [step, setStep] = useState('school'); // 'school' | 'roster' | 'done'
  const [schoolResult, setSchoolResult] = useState(null);

  // School form
  const [slug, setSlug] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [institutionType, setInstitutionType] = useState('coaching');
  const [adminUsername, setAdminUsername] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [schoolLoading, setSchoolLoading] = useState(false);
  const [schoolError, setSchoolError] = useState('');

  // Roster form
  const [batches, setBatches] = useState([{ label: '', grade: '', board: '' }]);
  const [students, setStudents] = useState([{ displayName: '', batchLabel: '', parentPhone: '' }]);
  const [rosterLoading, setRosterLoading] = useState(false);
  const [rosterError, setRosterError] = useState('');
  const [credentials, setCredentials] = useState(null);

  async function createSchool(e) {
    e.preventDefault();
    setSchoolLoading(true);
    setSchoolError('');
    try {
      const res = await fetch('/api/auth/schools/provision', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, displayName, institutionType, adminUsername, adminPassword }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create school');
      setSchoolResult(data);
      setStep('roster');
    } catch (err) {
      setSchoolError(err.message);
    } finally {
      setSchoolLoading(false);
    }
  }

  function addBatch() {
    setBatches([...batches, { label: '', grade: '', board: '' }]);
  }

  function removeBatch(index) {
    setBatches(batches.filter((_, i) => i !== index));
  }

  function updateBatch(index, field, value) {
    const updated = [...batches];
    updated[index] = { ...updated[index], [field]: value };
    setBatches(updated);
  }

  function addStudent() {
    setStudents([...students, { displayName: '', batchLabel: '', parentPhone: '' }]);
  }

  function removeStudent(index) {
    setStudents(students.filter((_, i) => i !== index));
  }

  function updateStudent(index, field, value) {
    const updated = [...students];
    updated[index] = { ...updated[index], [field]: value };
    setStudents(updated);
  }

  function parseCsv(text) {
    const lines = text.trim().split('\n');
    if (lines.length < 2) return;
    const headers = lines[0].split(',').map((h) => h.trim().toLowerCase());
    const nameIdx = headers.findIndex((h) => h === 'name' || h === 'display_name' || h === 'student');
    const batchIdx = headers.findIndex((h) => h === 'batch' || h === 'batch_label' || h === 'class');
    const phoneIdx = headers.findIndex((h) => h === 'parent_phone' || h === 'phone' || h === 'parent phone' || h === 'whatsapp' || h === 'contact');
    if (nameIdx === -1) return;
    const parsed = [];
    for (let i = 1; i < lines.length; i++) {
      const cells = lines[i].split(',').map((c) => c.trim());
      if (cells[nameIdx]) {
        parsed.push({
          displayName: cells[nameIdx],
          batchLabel: batchIdx >= 0 ? cells[batchIdx] || '' : '',
          parentPhone: phoneIdx >= 0 ? cells[phoneIdx] || '' : '',
        });
      }
    }
    if (parsed.length) setStudents(parsed);
  }

  function handleCsvUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => parseCsv(event.target.result);
    reader.readAsText(file);
    e.target.value = '';
  }

  async function importRoster(e) {
    e.preventDefault();
    if (!schoolResult) return;
    setRosterLoading(true);
    setRosterError('');
    try {
      const validBatches = batches.filter((b) => b.label);
      const validStudents = students.filter((s) => s.displayName);
      if (!validBatches.length || !validStudents.length) {
        throw new Error('Add at least one batch and one student');
      }
      const res = await fetch('/api/auth/schools/roster', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schoolId: schoolResult.schoolId,
          schoolName: schoolResult.displayName,
          batches: validBatches,
          students: validStudents,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to import roster');
      setCredentials(data.credentials);
      setStep('done');
    } catch (err) {
      setRosterError(err.message);
    } finally {
      setRosterLoading(false);
    }
  }

  function downloadCredentials() {
    if (!credentials) return;
    const csvRows = ['Name,Login ID,Password,Batch,Parent Phone'];
    for (const c of credentials) {
      csvRows.push(`"${c.displayName}","${c.loginId}","${c.password}","${(c.batches || []).join('; ')}","${c.parentPhone || ''}"`);
    }
    const blob = new Blob([csvRows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${slug}-credentials.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex h-14 max-w-4xl items-center px-4 sm:px-8">
          <Button variant="ghost" onClick={() => navigate('/admin-dashboard')} className="-ml-2 h-9 gap-1.5 px-2.5 text-sm text-foreground-secondary hover:text-foreground">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />Operations
          </Button>
        </div>
      </header>

      <div className="mx-auto max-w-4xl px-4 pb-14 pt-8 sm:px-8 sm:pt-10">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="font-headline text-[32px] font-extrabold leading-[1.05] tracking-[-0.03em] text-ink sm:text-[44px]">Provision Institute</h1>
            <p className="text-sm text-foreground-secondary">Create a new school and import students</p>
          </div>
          <ol className="flex items-center gap-1.5" aria-label="Progress">
            {[['school', '1. School'], ['roster', '2. Roster'], ['done', '3. Done']].map(([key, text], index) => {
              const order = ['school', 'roster', 'done'];
              const current = order.indexOf(step);
              const done = index < current || step === 'done';
              const active = key === step && step !== 'done';
              return (
                <li key={key} aria-current={active ? 'step' : undefined}>
                  {done
                    ? <StatusBadge status="positive">{text}</StatusBadge>
                    : <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold leading-none ${active ? 'bg-ink text-lime' : 'bg-sunken text-foreground-secondary'}`}>{text}</span>}
                </li>
              );
            })}
          </ol>
        </div>
        {step === 'school' && (
          <Card>
            <CardHeader>
              <CardTitle className="text-[21px] font-extrabold">Create Institute</CardTitle>
              <CardDescription>Set up the school slug, display name, and admin credentials.</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={createSchool} className="space-y-5">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label htmlFor="prov-slug" className="mb-2 block text-sm font-semibold text-foreground">Slug</label>
                    <Input id="prov-slug" value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} placeholder="e.g. partner-academy-c" className="h-11" required />
                    <p className="mt-1 text-xs text-muted-foreground">Login URL: skyllai.com/{slug || '...'} — lowercase, hyphens only</p>
                  </div>
                  <div>
                    <label htmlFor="prov-name" className="mb-2 block text-sm font-semibold text-foreground">Display Name</label>
                    <Input id="prov-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="e.g. Partner Academy C" className="h-11" required />
                  </div>
                </div>
                <div>
                  <label htmlFor="prov-type" className="mb-2 block text-sm font-semibold text-foreground">Institution Type</label>
                  <Select id="prov-type" value={institutionType} onChange={(e) => setInstitutionType(e.target.value)} className="h-11">
                    <option value="coaching">Coaching Institute</option>
                    <option value="school">K-12 School</option>
                  </Select>
                </div>
                <div className="border-t border-border pt-5">
                  <p className="mb-4 text-[15px] font-bold text-ink">Admin Credentials</p>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <label htmlFor="prov-admin" className="mb-2 block text-sm font-semibold text-foreground">Username</label>
                      <Input id="prov-admin" value={adminUsername} onChange={(e) => setAdminUsername(e.target.value)} placeholder="admin" className="h-11" required />
                    </div>
                    <div>
                      <label htmlFor="prov-password" className="mb-2 block text-sm font-semibold text-foreground">Password</label>
                      <Input id="prov-password" type="password" value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} placeholder="Min 8 characters" className="h-11" required minLength={8} />
                    </div>
                  </div>
                </div>
                {schoolError && <Alert variant="destructive"><AlertDescription>{schoolError}</AlertDescription></Alert>}
                <Button type="submit" disabled={schoolLoading} className="h-11 w-full">
                  {schoolLoading ? 'Creating...' : 'Create Institute'}
                </Button>
              </form>
            </CardContent>
          </Card>
        )}

        {step === 'roster' && schoolResult && (
          <div className="space-y-6">
            <Alert variant="success">
              <AlertTitle>Institute created</AlertTitle>
              <AlertDescription>
                {schoolResult.displayName} is live at <code className="rounded bg-card px-1.5 py-0.5 font-data text-[12px]">/{schoolResult.slug}</code>. Admin login: <strong>{schoolResult.adminUsername}</strong>
              </AlertDescription>
            </Alert>

            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="text-[21px] font-extrabold">Import Roster</CardTitle>
                  <label className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-[10px] border border-border bg-card px-3 text-[13px] font-semibold text-foreground hover:border-hairline-strong focus-within:ring-2 focus-within:ring-ring">
                    <Upload className="h-4 w-4" aria-hidden="true" />
                    Upload CSV
                    <input type="file" accept=".csv" className="sr-only" onChange={handleCsvUpload} />
                  </label>
                </div>
                <CardDescription>Add batches and students. CSV format: Name,Batch,ParentPhone</CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={importRoster} className="space-y-6">
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <p className="text-[15px] font-bold text-ink">Batches</p>
                      <Button type="button" variant="secondary" size="sm" onClick={addBatch} className="h-8 gap-1"><Plus size={14} aria-hidden="true" />Add</Button>
                    </div>
                    <div className="space-y-3">
                      {batches.map((batch, i) => (
                        <div key={i} className="flex flex-wrap items-start gap-2 border-b border-border pb-3 last:border-b-0 sm:flex-nowrap sm:border-b-0 sm:pb-0">
                          <Input value={batch.label} onChange={(e) => updateBatch(i, 'label', e.target.value)} aria-label={`Batch ${i + 1} name`} placeholder="e.g. 10th CBSE 2026-27" className="h-10 basis-full sm:flex-1 sm:basis-auto" required />
                          <Input value={batch.grade} onChange={(e) => updateBatch(i, 'grade', e.target.value)} aria-label={`Batch ${i + 1} grade`} placeholder="Grade" className="h-10 w-20" />
                          <Input value={batch.board} onChange={(e) => updateBatch(i, 'board', e.target.value)} aria-label={`Batch ${i + 1} board`} placeholder="Board" className="h-10 w-24" />
                          {batches.length > 1 && <Button type="button" variant="ghost" size="icon" onClick={() => removeBatch(i)} aria-label={`Remove batch ${i + 1}`} className="h-10 w-10 shrink-0 text-muted-foreground hover:text-destructive"><Trash2 size={15} aria-hidden="true" /></Button>}
                        </div>
                      ))}
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <p className="text-[15px] font-bold text-ink">Students <span className="tabular-nums text-foreground-secondary">({students.length})</span></p>
                      <Button type="button" variant="secondary" size="sm" onClick={addStudent} className="h-8 gap-1"><Plus size={14} aria-hidden="true" />Add</Button>
                    </div>
                    <div className="space-y-2 max-h-80 overflow-y-auto">
                      {students.map((student, i) => (
                        <div key={i} className="flex flex-wrap items-center gap-2 border-b border-border pb-2 last:border-b-0 sm:flex-nowrap sm:border-b-0 sm:pb-0">
                          <Input value={student.displayName} onChange={(e) => updateStudent(i, 'displayName', e.target.value)} aria-label={`Student ${i + 1} name`} placeholder="Student name" className="h-10 basis-full sm:flex-1 sm:basis-auto" required />
                          <Input value={student.parentPhone} onChange={(e) => updateStudent(i, 'parentPhone', e.target.value)} aria-label={`Student ${i + 1} parent WhatsApp`} placeholder="Parent WhatsApp" className="h-10 min-w-0 flex-1 sm:w-36 sm:flex-none" inputMode="tel" />
                          <Select value={student.batchLabel} onChange={(e) => updateStudent(i, 'batchLabel', e.target.value)} aria-label={`Student ${i + 1} batch`} className="h-10 min-w-0 flex-1 sm:w-44 sm:flex-none">
                            <option value="">Select batch</option>
                            {batches.filter((b) => b.label).map((b) => <option key={b.label} value={b.label}>{b.label}</option>)}
                          </Select>
                          {students.length > 1 && <Button type="button" variant="ghost" size="icon" onClick={() => removeStudent(i)} aria-label={`Remove student ${i + 1}`} className="h-10 w-10 shrink-0 text-muted-foreground hover:text-destructive"><Trash2 size={15} aria-hidden="true" /></Button>}
                        </div>
                      ))}
                    </div>
                  </div>

                  {rosterError && <Alert variant="destructive"><AlertDescription>{rosterError}</AlertDescription></Alert>}
                  <Button type="submit" disabled={rosterLoading} className="h-11 w-full">
                    {rosterLoading ? 'Importing...' : `Import ${students.filter((s) => s.displayName).length} Students`}
                  </Button>
                </form>
              </CardContent>
            </Card>
          </div>
        )}

        {step === 'done' && credentials && (
          <div className="space-y-6">
            <Alert variant="success">
              <AlertTitle>Roster imported</AlertTitle>
              <AlertDescription>{credentials.length} students created with login credentials.</AlertDescription>
            </Alert>

            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="text-[21px] font-extrabold">Student Credentials</CardTitle>
                  <Button size="sm" onClick={downloadCredentials} className="h-9 gap-1.5 px-3.5">
                    <Download size={15} aria-hidden="true" />Download CSV
                  </Button>
                </div>
                <CardDescription>Share these login credentials with the institute admin.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                        <th className="pb-2 pr-4 font-semibold">Name</th>
                        <th className="pb-2 pr-4 font-semibold">Login ID</th>
                        <th className="pb-2 pr-4 font-semibold">Password</th>
                        <th className="pb-2 font-semibold">Batch</th>
                      </tr>
                    </thead>
                    <tbody>
                      {credentials.map((c) => (
                        <tr key={c.studentId} className="border-b border-border last:border-b-0">
                          <td className="py-2.5 pr-4 font-semibold text-ink">{c.displayName}</td>
                          <td className="py-2.5 pr-4 font-data text-[12px]">{c.loginId}</td>
                          <td className="py-2.5 pr-4 font-data text-[12px]">{c.password}</td>
                          <td className="py-2.5 text-foreground-secondary">{(c.batches || []).join(', ')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>

            <div className="flex gap-3">
              <Button variant="secondary" onClick={() => navigate('/admin-dashboard')} className="h-11 flex-1">
                Back to Dashboard
              </Button>
              <Button onClick={() => { setStep('school'); setSchoolResult(null); setCredentials(null); setSlug(''); setDisplayName(''); setAdminUsername(''); setAdminPassword(''); setBatches([{ label: '', grade: '', board: '' }]); setStudents([{ displayName: '', batchLabel: '', parentPhone: '' }]); }} className="h-11 flex-1">
                Provision Another
              </Button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
