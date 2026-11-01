// Loud-volume building blocks for the public site and sign-in screens
// (Skyll Notebook, docs/plans/SKYLL_NOTEBOOK_DESIGN.md). Marketing only:
// never import these into review, grading or other quiet screens.
import { cn } from '../../lib/utils';

// index.css gives h1-h6 Bricolage 700 with -0.015em tracking as unlayered CSS,
// which outranks Tailwind utilities. Display headings need the important
// modifier to reach weight 800 and the tight tracking, and leading is marked
// important so tailwind-merge keeps it when a text-[size] class follows.
export const display = 'font-display font-extrabold! tracking-[-0.045em]! leading-[0.95]!';
export const heading = 'font-display font-extrabold! tracking-[-0.03em]! leading-[1.05]!';

/** Lime highlighter stroke behind a key phrase. Keep it to one phrase per section. */
export function Highlight({ children, className }) {
  return (
    <span className={cn('relative isolate inline-block', className)}>
      <span
        aria-hidden="true"
        className="absolute -inset-x-[0.08em] top-[0.36em] bottom-[0.02em] -z-10 -rotate-1 rounded-[3px] bg-lime"
      />
      {children}
    </span>
  );
}

/** Small uppercase label above a heading, with a coral dot. */
export function Eyebrow({ children, dark = false, className }) {
  return (
    <p className={cn('inline-flex items-center gap-2 text-[13px] font-bold uppercase tracking-[0.12em]', dark ? 'text-lime' : 'text-foreground', className)}>
      <span aria-hidden="true" className={cn('h-2.5 w-2.5 shrink-0 rounded-full border-[1.5px]', dark ? 'border-lime bg-lime' : 'border-ink bg-coral')} />
      {children}
    </p>
  );
}

export function SectionHeading({ eyebrow, title, intro, align = 'left', dark = false, className }) {
  const centered = align === 'center';
  return (
    <div className={cn('max-w-3xl', centered && 'mx-auto text-center', className)}>
      {eyebrow && <Eyebrow dark={dark}>{eyebrow}</Eyebrow>}
      <h2 className={cn(heading, 'mt-4 text-[32px] sm:text-[44px] lg:text-[52px]', dark ? 'text-white' : 'text-foreground')}>{title}</h2>
      {intro && (
        <p className={cn('mt-5 max-w-2xl text-[17px] leading-relaxed sm:text-lg', centered && 'mx-auto', dark ? 'text-white/75' : 'text-foreground-secondary')}>{intro}</p>
      )}
    </div>
  );
}

/** A strip of translucent lime tape, as if holding a card to the page. Decorative. */
export function Tape({ className, tilt = 4 }) {
  return (
    <span
      aria-hidden="true"
      className={cn('pointer-events-none absolute z-10 h-7 w-24 border-x-2 border-dashed border-ink/25 bg-lime/60', className)}
      style={{ transform: `rotate(${tilt}deg)` }}
    />
  );
}

/** The Skyll mark in ink (or white on the ink band) beside the wordmark. */
export function Wordmark({ inverted = false, className, markClassName, textClassName }) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <img
        src="/skyll-logo.svg"
        alt=""
        width="36"
        height="36"
        className={cn('h-9 w-9 object-contain brightness-0', inverted && 'invert', markClassName)}
      />
      <span className={cn('font-display text-[26px] font-extrabold leading-none tracking-[-0.04em]', inverted ? 'text-white' : 'text-ink', textClassName)}>
        Skyll
      </span>
    </span>
  );
}

// Loud button sizes for <Button asChild>: 48px, 2px ink outline. The primary
// keeps a 4px hard shadow; the outline button sits flat on the page.
export const loudPrimary = 'h-12 rounded-xl border-2 px-6 text-base font-bold shadow-hard-md';
export const loudSecondary = 'h-12 rounded-xl border-2 px-6 text-base font-bold';
