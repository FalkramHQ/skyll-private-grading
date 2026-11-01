import * as React from 'react';
import { AlertCircle, CheckCircle2, CircleDashed, Clock, Flag } from 'lucide-react';
import { cn } from '../../lib/utils';

// Status is carried by icon and words; colour only confirms it.
const STATUS = {
  positive: { icon: CheckCircle2, className: 'bg-success-soft text-success-soft-foreground' },
  caution: { icon: Flag, className: 'bg-warning-soft text-warning-soft-foreground' },
  critical: { icon: AlertCircle, className: 'bg-destructive-soft text-destructive-soft-foreground' },
  info: { icon: Clock, className: 'bg-info-soft text-info' },
  neutral: { icon: CircleDashed, className: 'bg-sunken text-foreground-secondary' },
};

function StatusBadge({ status = 'neutral', icon, children, className, ...props }) {
  const config = STATUS[status] || STATUS.neutral;
  const Icon = icon || config.icon;
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold leading-none', config.className, className)} {...props}>
      <Icon className="h-3.5 w-3.5 shrink-0" strokeWidth={2.4} aria-hidden="true" />
      {children}
    </span>
  );
}

export { StatusBadge };
