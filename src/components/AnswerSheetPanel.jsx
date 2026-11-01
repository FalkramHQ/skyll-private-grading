import { useEffect, useRef, useState } from 'react';
import { Crosshair, Image as ImageIcon, Maximize2, Minimize2, Minus, Plus } from 'lucide-react';
import Loader from './Loader';
import { cn } from '../lib/utils';
import { reviewAnswerSheetUrl } from '../lib/answerSheetRequest';

// Reserve page height before images load so scroll targets don't drift as
// lazy pages arrive. A4 until the first real page reports its own shape.
const DEFAULT_PAGE_ASPECT = 1.414;
// Land the estimated answer start this far below the top of the panel, so
// the end of the previous answer (or the gap for a blank one) is visible too.
const SCROLL_MARGIN = 0.15;
const PAGE_TOP_PADDING = 8;
const FLASH_MS = 1200;
const ZOOM_STEPS = [1, 1.25, 1.5, 1.75, 2, 2.5];
const TOOL = 'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-[13px] font-semibold text-foreground-secondary transition-colors hover:bg-sunken hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40';

/**
 * Fetch where each of a student's answers sits on their sheet (#342), once
 * per student per dashboard visit.
 */
export function useAnswerLocations(testId, testStudentId) {
  const cache = useRef(new Map());
  const key = testId && testStudentId ? `${testId}:${testStudentId}` : null;
  const [state, setState] = useState({ key: null, data: null });

  useEffect(() => {
    if (!key) return undefined;
    let cancelled = false;
    if (!cache.current.has(key)) {
      const request = fetch('/api/vl-queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'answer-locations', testId, testStudentId }),
      }).then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || 'Could not locate answers');
        return body;
      });
      // A failed lookup must not stick: drop it so the next visit retries.
      request.catch(() => cache.current.delete(key));
      cache.current.set(key, request);
    }
    cache.current.get(key)
      .then((data) => { if (!cancelled) setState({ key, data }); })
      .catch(() => { if (!cancelled) setState({ key, data: null }); });
    return () => { cancelled = true; };
  }, [key, testId, testStudentId]);

  return state.key === key ? state.data : null;
}

export function findAnswerLocation(data, item) {
  if (!data?.locations || !item) return null;
  return data.locations.find((row) => row.id && row.id === item.id)
    || data.locations.find((row) => row.questionNumber === item.questionNumber)
    || null;
}

export function answerLocationLabel(location) {
  if (!location) return null;
  if (location.match === 'none' || !location.page) return 'Not found on sheet';
  if (location.match === 'inferred') return `Likely page ${location.page}${location.answered ? '' : ' · not attempted'}`;
  return `Page ${location.page}`;
}

export function AnswerLocationChip({ location }) {
  const label = answerLocationLabel(location);
  if (!label) return null;
  return (
    <span className="ml-2 inline-flex items-center rounded-full border border-hairline bg-card px-2 py-0.5 text-xs font-medium text-foreground-secondary">
      {label}
    </span>
  );
}

/**
 * The answer sheet beside a review item. Whenever `focusKey` (the selected
 * question) changes, scroll this panel, not the page, to the located answer
 * and briefly outline its page.
 *
 * `fill` makes the panel take its parent's full height and adds the reviewer
 * toolbar (fit width / fit page, zoom, jump to answer, focus). Without it the
 * panel keeps its original capped-height layout.
 */
export function AnswerSheetPanel({ testId, testStudentId, subject, pageCount, location, focusKey, fill = false, focused = false, onToggleFocus }) {
  const containerRef = useRef(null);
  const measured = useRef(false);
  // Where the panel is aiming, and whether the reviewer has taken over since.
  const aim = useRef({ page: null, offset: 0, abovePage: false });
  const userMoved = useRef(false);
  const shownStudent = useRef(testStudentId);
  const [aspect, setAspect] = useState(DEFAULT_PAGE_ASPECT);
  const [flashPage, setFlashPage] = useState(null);
  // Reviewer zoom: fit the page width (1 = 100%), a zoom multiple, or fit a whole page in view.
  const [fit, setFit] = useState('width');
  const [zoom, setZoom] = useState(1);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const pages = Array.from({ length: pageCount || 0 }, (_, index) => index + 1);
  const targetPage = location?.page ?? null;
  const targetOffset = location?.offset ?? 0;
  // An inferred gap at a page boundary sits at the very top of the later
  // page, so it may scroll above it to show the end of the earlier page too.
  const abovePage = location?.match === 'inferred';

  const scrollToAim = (behavior) => {
    const container = containerRef.current;
    const { page: pageNum, offset, abovePage: mayGoAbove } = aim.current;
    const page = pageNum ? container?.querySelector(`[data-page="${pageNum}"]`) : null;
    if (!container || !page) return false;
    const estimate = page.offsetTop + offset * page.offsetHeight - container.clientHeight * SCROLL_MARGIN;
    const top = mayGoAbove ? estimate : Math.max(page.offsetTop - PAGE_TOP_PADDING, estimate);
    container.scrollTo?.({ top, behavior });
    return true;
  };

  // A new student's sheet starts at the top, not wherever the last one was.
  useEffect(() => {
    if (shownStudent.current === testStudentId) return;
    shownStudent.current = testStudentId;
    measured.current = false;
    setAspect(DEFAULT_PAGE_ASPECT);
    containerRef.current?.scrollTo?.({ top: 0, behavior: 'auto' });
  }, [testStudentId]);

  useEffect(() => {
    aim.current = { page: targetPage, offset: targetOffset, abovePage };
    userMoved.current = false;
    if (!scrollToAim('smooth')) return undefined;
    setFlashPage(targetPage);
    const timer = setTimeout(() => setFlashPage(null), FLASH_MS);
    return () => clearTimeout(timer);
  }, [focusKey, targetPage, targetOffset, abovePage]);

  // Pages above the target change height as their images arrive (and when
  // the first one reveals the sheet's real shape). Re-aim instantly so the
  // answer stays put, but never fight a reviewer who has started scrolling.
  const reaim = (loadedPage) => {
    if (userMoved.current || !aim.current.page || loadedPage > aim.current.page) return;
    scrollToAim('auto');
  };

  // The first measured page resizes every unloaded placeholder on the next
  // render, after its own load handler has already re-aimed.
  useEffect(() => {
    if (measured.current) reaim(0);
    // reaim reads refs only; re-running it for a new closure would add nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aspect]);

  const handleMeasure = (ratio) => {
    if (measured.current || !Number.isFinite(ratio) || ratio <= 0) return;
    measured.current = true;
    setAspect(ratio);
  };

  const markUserMoved = () => { userMoved.current = true; };

  // Track the panel's size so "fit page" can size pages to the visible height.
  useEffect(() => {
    if (!fill || typeof ResizeObserver === 'undefined') return undefined;
    const container = containerRef.current;
    if (!container) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      setViewport({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [fill]);

  const zoomBy = (direction) => {
    setFit('width');
    setZoom((current) => {
      const index = ZOOM_STEPS.findIndex((step) => step >= current - 0.001);
      const next = ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, (index < 0 ? 0 : index) + direction))];
      return next;
    });
  };

  const jumpToAnswer = () => {
    userMoved.current = false;
    if (!scrollToAim('smooth')) return;
    setFlashPage(aim.current.page);
    setTimeout(() => setFlashPage(null), FLASH_MS);
  };

  // + / - zoom, 0 resets to fit width. Ignored while typing.
  useEffect(() => {
    if (!fill) return undefined;
    const handler = (event) => {
      const tag = event.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomBy(1); }
      else if (event.key === '-' || event.key === '_') { event.preventDefault(); zoomBy(-1); }
      else if (event.key === '0') { event.preventDefault(); setFit('width'); setZoom(1); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [fill]);

  if (fill) {
    const pageWidth = fit === 'page' && viewport.height > 0
      ? Math.min(viewport.width, Math.max(240, (viewport.height - 24) / aspect))
      : null;
    const sheetStyle = pageWidth ? { width: `${pageWidth}px` } : { width: `${zoom * 100}%` };
    return (
      <section aria-label="Answer sheet" className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center gap-x-1.5 pb-2">
          <h2 className="mr-auto flex min-w-0 items-center gap-2 whitespace-nowrap text-[13px] font-bold text-foreground">
            <ImageIcon className="h-4 w-4 text-foreground-secondary" aria-hidden="true" />
            <span className="truncate">Answer sheet <span className="hidden font-semibold text-muted-foreground tabular-nums xl:inline">· {pageCount} {pageCount === 1 ? 'page' : 'pages'}</span></span>
            <span className="hidden xl:inline"><AnswerLocationChip location={location} /></span>
          </h2>
          <div role="group" aria-label="Fit" className="flex shrink-0 items-center rounded-[10px] border border-hairline bg-card p-0.5">
            <button type="button" aria-pressed={fit === 'width' && zoom === 1} onClick={() => { setFit('width'); setZoom(1); }} className={cn(TOOL, 'h-7', fit === 'width' && zoom === 1 && 'bg-ink text-lime hover:bg-ink hover:text-lime')}>Fit width</button>
            <button type="button" aria-pressed={fit === 'page'} onClick={() => setFit('page')} className={cn(TOOL, 'h-7', fit === 'page' && 'bg-ink text-lime hover:bg-ink hover:text-lime')}>Fit page</button>
          </div>
          <div className="flex items-center">
            <button type="button" onClick={() => zoomBy(-1)} disabled={fit === 'width' && zoom <= ZOOM_STEPS[0]} className={TOOL} aria-label="Zoom out (-)" title="Zoom out (-)"><Minus className="h-4 w-4" aria-hidden="true" /></button>
            <span className="w-11 text-center text-xs font-semibold text-foreground-secondary tabular-nums" aria-live="polite">{fit === 'page' ? 'Page' : `${Math.round(zoom * 100)}%`}</span>
            <button type="button" onClick={() => zoomBy(1)} disabled={fit === 'width' && zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]} className={TOOL} aria-label="Zoom in (+)" title="Zoom in (+)"><Plus className="h-4 w-4" aria-hidden="true" /></button>
          </div>
          <button type="button" onClick={jumpToAnswer} disabled={!targetPage} className={TOOL} title="Scroll back to this answer" aria-label="Jump to answer">
            <Crosshair className="h-4 w-4" aria-hidden="true" /> <span className="hidden 2xl:inline">Jump to answer</span>
          </button>
          {onToggleFocus && (
            <button type="button" onClick={onToggleFocus} aria-pressed={focused} className={TOOL} title={focused ? 'Exit focus (F)' : 'Focus on the sheet (F)'}>
              {focused ? <Minimize2 className="h-4 w-4" aria-hidden="true" /> : <Maximize2 className="h-4 w-4" aria-hidden="true" />}
              <span className={focused ? '' : 'hidden xl:inline'}>{focused ? 'Exit focus' : 'Focus'}</span>
            </button>
          )}
        </div>
        <div
          ref={containerRef}
          data-testid="answer-sheet-scroll"
          onWheel={markUserMoved}
          onTouchMove={markUserMoved}
          onPointerDown={markUserMoved}
          onKeyDown={markUserMoved}
          className="relative min-h-0 flex-1 overflow-auto rounded-2xl border border-border bg-sunken p-3"
        >
          <div className="mx-auto space-y-3" style={sheetStyle}>
            {pages.length > 0 ? pages.map((pageNum) => (
              <div
                key={`${testStudentId}:${pageNum}`}
                data-page={pageNum}
                className={cn('rounded-[4px]', flashPage === pageNum && 'ring-2 ring-ink ring-offset-2 ring-offset-sunken')}
              >
                <ImageWithLoader
                  studentId={testStudentId}
                  page={pageNum}
                  subject={subject}
                  testId={testId}
                  aspect={aspect}
                  onMeasure={handleMeasure}
                  onLoaded={reaim}
                  eager={pageNum <= 2 || pageNum === targetPage}
                />
              </div>
            )) : (
              <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">No images available</div>
            )}
          </div>
        </div>
      </section>
    );
  }

  return (
    <div className="space-y-2 lg:sticky lg:top-20 lg:self-start">
      <h2 className="flex items-center gap-2 text-[13px] font-bold text-foreground">
        <ImageIcon className="h-4 w-4 text-foreground-secondary" aria-hidden="true" />
        <span>Answer Sheet <span className="font-semibold text-muted-foreground tabular-nums">({pageCount} pages)</span></span>
      </h2>
      <div
        ref={containerRef}
        data-testid="answer-sheet-scroll"
        onWheel={markUserMoved}
        onTouchMove={markUserMoved}
        onPointerDown={markUserMoved}
        onKeyDown={markUserMoved}
        className="relative max-h-[80vh] space-y-3 overflow-y-auto rounded-2xl border border-border bg-sunken p-3 sm:p-4"
      >
        {pages.length > 0 ? pages.map((pageNum) => (
          <div
            key={`${testStudentId}:${pageNum}`}
            data-page={pageNum}
            className={cn('rounded-[4px]', flashPage === pageNum && 'ring-2 ring-ink ring-offset-2 ring-offset-sunken')}
          >
            <ImageWithLoader
              studentId={testStudentId}
              page={pageNum}
              subject={subject}
              testId={testId}
              aspect={aspect}
              onMeasure={handleMeasure}
              onLoaded={reaim}
              eager={pageNum <= 2 || pageNum === targetPage}
            />
          </div>
        )) : (
          <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">No images available</div>
        )}
      </div>
    </div>
  );
}

function ImageWithLoader({ studentId, page, subject, testId, aspect, onMeasure, onLoaded, eager = false }) {
  const [status, setStatus] = useState('loading');

  const src = testId
    ? reviewAnswerSheetUrl({ testId, testStudentId: studentId, page, subject })
    : subject
    ? `/api/images/answer-sheet?studentId=${encodeURIComponent(studentId)}&page=${page}&subject=${encodeURIComponent(subject)}`
    : `/api/images/answer-sheet?studentId=${encodeURIComponent(studentId)}&page=${page}`;

  // Remounting via key handles student switches; also reset if src changes in place
  // so a prior error/loaded state cannot hide the new image.
  useEffect(() => {
    setStatus('loading');
  }, [src]);

  const reserved = { aspectRatio: `1 / ${aspect}` };

  return (
    <div className="relative">
      {status === 'loading' && (
        <div className="flex w-full items-center justify-center rounded-[4px] border border-hairline bg-card" style={reserved}>
          <Loader size="inline" className="text-muted-foreground" />
        </div>
      )}
      {status !== 'error' && (
        <img
          src={src}
          alt={`Page ${page}`}
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          className={`w-full rounded-[4px] border border-hairline bg-card ${status === 'loading' ? 'opacity-0 absolute' : 'opacity-100'}`}
          onLoad={(event) => {
            const { naturalWidth, naturalHeight } = event.currentTarget;
            if (naturalWidth) onMeasure?.(naturalHeight / naturalWidth);
            setStatus('loaded');
            onLoaded?.(page);
          }}
          onError={() => setStatus('error')}
        />
      )}
      {status === 'loaded' && (
        <span className="absolute left-2 top-2 rounded-full bg-ink px-2 py-0.5 text-xs font-bold tabular-nums text-white">Page {page}</span>
      )}
      {status === 'error' && (
        <div className="flex w-full items-center justify-center rounded-[4px] border border-destructive/30 bg-destructive-soft text-[13px] font-semibold text-destructive-soft-foreground" style={reserved}>
          Failed to load page {page}
        </div>
      )}
    </div>
  );
}
