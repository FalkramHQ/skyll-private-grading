import { ChevronRight } from 'lucide-react';
import { cn } from '../lib/utils';

/**
 * A sticky section-navigation outline for the student report.
 * Implements Don Norman's "cognitive load management" principle:
 * gives the student a persistent map of where they are and what comes next,
 * so a long report scroll never feels disorienting.
 *
 * @param {object} props
 * @param {Array<{id: string, label: string, nextAction: string|null}>} props.sections
 * @param {string} props.activeId - Currently visible section id.
 * @param {(id: string) => void} props.onSelect - Called when a section is clicked.
 */
export function ReportOutline({ sections = [], activeId = '', onSelect }) {
  if (!sections.length) return null;

  return (
    <nav
      aria-label="Report sections"
      className="sticky top-4 z-20 hidden md:block"
    >
      <div className="rounded-2xl border-2 border-ink bg-card p-2">
        <ul className="space-y-0.5">
          {sections.map((section, index) => {
            const isActive = section.id === activeId;
            return (
              <li key={section.id}>
                <button
                  onClick={() => onSelect?.(section.id)}
                  aria-current={isActive ? 'true' : undefined}
                  className={cn(
                    'flex min-h-10 w-full items-center justify-between gap-2 rounded-[10px] px-3 py-2 text-left text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    isActive
                      ? 'bg-action-tint text-accent font-semibold'
                      : 'font-medium text-foreground-secondary hover:bg-sunken hover:text-foreground',
                  )}
                >
                  <span className="flex items-center gap-2">
                    <span className={cn(
                      'text-xs font-semibold tabular-nums',
                      isActive ? 'text-accent' : 'text-muted-foreground',
                    )}>
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    {section.label}
                  </span>
                  {isActive && section.nextAction && (
                    <span className="flex items-center gap-1 text-xs text-accent">
                      {section.nextAction}
                      <ChevronRight className="w-3 h-3" />
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}

export default ReportOutline;
