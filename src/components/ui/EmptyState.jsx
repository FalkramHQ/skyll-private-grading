import * as React from 'react';
import { Check } from 'lucide-react';
import { cn } from '../../lib/utils';

// One sentence about what happens next and at most one action.
function EmptyState({ title, children, action, icon: Icon = Check, className }) {
  return (
    <div className={cn('flex flex-col items-center gap-3 px-6 py-10 text-center', className)}>
      <span className="flex h-12 w-12 rotate-[-4deg] items-center justify-center rounded-full border-2 border-ink bg-lime" aria-hidden="true">
        <Icon className="h-6 w-6 text-ink" strokeWidth={2.6} />
      </span>
      {title && <h3 className="font-headline text-lg font-bold text-foreground">{title}</h3>}
      {children && <p className="max-w-sm text-sm text-foreground-secondary">{children}</p>}
      {action}
    </div>
  );
}

export { EmptyState };
