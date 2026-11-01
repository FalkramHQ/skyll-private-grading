import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Ban, CheckCircle2, Download, Eye, Pencil, Plus, ReceiptText, RefreshCw, Save, Undo2, X } from 'lucide-react';
import { Button } from '../components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/Card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/Dialog';
import { Input } from '../components/ui/Input';
import { Select } from '../components/ui/Select';
import { Alert } from '../components/ui/Alert';
import { Badge } from '../components/ui/Badge';
import { StatusBadge } from '../components/ui/StatusBadge';
import Loader from '../components/Loader';
import { useSession } from '../lib/auth';
import { formatLineRate, invoicePdfFilename, periodLabel, shortDate as dateLabel } from '../../shared/invoiceFormat.js';

async function request(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'Request failed.');
  return payload;
}

const EMPTY_FORM = { legalName: '', address: '', gstin: '', pan: '', placeOfSupply: '' };
const MAX_BANDS = 10;
const bandRows = (bands = []) => bands.map((band) => ({ maxMarks: String(band.maxMarks), price: (band.pricePaise / 100).toFixed(2) }));

/** Band rows from the form → [{ maxMarks, pricePaise }]; fully empty rows are ignored. */
function bandsFromRows(rows) {
  const filled = rows.filter((row) => String(row.maxMarks).trim() || String(row.price).trim());
  if (filled.some((row) => !String(row.maxMarks).trim() || !String(row.price).trim())) throw new Error('Each price band needs both a marks limit and a price.');
  return filled.map((row) => ({ maxMarks: Number(row.maxMarks), pricePaise: Math.round(Number(row.price) * 100) }));
}
const label = 'mb-1 block text-sm font-medium';
const FILTER_LABEL = 'mb-1 block text-[13px] font-semibold text-foreground-secondary';
const CARD_TITLE = 'text-[21px] font-extrabold';

function ProfileDialog({ school, states, onClose, onSaved }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [bands, setBands] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const profile = school?.profile;
    setForm(profile ? { legalName: profile.legalName, address: profile.address, gstin: profile.gstin || '', pan: profile.pan || '', placeOfSupply: profile.placeOfSupply } : EMPTY_FORM);
    setBands(bandRows(school?.bands));
    setError('');
  }, [school]);

  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const setBand = (index, key) => (event) => setBands((current) => current.map((row, i) => (i === index ? { ...row, [key]: event.target.value } : row)));

  async function submit(event) {
    event.preventDefault();
    setSaving(true); setError('');
    try {
      const payload = await request('/api/auth/billing-profiles', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schoolId: school.id, ...form, bands: bandsFromRows(bands) }) });
      onSaved(school.id, payload);
    } catch (requestError) { setError(requestError.message); } finally { setSaving(false); }
  }

  return <Dialog open={Boolean(school)} onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="max-w-xl">
      <DialogHeader><DialogTitle>Billing profile · {school?.name}</DialogTitle><DialogDescription>Printed in the invoice&apos;s Bill To block. GSTIN and PAN are optional for institutes that are not GST-registered.</DialogDescription></DialogHeader>
      <form onSubmit={submit} className="grid gap-4">
        <div><label htmlFor="billing-legal-name" className={label}>Legal name</label><Input id="billing-legal-name" value={form.legalName} onChange={set('legalName')} placeholder="Alpha Classes Pvt Ltd" required maxLength={200} /></div>
        <div><label htmlFor="billing-address" className={label}>Address</label><textarea id="billing-address" value={form.address} onChange={set('address')} rows={4} required maxLength={500} placeholder={'Office 4, FC Road\nPune 411004'} className="flex w-full rounded-[10px] border border-input bg-card px-3 py-2 text-sm text-foreground ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" /></div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div><label htmlFor="billing-gstin" className={label}>GSTIN <span className="text-muted-foreground">(optional)</span></label><Input id="billing-gstin" value={form.gstin} onChange={set('gstin')} placeholder="27ABCDE1234F1Z5" maxLength={15} className="font-mono uppercase" /></div>
          <div><label htmlFor="billing-pan" className={label}>PAN <span className="text-muted-foreground">(optional)</span></label><Input id="billing-pan" value={form.pan} onChange={set('pan')} placeholder="ABCDE1234F" maxLength={10} className="font-mono uppercase" /></div>
        </div>
        <div><label htmlFor="billing-state" className={label}>Place of supply</label><Select id="billing-state" value={form.placeOfSupply} onChange={set('placeOfSupply')} required><option value="">Select a state or union territory</option>{states.map((state) => <option key={state} value={state}>{state}</option>)}</Select></div>
        <fieldset className="grid gap-2 rounded-xl border border-border p-3">
          <legend className="px-1 text-sm font-medium">Pricing</legend>
          <p className="text-xs text-muted-foreground">{bands.length ? 'Each paper is billed at the first band whose limit covers its total marks. Papers above the top band block invoice generation.' : 'Default: ₹0.25 per mark. Add bands to price this school per paper by exam total.'}</p>
          {bands.map((row, index) => <div key={index} className="flex items-end gap-2">
            <div className="flex-1"><label htmlFor={`band-marks-${index}`} className="mb-1 block text-xs text-muted-foreground">Up to (marks)</label><Input id={`band-marks-${index}`} type="number" min={1} max={1000} step={1} value={row.maxMarks} onChange={setBand(index, 'maxMarks')} placeholder="40" /></div>
            <div className="flex-1"><label htmlFor={`band-price-${index}`} className="mb-1 block text-xs text-muted-foreground">Price per paper (₹)</label><Input id={`band-price-${index}`} type="number" min={0.01} step={0.01} value={row.price} onChange={setBand(index, 'price')} placeholder="10.00" /></div>
            <Button type="button" variant="ghost" size="sm" onClick={() => setBands((current) => current.filter((_, i) => i !== index))} aria-label={`Remove band ${index + 1}`}><X size={14} /></Button>
          </div>)}
          <Button type="button" variant="outline" size="sm" onClick={() => setBands((current) => [...current, { maxMarks: '', price: '' }])} disabled={bands.length >= MAX_BANDS} className="gap-1 justify-self-start"><Plus size={14} />Add band</Button>
        </fieldset>
        {error && <Alert variant="destructive">{error}</Alert>}
        <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit" disabled={saving} className="gap-2">{saving ? <Loader size="inline" /> : <Save size={16} />}Save profile</Button></div>
      </form>
    </DialogContent>
  </Dialog>;
}

function BillingProfiles({ onSchools }) {
  const [data, setData] = useState({ schools: [], states: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setData(await request('/api/auth/billing-profiles')); } catch (requestError) { setError(requestError.message); } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);
  // The generate panel offers the schools whose profile is complete.
  useEffect(() => { onSchools?.(data.schools); }, [data.schools, onSchools]);

  function saved(schoolId, payload) {
    setData((current) => ({ ...current, schools: current.schools.map((school) => (school.id === schoolId ? { ...school, profile: payload.profile, complete: payload.complete, bands: payload.bands || [] } : school)) }));
    setEditing(null);
  }

  const ready = data.schools.filter((school) => school.complete).length;

  return <Card>
    <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div><CardTitle className={CARD_TITLE}>Billing profiles</CardTitle><CardDescription>Only schools with a complete profile are invoiced. Demo and internal schools stay without one. {!loading && `${ready} of ${data.schools.length} schools set up.`}</CardDescription></div>
      <Button variant="secondary" onClick={load} disabled={loading} className="gap-2">{loading ? <Loader size="inline" /> : <RefreshCw size={16} aria-hidden="true" />}Refresh</Button>
    </CardHeader>
    <CardContent>
      {error && <Alert variant="destructive" className="mb-4">{error}</Alert>}
      {loading && !data.schools.length ? <div className="flex justify-center py-10 text-muted-foreground"><Loader size="inline" /></div> : <div className="overflow-x-auto"><table className="w-full text-sm">
        <thead><tr className="border-b border-border text-left text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground"><th className="py-2 pr-3">School</th><th className="py-2 pr-3">Legal name</th><th className="py-2 pr-3">GSTIN</th><th className="py-2 pr-3">Place of supply</th><th className="py-2 pr-3">Profile</th><th className="py-2" /></tr></thead>
        <tbody>{data.schools.map((school) => <tr key={school.id} className="border-b border-border">
          <td className="py-2 pr-3 font-semibold text-ink">{school.name}{school.status !== 'active' && <span className="ml-2 text-[12px] font-normal text-muted-foreground">({school.status})</span>}</td>
          <td className="py-2 pr-3">{school.profile?.legalName || '—'}</td>
          <td className="py-2 pr-3 font-data text-[12px]">{school.profile?.gstin || '—'}</td>
          <td className="py-2 pr-3">{school.profile?.placeOfSupply || '—'}</td>
          <td className="py-2 pr-3"><div className="flex flex-wrap gap-1"><StatusBadge status={school.complete ? 'positive' : 'caution'}>{school.complete ? 'Complete' : 'Missing'}</StatusBadge><Badge variant="secondary">{school.bands?.length ? 'Custom pricing' : '₹0.25/mark'}</Badge></div></td>
          <td className="py-2 text-right"><Button variant="secondary" size="sm" onClick={() => setEditing(school)} className="h-8 gap-1" aria-label={`Edit billing profile for ${school.name}`}><Pencil size={14} />{school.profile ? 'Edit' : 'Add'}</Button></td>
        </tr>)}</tbody>
      </table></div>}
    </CardContent>
    <ProfileDialog school={editing} states={data.states} onClose={() => setEditing(null)} onSaved={saved} />
  </Card>;
}

// ── Invoices (FLKRM-486) ─────────────────────────────────────────────────────

const FIRST_PERIOD = '2026-09';
const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Paise → "₹1,23,456.75" (Indian digit grouping). */
const formatPaise = (paise) => inr.format(Number(paise || 0) / 100);
const istToday = () => new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);

/** Billable months from September 2026 to the current one (IST), newest first. */
function monthOptions() {
  const current = istToday().slice(0, 7);
  const months = [];
  for (let [year, month] = FIRST_PERIOD.split('-').map(Number); `${year}-${String(month).padStart(2, '0')}` <= current; month === 12 ? (year += 1, month = 1) : (month += 1)) {
    months.push(`${year}-${String(month).padStart(2, '0')}`);
  }
  return months.reverse().map((period) => ({ period, inProgress: period === current, label: period === current ? `${periodLabel(period)} (in progress)` : periodLabel(period) }));
}

/** Fetch the invoice PDF and save it; errors (e.g. PDFs not configured) come back as JSON. */
async function downloadInvoicePdf(invoice) {
  const response = await fetch(`/api/auth/invoices?id=${encodeURIComponent(invoice.id)}&format=pdf`, { credentials: 'same-origin' });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || 'Could not download the PDF.');
  }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = invoicePdfFilename(invoice.number);
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function DownloadButton({ invoice, onError }) {
  const [busy, setBusy] = useState(false);
  async function download() {
    setBusy(true); onError?.('');
    try { await downloadInvoicePdf(invoice); } catch (error) { onError?.(error.message); } finally { setBusy(false); }
  }
  return <Button variant="secondary" size="sm" onClick={download} disabled={busy} className="h-8 gap-1" aria-label={`Download ${invoice.number} PDF`}>{busy ? <Loader size="inline" /> : <Download size={14} aria-hidden="true" />}PDF</Button>;
}

const invoiceJson = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

function InvoiceStatus({ invoice }) {
  if (invoice.status === 'void') return <StatusBadge status="neutral">Void</StatusBadge>;
  return invoice.paidOn ? <StatusBadge status="positive">Paid</StatusBadge> : <StatusBadge status="caution">Unpaid</StatusBadge>;
}

function LinesTable({ lines, subtotalPaise, roundOffPaise, totalPaise }) {
  return <div className="overflow-x-auto"><table className="w-full text-sm">
    <thead><tr className="border-b border-border text-left text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground"><th className="py-2 pr-3">Exam</th><th className="py-2 pr-3">Date</th><th className="py-2 pr-3 text-right">Marks</th><th className="py-2 pr-3 text-right">Papers</th><th className="py-2 pr-3 text-right">Rate</th><th className="py-2 text-right">Amount</th></tr></thead>
    <tbody>
      {lines.map((line) => <tr key={`${line.examId}:${line.maxMarks}`} className="border-b border-border"><td className="py-2 pr-3 text-foreground">{line.examName}</td><td className="py-2 pr-3">{dateLabel(line.examDate)}</td><td className="py-2 pr-3 text-right">{line.maxMarks}</td><td className="py-2 pr-3 text-right">{line.papers}</td><td className="py-2 pr-3 text-right">{formatLineRate(line)}</td><td className="py-2 text-right">{formatPaise(line.amountPaise)}</td></tr>)}
      <tr><td colSpan={5} className="py-1 pr-3 text-right text-muted-foreground">Subtotal</td><td className="py-1 text-right">{formatPaise(subtotalPaise)}</td></tr>
      <tr><td colSpan={5} className="py-1 pr-3 text-right text-muted-foreground">Round-off</td><td className="py-1 text-right">{formatPaise(roundOffPaise)}</td></tr>
      <tr className="font-bold text-ink"><td colSpan={5} className="py-1.5 pr-3 text-right">Total</td><td className="py-1 text-right" data-testid="invoice-total">{formatPaise(totalPaise)}</td></tr>
    </tbody>
  </table></div>;
}

function GeneratePanel({ schools, onGenerated }) {
  const [months] = useState(monthOptions);
  const billable = schools.filter((school) => school.complete);
  const [schoolId, setSchoolId] = useState('');
  const [period, setPeriod] = useState(months.find((month) => !month.inProgress)?.period || months[0]?.period || FIRST_PERIOD);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => { setPreview(null); setError(''); }, [schoolId, period]);

  async function run(action) {
    setBusy(action); setError('');
    try {
      const payload = await request('/api/auth/invoices', invoiceJson({ action, schoolId, period }));
      if (action === 'preview') setPreview(payload.preview);
      else { setPreview(null); onGenerated(payload.invoice); }
    } catch (requestError) { setError(requestError.message); } finally { setBusy(''); }
  }

  return <Card>
    <CardHeader><CardTitle className={CARD_TITLE}>Generate an invoice</CardTitle><CardDescription>Papers whose report was built in the month (IST), at ₹0.25 per mark. Only completed months can be invoiced.</CardDescription></CardHeader>
    <CardContent className="grid gap-4">
      <div className="flex flex-wrap items-end gap-2">
        <div><label htmlFor="invoice-school" className={FILTER_LABEL}>School</label><Select id="invoice-school" value={schoolId} onChange={(event) => setSchoolId(event.target.value)} className="sm:w-64"><option value="">Select a school</option>{billable.map((school) => <option key={school.id} value={school.id}>{school.name}</option>)}</Select></div>
        <div><label htmlFor="invoice-month" className={FILTER_LABEL}>Month</label><Select id="invoice-month" value={period} onChange={(event) => setPeriod(event.target.value)} className="sm:w-56">{months.map((month) => <option key={month.period} value={month.period}>{month.label}</option>)}</Select></div>
        <Button variant="secondary" onClick={() => run('preview')} disabled={!schoolId || Boolean(busy)} className="gap-2">{busy === 'preview' ? <Loader size="inline" /> : <Eye size={16} />}Preview</Button>
      </div>
      {!billable.length && <p className="text-sm text-muted-foreground">No school has a complete billing profile yet. Add one below first.</p>}
      {error && <Alert variant="destructive">{error}</Alert>}
      {preview && <div className="grid gap-3 rounded-xl border border-border p-4">
        <p className="text-sm text-foreground"><span className="font-semibold">{preview.school}</span> · {periodLabel(preview.period)} · {preview.paperCount} paper{preview.paperCount === 1 ? '' : 's'}</p>
        {preview.lines.length > 0 && <LinesTable {...preview} />}
        {preview.blocker && <Alert>{preview.blocker.message}</Alert>}
        <Button onClick={() => run('generate')} disabled={!preview.canGenerate || Boolean(busy)} className="gap-2 justify-self-start">{busy === 'generate' ? <Loader size="inline" /> : <ReceiptText size={16} />}Generate invoice</Button>
      </div>}
    </CardContent>
  </Card>;
}

function InvoiceDialog({ invoiceId, onClose, onChanged }) {
  const [invoice, setInvoice] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [paidOn, setPaidOn] = useState(istToday());
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (!invoiceId) return;
    setInvoice(null); setError(''); setReason(''); setReference(''); setPaidOn(istToday());
    request(`/api/auth/invoices?id=${encodeURIComponent(invoiceId)}`).then((payload) => setInvoice(payload.invoice)).catch((requestError) => setError(requestError.message));
  }, [invoiceId]);

  async function act(action, extra = {}) {
    setBusy(action); setError('');
    try {
      const payload = await request('/api/auth/invoices', invoiceJson({ action, invoiceId, ...extra }));
      setInvoice(payload.invoice); onChanged(payload.invoice);
    } catch (requestError) { setError(requestError.message); } finally { setBusy(''); }
  }

  const live = invoice?.status === 'issued';
  return <Dialog open={Boolean(invoiceId)} onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
      <DialogHeader><DialogTitle>{invoice ? invoice.number : 'Invoice'}</DialogTitle><DialogDescription>{invoice ? `${invoice.school} · ${periodLabel(invoice.period)} · issued ${dateLabel(invoice.invoiceDate)} by ${invoice.issuedBy}` : 'Loading…'}</DialogDescription></DialogHeader>
      {error && <Alert variant="destructive">{error}</Alert>}
      {!invoice ? !error && <div className="flex justify-center py-8 text-muted-foreground"><Loader size="inline" /></div> : <div className="grid gap-5 text-sm">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">Bill to</p><p className="font-medium text-foreground">{invoice.billTo.legalName}</p><p className="whitespace-pre-line text-muted-foreground">{invoice.billTo.address}</p><p className="text-muted-foreground">GSTIN {invoice.billTo.gstin || '—'} · PAN {invoice.billTo.pan || '—'} · {invoice.billTo.placeOfSupply}</p></div><div className="flex items-center gap-2"><InvoiceStatus invoice={invoice} /><DownloadButton invoice={invoice} onError={setError} /></div></div>
        {invoice.status === 'void' && <Alert>Voided {dateLabel(invoice.voidedAt)} by {invoice.voidedBy}: {invoice.voidReason}</Alert>}
        <LinesTable {...invoice} />
        <details className="rounded-xl border border-border p-3"><summary className="cursor-pointer font-medium text-foreground">Billed papers ({invoice.papers.length})</summary><table className="mt-2 w-full text-sm"><thead><tr className="text-left text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground"><th className="py-1 pr-3">Student</th><th className="py-1 pr-3">Exam</th><th className="py-1 pr-3 text-right">Marks</th><th className="py-1 text-right">Amount</th></tr></thead><tbody>{invoice.papers.map((paper) => <tr key={paper.submissionId} className="border-t border-border"><td className="py-1 pr-3">{paper.studentName}</td><td className="py-1 pr-3">{invoice.lines.find((line) => line.examId === paper.examId)?.examName || paper.examId}</td><td className="py-1 pr-3 text-right">{paper.maxMarks}</td><td className="py-1 text-right">{formatPaise(paper.amountPaise)}</td></tr>)}</tbody></table></details>
        {live && (invoice.paidOn
          ? <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border p-3"><p>Paid on {dateLabel(invoice.paidOn)}{invoice.paidReference ? ` · ref ${invoice.paidReference}` : ''} · marked by {invoice.paidMarkedBy}</p><Button variant="secondary" size="sm" onClick={() => act('unmark-paid')} disabled={Boolean(busy)} className="gap-1">{busy === 'unmark-paid' ? <Loader size="inline" /> : <Undo2 size={14} />}Remove paid mark</Button></div>
          : <form onSubmit={(event) => { event.preventDefault(); act('mark-paid', { paidOn, reference }); }} className="flex flex-wrap items-end gap-2 rounded-xl border border-border p-3"><div><label htmlFor="paid-on" className={label}>Paid on</label><Input id="paid-on" type="date" value={paidOn} max={istToday()} onChange={(event) => setPaidOn(event.target.value)} required className="w-44" /></div><div><label htmlFor="paid-reference" className={label}>Reference <span className="text-muted-foreground">(UTR / cheque, optional)</span></label><Input id="paid-reference" value={reference} onChange={(event) => setReference(event.target.value)} maxLength={100} className="w-56" /></div><Button type="submit" disabled={Boolean(busy)} className="gap-2 h-10">{busy === 'mark-paid' ? <Loader size="inline" /> : <CheckCircle2 size={16} />}Mark paid</Button></form>)}
        {live && <form onSubmit={(event) => { event.preventDefault(); act('void', { reason }); }} className="grid gap-2 rounded-xl border border-destructive/40 p-3"><label htmlFor="void-reason" className="text-sm font-semibold text-destructive">Void this invoice</label><p className="text-xs text-muted-foreground">{invoice.paidOn ? 'Remove the paid mark before voiding.' : 'The number stays used. Its papers become billable again, so you can generate a replacement.'}</p><Input id="void-reason" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Reason (required)" maxLength={500} required disabled={Boolean(invoice.paidOn)} /><Button type="submit" variant="destructive" disabled={Boolean(busy) || Boolean(invoice.paidOn)} className="gap-2 justify-self-start">{busy === 'void' ? <Loader size="inline" /> : <Ban size={16} aria-hidden="true" />}Void invoice</Button></form>}
      </div>}
    </DialogContent>
  </Dialog>;
}

function Invoices({ schools }) {
  const [data, setData] = useState({ invoices: [], unpaid: [] });
  const [schoolId, setSchoolId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setData(await request(`/api/auth/invoices${schoolId ? `?schoolId=${encodeURIComponent(schoolId)}` : ''}`)); } catch (requestError) { setError(requestError.message); } finally { setLoading(false); }
  }, [schoolId]);

  useEffect(() => { load(); }, [load]);

  return <div className="grid gap-6">
    <GeneratePanel schools={schools} onGenerated={(invoice) => { load(); setOpenId(invoice.id); }} />
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div><CardTitle className={CARD_TITLE}>Invoices</CardTitle><CardDescription>Newest first. Open one to see its papers, mark it paid, or void it.</CardDescription></div>
        <div className="flex flex-wrap items-end gap-2"><div><label htmlFor="invoices-school" className={FILTER_LABEL}>School</label><Select id="invoices-school" value={schoolId} onChange={(event) => setSchoolId(event.target.value)} className="sm:w-64"><option value="">All schools</option>{schools.map((school) => <option key={school.id} value={school.id}>{school.name}</option>)}</Select></div><Button variant="secondary" onClick={load} disabled={loading} className="gap-2">{loading ? <Loader size="inline" /> : <RefreshCw size={16} aria-hidden="true" />}Refresh</Button></div>
      </CardHeader>
      <CardContent className="grid gap-4">
        {error && <Alert variant="destructive">{error}</Alert>}
        {data.unpaid.length > 0 && <div className="flex flex-wrap gap-2" aria-label="Unpaid totals">{data.unpaid.map((row) => <div key={row.schoolId} className="rounded-xl border border-warning/40 bg-warning-soft px-3.5 py-2.5 text-sm"><p className="text-[13px] text-warning-soft-foreground">{row.school} · {row.invoices} unpaid</p><p className="font-headline text-lg font-extrabold tabular-nums text-ink">{formatPaise(row.totalPaise)}</p></div>)}</div>}
        {loading && !data.invoices.length ? <div className="flex justify-center py-10 text-muted-foreground"><Loader size="inline" /></div> : data.invoices.length === 0 ? <p className="rounded-xl border border-dashed border-hairline-strong p-6 text-center text-sm text-muted-foreground">No invoices yet.</p> : <div className="overflow-x-auto"><table className="w-full text-sm">
          <thead><tr className="border-b border-border text-left text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground"><th className="py-2 pr-3">Number</th><th className="py-2 pr-3">School</th><th className="py-2 pr-3">Month</th><th className="py-2 pr-3">Issued</th><th className="py-2 pr-3 text-right">Papers</th><th className="py-2 pr-3 text-right">Total</th><th className="py-2 pr-3">Status</th><th className="py-2" /></tr></thead>
          <tbody>{data.invoices.map((invoice) => <tr key={invoice.id} className="border-b border-border"><td className="py-2 pr-3 font-data text-[12px]">{invoice.number}</td><td className="py-2 pr-3 text-foreground">{invoice.school}</td><td className="py-2 pr-3">{periodLabel(invoice.period)}</td><td className="py-2 pr-3">{dateLabel(invoice.invoiceDate)}</td><td className="py-2 pr-3 text-right">{invoice.paperCount}</td><td className="py-2 pr-3 text-right font-semibold tabular-nums text-ink">{formatPaise(invoice.totalPaise)}</td><td className="py-2 pr-3"><InvoiceStatus invoice={invoice} /></td><td className="py-2 text-right"><div className="flex justify-end gap-2"><DownloadButton invoice={invoice} onError={setError} /><Button variant="secondary" size="sm" onClick={() => setOpenId(invoice.id)} aria-label={`Open ${invoice.number}`} className="h-8">Open</Button></div></td></tr>)}</tbody>
        </table></div>}
      </CardContent>
    </Card>
    <InvoiceDialog invoiceId={openId} onClose={() => setOpenId(null)} onChanged={() => load()} />
  </div>;
}

export default function AdminInvoices() {
  const { user } = useSession();
  const role = user?.role || localStorage.getItem('userRole');
  const isPlatformAdmin = role === 'skyll_admin';
  const [schools, setSchools] = useState([]);

  return <main className="min-h-screen bg-background text-foreground">
    <header className="border-b border-border bg-card"><div className="mx-auto flex h-14 max-w-6xl items-center px-4 sm:px-8"><Button asChild variant="ghost" className="-ml-2 h-9 gap-1.5 px-2.5 text-sm text-foreground-secondary hover:text-foreground"><Link to="/admin-dashboard"><ArrowLeft size={16} aria-hidden="true" />Operations</Link></Button></div></header>
    <div className="mx-auto max-w-6xl px-4 pb-14 pt-8 sm:px-8 sm:pt-10">
      <div className="mb-6 flex flex-col gap-1"><h1 className="font-headline text-[32px] font-extrabold leading-[1.05] tracking-[-0.03em] text-ink sm:text-[44px]">Invoices</h1><p className="text-sm text-foreground-secondary">Monthly per-school invoices for graded papers, and the billing details they print.</p></div>
      {isPlatformAdmin ? <div className="grid gap-6"><Invoices schools={schools} /><BillingProfiles onSchools={setSchools} /></div> : <Alert variant="destructive">Invoices are available to platform admins only.</Alert>}
    </div>
  </main>;
}
