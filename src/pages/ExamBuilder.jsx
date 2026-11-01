import { useCallback, useEffect, useRef, useState } from 'react';
import { Clipboard, FileText, Plus, Save, Upload, Wand2 } from 'lucide-react';
import Loader from '../components/Loader';
import { Button } from '../components/ui/Button';
import { Alert } from '../components/ui/Alert';

const FIELD = 'w-full rounded-[10px] border border-input bg-card px-3 text-sm text-ink placeholder:text-muted-foreground hover:border-hairline-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';
const CARD = 'rounded-2xl border border-border bg-card';

function Step({ n, title, hint }) {
  return <div className="flex items-center gap-3"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink text-sm font-bold text-lime" aria-hidden="true">{n}</span><div><h2 className="font-headline text-lg font-extrabold leading-tight text-ink">{title}</h2><p className="text-[13px] text-foreground-secondary">{hint}</p></div></div>;
}

const MAX_FILE_BYTES = 8 * 1024 * 1024;

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('Could not read that PDF.'));
    reader.readAsDataURL(file);
  });
}

function CopyButton({ value }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }
  return <Button type="button" variant="ghost" size="sm" onClick={copy} className="h-9 gap-1.5 px-3 text-[13px]"><Clipboard size={15} aria-hidden="true" />{copied ? 'Copied' : 'Copy'}</Button>;
}

export default function ExamBuilder() {
  const inputRef = useRef(null);
  const [file, setFile] = useState(null);
  const [notes, setNotes] = useState('');
  const [prompt, setPrompt] = useState('Create a balanced 40-mark examination paper. Include a mix of direct understanding, application, and higher-order questions.');
  const [state, setState] = useState('idle');
  const [error, setError] = useState('');
  const [ocrMeta, setOcrMeta] = useState(null);
  const [result, setResult] = useState(null);
  const [collections, setCollections] = useState([]);
  const [collectionId, setCollectionId] = useState('');
  const [collectionTitle, setCollectionTitle] = useState('');
  const [collectionSubject, setCollectionSubject] = useState('');
  const [collectionGrade, setCollectionGrade] = useState('');

  const request = useCallback(async (body) => {
    const response = await fetch('/api/exam', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Request failed.');
    return payload;
  }, []);

  const loadCollections = useCallback(async () => {
    const payload = await request({ action: 'list_collections' });
    setCollections(payload.collections || []);
  }, [request]);

  useEffect(() => { loadCollections().catch((err) => setError(err.message)); }, [loadCollections]);

  function applyCollection(payload) {
    setCollectionId(payload.collection.id);
    setNotes(payload.notes || '');
    setOcrMeta({ pages: payload.collection.pageCount, sources: payload.collection.sourceCount, edited: payload.hasEditedNotes });
    setFile(null); setResult(null);
  }

  async function chooseCollection(id) {
    setError(''); setState('load');
    try { applyCollection(await request({ action: 'load_collection', collectionId: id })); }
    catch (err) { setError(err.message); }
    finally { setState('idle'); }
  }

  async function createCollection() {
    setError(''); setState('create');
    try {
      const payload = await request({ action: 'create_collection', title: collectionTitle, subject: collectionSubject, grade: collectionGrade });
      applyCollection(payload); setCollectionTitle(''); setCollectionSubject(''); setCollectionGrade('');
      await loadCollections();
    } catch (err) { setError(err.message); }
    finally { setState('idle'); }
  }

  async function ensureCollection() {
    if (collectionId) return collectionId;
    const title = collectionTitle.trim() || 'Untitled note collection';
    const payload = await request({ action: 'create_collection', title, subject: collectionSubject, grade: collectionGrade });
    setCollectionId(payload.collection.id);
    setCollections((current) => [payload.collection, ...current]);
    setOcrMeta({ pages: 0, sources: 0, edited: false });
    setCollectionTitle(''); setCollectionSubject(''); setCollectionGrade('');
    return payload.collection.id;
  }

  function selectFile(selected) {
    setError(''); setResult(null); setOcrMeta(null);
    if (!selected) return;
    if (selected.type !== 'application/pdf') return setError('Please select a PDF.');
    if (selected.size > MAX_FILE_BYTES) return setError('For the demo, use a PDF smaller than 8 MB.');
    setFile(selected);
  }

  async function runOcr() {
    if (!file) return setError('Choose a PDF note pack first.');
    setState('ocr'); setError(''); setResult(null);
    try {
      const fileBase64 = await readAsBase64(file);
      const targetCollectionId = await ensureCollection();
      const payload = await request({ action: 'ocr', collectionId: targetCollectionId, filename: file.name, mimeType: file.type, fileBase64 });
      applyCollection(payload); await loadCollections();
    } catch (err) { setError(err.message); } finally { setState('idle'); }
  }

  async function generate() {
    if (!notes.trim()) return setError('Extract notes or paste material first.');
    setState('generate'); setError('');
    try {
      const targetCollectionId = await ensureCollection();
      await request({ action: 'save_notes', collectionId: targetCollectionId, notes });
      setOcrMeta((current) => ({ ...current, edited: true }));
      setResult(await request({ action: 'generate', collectionId: targetCollectionId, notes, prompt }));
    } catch (err) { setError(err.message); } finally { setState('idle'); }
  }

  async function saveNotes() {
    if (!collectionId || !notes.trim()) return;
    setState('save'); setError('');
    try {
      await request({ action: 'save_notes', collectionId, notes });
      setOcrMeta((current) => ({ ...current, edited: true })); await loadCollections();
    } catch (err) { setError(err.message); }
    finally { setState('idle'); }
  }

  const working = state !== 'idle';
  return (
    <main className="min-h-screen bg-background text-ink">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 sm:px-8">
          <span className="font-headline text-[22px] font-extrabold leading-none tracking-[-0.03em] text-ink" aria-hidden="true">skyll<span className="text-coral">.</span></span>
          <div className="min-w-0 border-l border-border pl-3"><p className="text-[15px] font-semibold">Exam Studio</p><p className="truncate text-[12px] text-muted-foreground">Admin workspace for source-grounded assessment design</p></div>
        </div>
      </header>
      <div className="mx-auto max-w-6xl px-4 pb-14 pt-8 sm:px-8 sm:pt-10">
        <div className="mb-8 max-w-2xl"><p className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">Exam workspace</p><h1 className="mt-1 font-headline text-[32px] font-extrabold leading-[1.05] tracking-[-0.03em] sm:text-[44px]">Turn notes into a ready-to-review paper.</h1><p className="mt-3 text-[15px] leading-relaxed text-foreground-secondary">Source PDFs are stored privately, OCR runs once with Mistral, and saved material is reused by DeepSeek V4 Flash whenever you create a paper.</p></div>
        {error && <Alert variant="destructive" className="mb-6">{error}</Alert>}
        <section className={`mb-5 p-5 ${CARD}`}>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto]"><div><label className="text-sm font-semibold" htmlFor="note-collection">Note collection</label><select id="note-collection" value={collectionId} onChange={(event) => chooseCollection(event.target.value)} disabled={working} className={`mt-2 h-11 cursor-pointer ${FIELD}`}><option value="">Select saved notes</option>{collections.map((collection) => <option key={collection.id} value={collection.id}>{collection.title}{collection.subject ? ` · ${collection.subject}` : ''}{collection.grade ? ` · ${collection.grade}` : ''} ({collection.sourceCount} source{collection.sourceCount === 1 ? '' : 's'})</option>)}</select></div><div className="self-end pb-2.5 text-[13px] text-foreground-secondary">{state === 'load' ? 'Loading notes...' : collectionId ? 'Saved privately for this school' : 'Create a collection to begin'}</div></div>
          <div className="mt-4 grid gap-3 border-t border-border pt-4 md:grid-cols-[minmax(0,1fr)_10rem_9rem_auto]"><input aria-label="New collection name" value={collectionTitle} onChange={(event) => setCollectionTitle(event.target.value)} className={`h-11 ${FIELD}`} placeholder="New collection name" /><input aria-label="Subject" value={collectionSubject} onChange={(event) => setCollectionSubject(event.target.value)} className={`h-11 ${FIELD}`} placeholder="Subject" /><input aria-label="Class / grade" value={collectionGrade} onChange={(event) => setCollectionGrade(event.target.value)} className={`h-11 ${FIELD}`} placeholder="Class / grade" /><Button type="button" variant="secondary" onClick={createCollection} disabled={working || !collectionTitle.trim()} className="h-11 gap-2"><Plus size={17} aria-hidden="true" />Create</Button></div>
        </section>
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          <section className="flex flex-col gap-5">
            <div className={`p-5 ${CARD}`}>
              <Step n="1" title="Add source notes" hint="One PDF, up to 8 MB" />
              <input ref={inputRef} className="hidden" type="file" accept="application/pdf" onChange={(event) => selectFile(event.target.files?.[0])} />
              <button type="button" onClick={() => inputRef.current?.click()} className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl border-[1.5px] border-dashed border-hairline-strong bg-paper-soft px-4 py-8 text-sm font-semibold text-foreground-secondary transition-colors hover:border-ink hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><Upload size={18} aria-hidden="true" /><span className="min-w-0 truncate">{file ? file.name : 'Choose PDF notes'}</span></button>
              {file && <Button type="button" variant="outline" disabled={working} onClick={runOcr} className="mt-3 h-11 w-full gap-2">{state === 'ocr' ? <Loader size="inline" /> : <FileText size={17} aria-hidden="true" />}{state === 'ocr' ? 'Extracting and saving with Mistral...' : 'Extract and save notes'}</Button>}
            </div>
            <div className={`p-5 ${CARD}`}>
              <Step n="2" title="Set the paper brief" hint="Tell the generator what good looks like" />
              <textarea aria-label="Paper brief" value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={7} className={`mt-5 resize-y py-2.5 leading-6 ${FIELD}`} placeholder="Example: Class 10 Chemistry, 60 minutes, 30 marks..." />
              <Button type="button" disabled={working || !notes.trim()} onClick={generate} className="mt-3 h-11 w-full gap-2">{state === 'generate' ? <Loader size="inline" /> : <Wand2 size={17} aria-hidden="true" />}{state === 'generate' ? 'Designing the paper...' : 'Generate exam and solutions'}</Button>
            </div>
          </section>
          <section className={`flex flex-col overflow-hidden ${CARD}`}>
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3"><h2 className="font-headline text-lg font-extrabold">Working material</h2><div className="flex items-center gap-3">{ocrMeta && <span className="text-[12px] tabular-nums text-foreground-secondary">{ocrMeta.pages} page{ocrMeta.pages === 1 ? '' : 's'} · {ocrMeta.sources || 0} source{ocrMeta.sources === 1 ? '' : 's'}{ocrMeta.edited ? ' · edited' : ''}</span>}<Button type="button" variant="ghost" size="sm" onClick={saveNotes} disabled={working || !collectionId || !notes.trim()} className="h-9 gap-1.5 px-3 text-[13px]"><Save size={14} aria-hidden="true" />{state === 'save' ? 'Saving...' : 'Save edits'}</Button></div></div>
            <textarea aria-label="Working material" value={notes} onChange={(event) => setNotes(event.target.value)} className="min-h-[520px] w-full flex-1 resize-y p-5 font-data text-[13px] leading-6 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" placeholder="Extracted notes will appear here. You can also paste notes directly for the demo." />
          </section>
        </div>
        {result && <section className="mt-8 grid gap-5 lg:grid-cols-2"><article className={CARD}><div className="flex items-center justify-between border-b border-border px-5 py-3"><h2 className="font-headline text-lg font-extrabold">Exam paper</h2><CopyButton value={result.paper} /></div><pre className="whitespace-pre-wrap p-5 font-sans text-sm leading-7 text-foreground">{result.paper}</pre></article><article className={CARD}><div className="flex items-center justify-between border-b border-border px-5 py-3"><h2 className="font-headline text-lg font-extrabold">Solutions and marking guide</h2><CopyButton value={result.solutions} /></div><pre className="whitespace-pre-wrap p-5 font-sans text-sm leading-7 text-foreground">{result.solutions}</pre></article></section>}
      </div>
    </main>
  );
}
