import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, FileText } from 'lucide-react';
import { answerSheetUrl } from '../lib/answerSheetRequest';
import { Skeleton } from './ui/Skeleton';
import { cn } from '../lib/utils';
import Loader from '../components/Loader';

export default function AnswerSheetGallery({ subjects, studentUsername, testId, className = '' }) {
  const [state, setState] = useState({ loading: true, sheets: [] });
  const [activeIndex, setActiveIndex] = useState(0);
  // 'loading' | 'loaded' | 'error' for the page on screen.
  const [imageState, setImageState] = useState('loading');
  const subjectKey = (subjects || []).map((subject) => subject.name).filter(Boolean).join('\u0001');

  const pages = useMemo(() => state.sheets.flatMap((sheet) => sheet.pages.map((page) => ({
    subject: sheet.subject,
    page,
  }))), [state.sheets]);
  const activePage = pages[activeIndex] || pages[0];
  const changePage = (nextIndex) => setActiveIndex(Math.max(0, Math.min(nextIndex, pages.length - 1)));

  useEffect(() => setImageState('loading'), [activeIndex]);

  useEffect(() => {
    let active = true;
    const uniqueSubjects = [...new Set(subjectKey.split('\u0001').filter(Boolean))];
    Promise.all(uniqueSubjects.map(async (subject) => {
      const response = await fetch(answerSheetUrl({ subject, studentUsername, testId }));
      if (!response.ok) return null;
      const body = await response.json();
      return { subject, pages: body.pages || [] };
    }))
      .then((sheets) => {
        if (!active) return;
        setActiveIndex(0);
        setState({ loading: false, sheets: sheets.filter((sheet) => sheet?.pages.length) });
      })
      .catch(() => {
        if (!active) return;
        setActiveIndex(0);
        setState({ loading: false, sheets: [] });
      });
    return () => { active = false; };
  }, [subjectKey, studentUsername, testId]);

  if (!state.loading && !state.sheets.length) return null;

  return (
    <section className={className}>
      <div className="mb-4 flex items-start gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border-[1.5px] border-ink bg-card text-ink" aria-hidden="true"><FileText size={18} strokeWidth={2.2} /></div>
        <div>
          <h2 className="font-display text-[21px] leading-tight text-foreground">Handwritten answer sheet</h2>
          <p className="mt-0.5 text-sm leading-relaxed text-foreground-secondary">Compare the scanned work with the question-by-question feedback.</p>
        </div>
      </div>
      {state.loading ? (
        <div className="flex items-center gap-2 py-3 text-sm text-foreground-secondary"><Loader size="inline" /> Loading scanned pages</div>
      ) : (
        <div className="overflow-hidden rounded-[20px] border-2 border-ink bg-card">
          <div className="flex min-h-14 items-center justify-between gap-3 border-b-[1.5px] border-ink px-3 py-1.5 sm:px-4">
            <div className="min-w-0">
              <p className="truncate text-sm font-bold text-foreground">{activePage.subject}</p>
              <p className="text-[13px] tabular-nums text-foreground-secondary">Page {activePage.page} of {pages.length}</p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button type="button" aria-label="Previous answer-sheet page" title="Previous page" disabled={activeIndex === 0} onClick={() => changePage(activeIndex - 1)} className="grid h-11 w-11 place-items-center rounded-xl border-2 border-ink bg-card text-ink transition-colors hover:bg-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:border-hairline disabled:text-muted-foreground disabled:hover:bg-card"><ChevronLeft size={18} strokeWidth={2.4} /></button>
              <button type="button" aria-label="Next answer-sheet page" title="Next page" disabled={activeIndex === pages.length - 1} onClick={() => changePage(activeIndex + 1)} className="grid h-11 w-11 place-items-center rounded-xl border-2 border-ink bg-card text-ink transition-colors hover:bg-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:border-hairline disabled:text-muted-foreground disabled:hover:bg-card"><ChevronRight size={18} strokeWidth={2.4} /></button>
            </div>
          </div>
          <figure className="relative m-0 bg-sunken p-2 sm:p-4">
            {imageState === 'loading' && (
              <Skeleton className="absolute inset-2 sm:inset-4 rounded-sm" />
            )}
            {imageState === 'error' && (
              <p role="status" className="absolute inset-2 grid place-items-center rounded-sm border border-dashed border-hairline-strong text-sm text-foreground-secondary sm:inset-4">
                Page unavailable
              </p>
            )}
            <img
              src={answerSheetUrl({ subject: activePage.subject, page: activePage.page, studentUsername, testId })}
              alt={`${activePage.subject} answer sheet, page ${activePage.page}`}
              loading="lazy"
              decoding="async"
              onLoad={() => setImageState('loaded')}
              onError={() => setImageState('error')}
              className={cn(
                'mx-auto block max-h-[78vh] w-auto max-w-full rounded-sm border border-hairline bg-white object-contain transition-opacity',
                imageState === 'loaded' ? 'opacity-100' : 'opacity-0',
              )}
            />
          </figure>
          {pages.length > 1 && (
            <div className="flex gap-2 overflow-x-auto snap-x snap-mandatory border-t-[1.5px] border-ink p-2 sm:p-3 hide-scrollbar" aria-label="Answer-sheet pages">
              {pages.map((item, index) => (
                <button key={`${item.subject}-${item.page}`} type="button" aria-label={`View ${item.subject} page ${item.page}`} aria-current={index === activeIndex ? 'page' : undefined} onClick={() => changePage(index)} className={`relative h-16 w-12 shrink-0 snap-start overflow-hidden rounded-md border-2 bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-20 sm:w-14 ${index === activeIndex ? 'border-ink ring-2 ring-lime ring-offset-1' : 'border-hairline hover:border-ink'}`}>
                  <img src={answerSheetUrl({ subject: item.subject, page: item.page, studentUsername, testId })} alt="" loading="lazy" className="h-full w-full object-cover object-top" />
                  <span className={`absolute inset-x-0 bottom-0 py-0.5 text-xs font-bold tabular-nums ${index === activeIndex ? 'bg-lime text-ink' : 'bg-ink text-white'}`}>{index + 1}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
