// Legal and trust pages: quiet and readable. Plain paper, one column at
// prose width, Bricolage headings, generous line height. No stickers.
import Header from '../Header';
import Footer from '../Footer';
import { cn } from '../../lib/utils';
import { display } from './Notebook';

export function LegalPage({ eyebrow, title, intro, updated, children }) {
  return (
    <div className="flex min-h-screen flex-col bg-background text-ink">
      <Header />
      <main className="flex-1">
        <article className="mx-auto w-full max-w-prose px-4 py-14 sm:px-6 sm:py-20">
          <header className="border-b-2 border-ink pb-8">
            {eyebrow && <p className="text-[13px] font-bold uppercase tracking-[0.12em] text-foreground-secondary">{eyebrow}</p>}
            <h1 className={cn(display, 'mt-3 text-[40px] text-ink sm:text-[56px]')}>{title}</h1>
            {intro && <p className="mt-5 text-lg leading-relaxed text-foreground-secondary">{intro}</p>}
            {updated && <p className="mt-4 text-sm text-muted-foreground">Last updated: {updated}</p>}
          </header>
          <div className="mt-10 space-y-10 sm:mt-12 sm:space-y-12">{children}</div>
        </article>
      </main>
      <Footer />
    </div>
  );
}

export function LegalSection({ title, icon: Icon, children, className }) {
  return (
    <section className={className}>
      <h2 className="flex items-center gap-3 text-[24px] leading-tight text-ink sm:text-[26px]">
        {Icon && (
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-ink" aria-hidden="true">
            <Icon className="h-[18px] w-[18px]" />
          </span>
        )}
        {title}
      </h2>
      <div className="mt-4 space-y-4 text-base leading-[1.7] text-foreground-secondary [&_strong]:font-semibold [&_strong]:text-ink">{children}</div>
    </section>
  );
}

export const legalLink = 'font-semibold text-action underline decoration-1 underline-offset-4 hover:text-action-pressed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded';
