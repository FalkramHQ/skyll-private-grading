import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ExternalLink, Save } from 'lucide-react';
import {
  DEFAULT_VISUAL_REQUIREMENT,
  withSuggestedVisualRequirements,
} from '../../shared/visualRequirements.js';
import Loader from '../components/Loader';
import { Button } from '../components/ui/Button';
import { StatusBadge } from '../components/ui/StatusBadge';
import { cn } from '../lib/utils';

const FIELD_LABEL = 'block text-[13px] font-semibold text-foreground-secondary';
const FIELD = 'mt-1 w-full rounded-[10px] border border-input bg-card px-2.5 py-1.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:bg-paper-soft disabled:text-foreground-secondary';
const SMALL_FIELD = 'h-8 rounded-lg border border-input bg-card px-2 text-[13px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:bg-paper-soft';

const REF_TAB = 'h-8 rounded-full border px-3 text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const REF_TAB_ON = 'border-ink bg-ink text-lime';
const REF_TAB_OFF = 'border-hairline bg-card text-foreground-secondary hover:bg-paper-soft';

const RESPONSE_TYPES = ['mcq', 'numerical', 'short_answer', 'long_answer', 'diagram', 'table', 'proof', 'other'];

function hasVisualRequirement(question) {
  // null/undefined = off; any string (including draft empty) keeps the toggle visible.
  return question?.visual_requirements != null;
}

function prepareDraftQuestions(questions = []) {
  return questions.map((question) => withSuggestedVisualRequirements({ ...question }));
}

async function postRubricAction(action, body = {}) {
  const res = await fetch('/api/vl-queue', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText || 'Request failed');
  return data;
}

// Fetch into a blob URL so the preview is not blocked by X-Frame-Options: DENY
// on /api/images/* (global security headers). Open-in-tab still uses the API URL.
function ReferencePreview({ url, title, onUnauthorized }) {
  const [blobUrl, setBlobUrl] = useState('');
  const [status, setStatus] = useState('idle');
  const [loadError, setLoadError] = useState('');
  const blobUrlRef = useRef('');

  useEffect(() => {
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = '';
    }
    setBlobUrl('');

    if (!url) {
      setStatus('idle');
      setLoadError('');
      return undefined;
    }

    let cancelled = false;
    setStatus('loading');
    setLoadError('');

    (async () => {
      try {
        const res = await fetch(url, { credentials: 'same-origin' });
        if (res.status === 401) {
          onUnauthorized?.();
          throw new Error('Sign in required');
        }
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || res.statusText || 'Failed to load reference');
        }
        const nextUrl = URL.createObjectURL(await res.blob());
        if (cancelled) {
          URL.revokeObjectURL(nextUrl);
          return;
        }
        blobUrlRef.current = nextUrl;
        setBlobUrl(nextUrl);
        setStatus('ready');
      } catch (err) {
        if (cancelled) return;
        setLoadError(err.message || 'Failed to load reference');
        setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = '';
      }
    };
  }, [url, onUnauthorized]);

  if (!url) {
    return <p className="p-4 text-sm text-muted-foreground">Reference asset unavailable.</p>;
  }
  if (status === 'loading' || status === 'idle') {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader size="inline" /> Loading document…
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div className="space-y-2 p-4 text-sm text-muted-foreground">
        <p className="font-semibold text-destructive">{loadError || 'Could not load reference document.'}</p>
        <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold text-action hover:underline">
          Open in new tab <ExternalLink className="h-3 w-3" aria-hidden="true" />
        </a>
      </div>
    );
  }

  return <iframe title={title} src={blobUrl} className="h-full w-full border-0" />;
}

export default function RubricReviewPanel({
  initialTestId = '',
  onUnauthorized,
}) {
  const [items, setItems] = useState([]);
  const [selectedTestId, setSelectedTestId] = useState(initialTestId || '');
  const [pack, setPack] = useState(null);
  const [draftQuestions, setDraftQuestions] = useState([]);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingPack, setLoadingPack] = useState(false);
  const [saving, setSaving] = useState(false);
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refTab, setRefTab] = useState('question_paper');
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');

  const loadList = useCallback(async () => {
    setLoadingList(true);
    setError('');
    try {
      const res = await fetch('/api/vl-queue?rubricPending=true');
      if (res.status === 401) { onUnauthorized?.(); return; }
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      const next = data.items || [];
      setItems(next);
      if (!selectedTestId && next[0]?.testId) setSelectedTestId(next[0].testId);
      if (selectedTestId && !next.some((item) => item.testId === selectedTestId) && initialTestId === selectedTestId) {
        // Keep deep-linked test even if status already moved; pack load will show state.
      }
    } catch (err) {
      setError(err.message || 'Failed to load rubric queue');
    } finally {
      setLoadingList(false);
    }
  }, [initialTestId, onUnauthorized, selectedTestId]);

  const loadPack = useCallback(async (testId) => {
    if (!testId) { setPack(null); setDraftQuestions([]); return; }
    setLoadingPack(true);
    setError('');
    setNotice('');
    setOverrideOpen(false);
    setOverrideReason('');
    try {
      const res = await fetch(`/api/vl-queue?rubricTestId=${encodeURIComponent(testId)}`);
      if (res.status === 401) { onUnauthorized?.(); return; }
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setPack(data);
      setDraftQuestions(prepareDraftQuestions(data.rubric?.questions || []));
    } catch (err) {
      setError(err.message || 'Failed to load rubric');
      setPack(null);
      setDraftQuestions([]);
    } finally {
      setLoadingPack(false);
    }
  }, [onUnauthorized]);

  useEffect(() => { loadList(); }, [loadList]);
  useEffect(() => { loadPack(selectedTestId); }, [loadPack, selectedTestId]);

  const dirty = useMemo(() => {
    if (!pack) return false;
    return JSON.stringify(draftQuestions) !== JSON.stringify(pack.rubric?.questions || []);
  }, [draftQuestions, pack]);

  useEffect(() => {
    if (!dirty) return undefined;
    const onBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const updateQuestion = (index, patch) => {
    setDraftQuestions((prev) => prev.map((q, i) => (i === index ? { ...q, ...patch } : q)));
  };

  const setResponseType = (index, type) => {
    setDraftQuestions((prev) => prev.map((q, i) => {
      if (i !== index) return q;
      const next = { ...q, expected_response_type: type };
      // Diagram-type answers almost always need VL; turn it on unless already set.
      if (type === 'diagram' && q.visual_requirements == null) {
        next.visual_requirements = DEFAULT_VISUAL_REQUIREMENT;
      }
      return next;
    }));
  };

  // Key-check decisions (rubric gate): keep the key, accept the checker's answer as an
  // accepted alternative, or make it the key. "open" undoes a decision before saving.
  const resolveKeyCheck = (index, status) => {
    setDraftQuestions((prev) => prev.map((q, i) => {
      if (i !== index || !q.key_check) return q;
      const original = pack?.rubric?.questions?.[index];
      const checker = String(q.key_check.checker_answer || '');
      const next = { ...q, key_check: { ...q.key_check, status } };
      const alternatives = Array.isArray(original?.accepted_variations) ? original.accepted_variations : [];
      next.accepted_variations = status === 'alternative' && !alternatives.includes(checker) ? [...alternatives, checker] : alternatives;
      next.correct_answer_summary = status === 'corrected' ? checker : original?.correct_answer_summary ?? q.correct_answer_summary;
      return next;
    }));
  };

  const setNeedsVisual = (index, enabled) => {
    updateQuestion(index, {
      visual_requirements: enabled ? DEFAULT_VISUAL_REQUIREMENT : null,
    });
  };

  const saveEdits = async () => {
    if (!pack?.testId) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const data = await postRubricAction('save-rubric-review', {
        testId: pack.testId,
        questions: draftQuestions,
        exam: pack.rubric?.exam || {},
      });
      setPack(data);
      setDraftQuestions(prepareDraftQuestions(data.rubric?.questions || []));
      setNotice('Rubric edits saved.');
      await loadList();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const gate = pack?.gate?.enabled ? pack.gate : null;
  const gateErrors = gate?.errors || [];
  const gateWarnings = gate?.warnings || [];
  const minReason = gate?.overrideReasonMinChars || 15;
  const blockedByGate = gateErrors.length > 0;

  const approve = async ({ withOverride = false } = {}) => {
    if (!pack?.testId) return;
    if (dirty) {
      setError('Save rubric edits before marking for grading.');
      return;
    }
    setApproving(true);
    setError('');
    setNotice('');
    try {
      await postRubricAction('approve-rubric', {
        testId: pack.testId,
        ...(withOverride ? { overrideReason: overrideReason.trim() } : {}),
      });
      setOverrideOpen(false);
      setOverrideReason('');
      setNotice(withOverride
        ? 'Marked for grading with rubric errors. Your reason was saved with the approval.'
        : 'Marked for grading. Evidence + grading will start next.');
      await loadList();
      await loadPack(pack.testId);
    } catch (err) {
      setError(err.message);
    } finally {
      setApproving(false);
    }
  };

  const refUrl = refTab === 'answer_key'
    ? pack?.references?.answerKeyUrl
    : pack?.references?.questionPaperUrl;

  return (
    <div className="flex min-h-[640px] flex-col bg-background text-foreground md:h-[calc(100vh-3.5rem)] md:flex-row">
      <aside aria-label="Assessments awaiting rubric review" className="max-h-72 shrink-0 overflow-y-auto border-b border-border bg-card md:max-h-none md:w-72 md:border-b-0 md:border-r">
        <div className="sticky top-0 border-b border-border bg-card px-4 py-3">
          <p className="font-headline text-lg font-bold tracking-tight text-foreground">Rubric review</p>
          <p className="mt-0.5 text-[13px] text-foreground-secondary">Approve marking packages before grading.</p>
        </div>
        {loadingList ? (
          <div className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
            <Loader size="inline" /> Loading…
          </div>
        ) : items.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">No assessments waiting on rubric review.</p>
        ) : (
          <ul className="space-y-1 p-2">
            {items.map((item) => (
              <li key={item.testId}>
                <button
                  type="button"
                  onClick={() => setSelectedTestId(item.testId)}
                  aria-current={selectedTestId === item.testId ? 'true' : undefined}
                  className={cn(
                    'w-full rounded-[10px] border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    selectedTestId === item.testId ? 'border-2 border-ink bg-action-tint' : 'border-transparent hover:bg-paper-soft'
                  )}
                >
                  <div className="text-sm font-semibold text-foreground">{item.name}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {item.school} · {item.subject} · {item.grade}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground tabular-nums">
                    {item.questionCount || '—'} Q · {item.totalMarks || '—'} mapped marks
                    {item.effectiveTotalMarks != null && item.declaredTotalMarks != null && (
                      <span className={item.effectiveTotalMarks < item.declaredTotalMarks ? 'ml-1 font-semibold text-destructive' : ''}>
                        {' · '}{item.effectiveTotalMarks}/{item.declaredTotalMarks}
                        {item.effectiveTotalMarks < item.declaredTotalMarks ? ' under-covered' : ''}
                      </span>
                    )}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        {(error || notice) && (
          <div role={error ? 'alert' : 'status'} className={cn('border-b px-4 py-2 text-sm font-semibold', error ? 'border-destructive/30 bg-destructive-soft text-destructive-soft-foreground' : 'border-border bg-info-soft text-info')}>
            {error || notice}
          </div>
        )}

        {loadingPack ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader size="inline" /> Loading rubric…
          </div>
        ) : !pack ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Select an assessment to review its marking rubric.
          </div>
        ) : (
          <>
            <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-card px-4 py-3">
              <div className="min-w-0">
                <h2 className="font-headline text-xl font-bold tracking-tight text-foreground">{pack.name}</h2>
                <p className="text-[13px] text-muted-foreground">
                  {pack.school} · {pack.subject} · {pack.grade} · v{pack.rubric.version}
                  {!pack.awaitingRubricReview ? ' · not awaiting review' : ''}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={!dirty || saving || !pack.awaitingRubricReview}
                  onClick={saveEdits}
                >
                  {saving ? <Loader size="inline" /> : <Save className="h-4 w-4" aria-hidden="true" />}
                  Save edits
                </Button>
                <Button
                  type="button"
                  disabled={approving || dirty || !pack.awaitingRubricReview || blockedByGate}
                  title={blockedByGate ? 'Fix the rubric errors below, or approve with a reason' : undefined}
                  onClick={() => approve()}
                >
                  {approving ? <Loader size="inline" /> : <CheckCircle2 className="h-4 w-4" aria-hidden="true" />}
                  Mark for grading
                </Button>
                {blockedByGate && pack.awaitingRubricReview && (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={approving || dirty}
                    aria-expanded={overrideOpen}
                    aria-controls="rubric-override"
                    onClick={() => setOverrideOpen((open) => !open)}
                  >
                    Approve with errors…
                  </Button>
                )}
              </div>
            </header>

            <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-2">
              <div className="flex min-h-[420px] flex-col border-b border-border xl:min-h-0 xl:border-b-0 xl:border-r">
                <div role="group" aria-label="Reference document" className="flex items-center gap-1.5 border-b border-border bg-card px-3 py-2">
                  <button
                    type="button"
                    aria-pressed={refTab === 'question_paper'}
                    onClick={() => setRefTab('question_paper')}
                    className={cn(REF_TAB, refTab === 'question_paper' ? REF_TAB_ON : REF_TAB_OFF)}
                  >
                    Question paper
                  </button>
                  <button
                    type="button"
                    aria-pressed={refTab === 'answer_key'}
                    onClick={() => setRefTab('answer_key')}
                    className={cn(REF_TAB, refTab === 'answer_key' ? REF_TAB_ON : REF_TAB_OFF)}
                  >
                    Ideal answers
                  </button>
                  {refUrl && (
                    <a href={refUrl} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-[13px] font-semibold text-action hover:underline">
                      Open <ExternalLink className="h-3 w-3" aria-hidden="true" />
                    </a>
                  )}
                </div>
                <div className="min-h-0 flex-1 bg-sunken">
                  <ReferencePreview
                    url={refUrl}
                    title={refTab}
                    onUnauthorized={onUnauthorized}
                  />
                </div>
              </div>

              <div className="min-h-0 overflow-y-auto p-4">
                <div className="mb-3 space-y-2">
                  <div className="rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground-secondary tabular-nums">
                    {(pack.rubric.quality?.questionCount ?? draftQuestions.length)} questions
                    {' · '}
                    {(pack.rubric.quality?.totalMarks
                      ?? draftQuestions.reduce((sum, q) => sum + Number(q.marks_allocated || 0), 0))} mapped marks
                    {pack.rubric.exam?.optional_rules ? ` · ${pack.rubric.exam.optional_rules}` : ''}
                  </div>
                  {(pack.rubric.quality?.effectiveTotalMarks != null || pack.rubric.quality?.declaredTotalMarks != null) && (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-border bg-card px-3 py-2 text-[13px] text-foreground-secondary tabular-nums">
                      <span>
                        <span className="font-semibold text-foreground">Coverage:</span>{' '}
                        mapped {pack.rubric.quality.totalMarks ?? '—'}
                      </span>
                      {pack.rubric.quality.effectiveTotalMarks != null && (
                        <span>
                          effective <span className="font-semibold text-foreground">{pack.rubric.quality.effectiveTotalMarks}</span>
                        </span>
                      )}
                      {pack.rubric.quality.declaredTotalMarks != null && (
                        <span>
                          declared <span className="font-semibold text-foreground">{pack.rubric.quality.declaredTotalMarks}</span>
                        </span>
                      )}
                      {pack.rubric.quality.effectiveTotalMarks != null && pack.rubric.quality.declaredTotalMarks != null && (
                        <StatusBadge status={pack.rubric.quality.effectiveTotalMarks < pack.rubric.quality.declaredTotalMarks ? 'critical' : 'positive'}>
                          {pack.rubric.quality.effectiveTotalMarks < pack.rubric.quality.declaredTotalMarks ? 'under-covered — review required' : 'covered'}
                        </StatusBadge>
                      )}
                    </div>
                  )}
                  {gate && (gateErrors.length > 0 || gateWarnings.length > 0) && (
                    <section aria-label="Rubric checks" className="space-y-2">
                      {gateErrors.length > 0 && (
                        <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive-soft px-3 py-2 text-[13px] text-destructive-soft-foreground">
                          <p className="flex items-center gap-1.5 font-semibold">
                            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                            {gateErrors.length} {gateErrors.length === 1 ? 'error blocks' : 'errors block'} grading
                            {dirty ? ' (save to re-check your edits)' : ''}
                          </p>
                          <ul className="mt-1 list-disc space-y-0.5 pl-5">
                            {gateErrors.map((item, index) => (
                              <li key={`${item.code}-${index}`}>
                                {item.question ? <span className="font-semibold">{item.question}: </span> : null}
                                {item.message}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {gateWarnings.length > 0 && (
                        <ul className="list-disc space-y-0.5 rounded-xl border border-warning/30 bg-warning-soft py-2 pl-7 pr-3 text-[13px] text-warning-soft-foreground">
                          {gateWarnings.map((item, index) => (
                            <li key={`${item.code}-${index}`}>
                              {item.question ? <span className="font-semibold">{item.question}: </span> : null}
                              {item.message}
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>
                  )}
                  {gate && pack.rubric.keyCheck && (
                    <p className="rounded-xl border border-border bg-card px-3 py-2 text-[13px] text-foreground-secondary tabular-nums">
                      {pack.rubric.keyCheck.error
                        ? 'Independent key check did not run.'
                        : `Independent key check (${pack.rubric.keyCheck.model || 'second model'}): ${pack.rubric.keyCheck.checked} answers checked, ${pack.rubric.keyCheck.open ?? pack.rubric.keyCheck.disagreements} need a decision, ${pack.rubric.keyCheck.unsure} unsure.`}
                    </p>
                  )}
                  {overrideOpen && blockedByGate && (
                    <div id="rubric-override" className="space-y-2 rounded-xl border border-border bg-card px-3 py-3">
                      <label htmlFor="rubric-override-reason" className={FIELD_LABEL}>
                        Why is it safe to grade with these errors?
                      </label>
                      <textarea
                        id="rubric-override-reason"
                        value={overrideReason}
                        onChange={(e) => setOverrideReason(e.target.value)}
                        rows={2}
                        placeholder="For example: the paper prints 40 marks but its questions add up to 35; 35 is correct."
                        className={FIELD}
                      />
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {overrideReason.trim().length}/{minReason} characters minimum. Saved with the approval.
                        </span>
                        <Button
                          type="button"
                          disabled={approving || dirty || overrideReason.trim().length < minReason}
                          onClick={() => approve({ withOverride: true })}
                        >
                          {approving ? <Loader size="inline" /> : <CheckCircle2 className="h-4 w-4" aria-hidden="true" />}
                          Approve with errors
                        </Button>
                      </div>
                    </div>
                  )}
                  {Array.isArray(pack.rubric.quality?.warnings) && pack.rubric.quality.warnings.length > 0 && (
                    <ul className="list-disc space-y-0.5 rounded-xl border border-warning/30 bg-warning-soft py-2 pl-7 pr-3 text-[13px] text-warning-soft-foreground">
                      {pack.rubric.quality.warnings.map((warning, index) => <li key={index}>{warning}</li>)}
                    </ul>
                  )}
                </div>

                <div className="space-y-3">
                  {draftQuestions.map((q, index) => (
                    <article key={`${q.number}-${index}`} className="rounded-2xl border border-border bg-card p-3.5">
                      <div className="mb-2.5 flex flex-wrap items-center gap-2">
                        <span className="font-headline text-lg font-bold leading-none text-foreground">{q.number}</span>
                        <select
                          aria-label={`Response type for ${q.number}`}
                          value={q.expected_response_type || 'other'}
                          disabled={!pack.awaitingRubricReview}
                          onChange={(e) => setResponseType(index, e.target.value)}
                          className={SMALL_FIELD}
                        >
                          {RESPONSE_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                        </select>
                        {gate && (
                          <label className="ml-auto flex items-center gap-1.5 text-[13px] font-semibold text-foreground-secondary">
                            Step
                            <input
                              type="number"
                              min="0"
                              step="any"
                              aria-label={`Smallest partial mark for ${q.number}`}
                              disabled={!pack.awaitingRubricReview}
                              value={q.mark_step ?? ''}
                              onChange={(e) => updateQuestion(index, { mark_step: e.target.value === '' ? null : Number(e.target.value), mark_step_source: 'paper' })}
                              className={cn(SMALL_FIELD, 'w-16 tabular-nums')}
                            />
                          </label>
                        )}
                        <label className={cn('flex items-center gap-1.5 text-[13px] font-semibold text-foreground-secondary', !gate && 'ml-auto')}>
                          Marks
                          <input
                            type="number"
                            min="0"
                            step={q.mark_step || '0.5'}
                            disabled={!pack.awaitingRubricReview}
                            value={q.marks_allocated ?? 0}
                            onChange={(e) => updateQuestion(index, { marks_allocated: Number(e.target.value) })}
                            className={cn(SMALL_FIELD, 'w-16 tabular-nums')}
                          />
                        </label>
                      </div>
                      {gateErrors.some((item) => item.question === q.number) && (
                        <ul className="mb-2.5 space-y-0.5 rounded-xl border border-destructive/30 bg-destructive-soft px-3 py-2 text-[13px] text-destructive-soft-foreground">
                          {gateErrors.filter((item) => item.question === q.number).map((item, i) => <li key={`${item.code}-${i}`}>{item.message}</li>)}
                        </ul>
                      )}
                      <label className="mb-2.5 flex items-start gap-2 rounded-xl border border-border bg-paper-soft px-3 py-2 text-[13px] text-foreground-secondary">
                        <input
                          type="checkbox"
                          className="mt-0.5 h-4 w-4 accent-action"
                          disabled={!pack.awaitingRubricReview}
                          checked={hasVisualRequirement(q)}
                          onChange={(e) => setNeedsVisual(index, e.target.checked)}
                        />
                        <span>
                          <span className="font-semibold text-foreground">Needs diagram / visual (run VL)</span>
                          <span className="mt-0.5 block text-muted-foreground">
                            Turn on when the student must draw a figure, graph, structure, or circuit that OCR cannot grade from text alone.
                          </span>
                        </span>
                      </label>
                      {hasVisualRequirement(q) ? (
                        <label className={cn(FIELD_LABEL, 'mb-2.5')}>
                          What VL should verify
                          <input
                            type="text"
                            disabled={!pack.awaitingRubricReview}
                            value={q.visual_requirements || ''}
                            onChange={(e) => updateQuestion(index, { visual_requirements: e.target.value })}
                            placeholder={DEFAULT_VISUAL_REQUIREMENT}
                            className={FIELD}
                          />
                        </label>
                      ) : null}
                      <label className={cn(FIELD_LABEL, 'mb-2.5')}>
                        Question
                        <textarea
                          disabled={!pack.awaitingRubricReview}
                          value={q.question_text || ''}
                          onChange={(e) => updateQuestion(index, { question_text: e.target.value })}
                          rows={2}
                          className={FIELD}
                        />
                      </label>
                      <label className={cn(FIELD_LABEL, 'mb-2.5')}>
                        Correct answer
                        <textarea
                          disabled={!pack.awaitingRubricReview}
                          value={q.correct_answer_summary || ''}
                          onChange={(e) => updateQuestion(index, { correct_answer_summary: e.target.value })}
                          rows={2}
                          className={FIELD}
                        />
                      </label>
                      {gate && q.key_check && q.key_check.status !== 'none' && (
                        <div className={cn('mb-2.5 rounded-xl border px-3 py-2 text-[13px]', q.key_check.status === 'open' ? 'border-destructive/30 bg-destructive-soft text-destructive-soft-foreground' : 'border-border bg-paper-soft text-foreground-secondary')}>
                          <p>
                            <span className="font-semibold">
                              {{ unsupported: 'Key not found in the paper:', alternative: 'Another option may be correct:' }[q.key_check.verdict] || 'Independent answer:'}
                            </span>{' '}
                            {q.key_check.checker_answer}
                          </p>
                          {q.key_check.note ? <p className="mt-0.5 text-muted-foreground">{q.key_check.note}</p> : null}
                          {q.key_check.status === 'open' ? (
                            <div role="group" aria-label={`Resolve key check for ${q.number}`} className="mt-2 flex flex-wrap gap-1.5">
                              <Button type="button" size="sm" variant="secondary" disabled={!pack.awaitingRubricReview} onClick={() => resolveKeyCheck(index, 'kept')}>Keep the key</Button>
                              <Button type="button" size="sm" variant="secondary" disabled={!pack.awaitingRubricReview} onClick={() => resolveKeyCheck(index, 'alternative')}>Accept as alternative</Button>
                              <Button type="button" size="sm" variant="secondary" disabled={!pack.awaitingRubricReview} onClick={() => resolveKeyCheck(index, 'corrected')}>Use as the key</Button>
                            </div>
                          ) : (
                            <p className="mt-1.5 flex flex-wrap items-center gap-2">
                              <span className="font-semibold text-foreground">
                                {{ kept: 'Key kept', alternative: 'Accepted as an alternative', corrected: 'Key corrected' }[q.key_check.status] || q.key_check.status}
                                {q.key_check.resolved_by ? ` by ${q.key_check.resolved_by}` : ''}
                              </span>
                              {pack.awaitingRubricReview && (
                                <button type="button" className="font-semibold text-action hover:underline" onClick={() => resolveKeyCheck(index, 'open')}>Undo</button>
                              )}
                            </p>
                          )}
                        </div>
                      )}
                      {gate && (
                        <label className={cn(FIELD_LABEL, 'mb-2.5')}>
                          Accepted alternatives (one per line)
                          <textarea
                            disabled={!pack.awaitingRubricReview}
                            value={(q.accepted_variations || []).join('\n')}
                            onChange={(e) => updateQuestion(index, { accepted_variations: e.target.value.split('\n').map((line) => line.trim()).filter(Boolean) })}
                            rows={2}
                            className={FIELD}
                          />
                        </label>
                      )}
                      <label className={FIELD_LABEL}>
                        Marking rubric
                        <textarea
                          disabled={!pack.awaitingRubricReview}
                          value={q.marking_rubric || ''}
                          onChange={(e) => updateQuestion(index, { marking_rubric: e.target.value })}
                          rows={2}
                          className={FIELD}
                        />
                      </label>
                    </article>
                  ))}
                </div>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
