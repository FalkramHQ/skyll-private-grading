import * as React from 'react';
import { cn } from '../../lib/utils';

const clamp = (n) => Math.max(0, Math.min(100, Number(n) || 0));

// A value with its likely range: sunken track, light range band, ink marker.
function RangeBar({ value, low, high, label, className }) {
  const v = clamp(value);
  const lo = clamp(low ?? v);
  const hi = clamp(high ?? v);
  return (
    <div
      role="img"
      aria-label={label || `${Math.round(v)}%${low != null && high != null ? `, likely ${Math.round(lo)} to ${Math.round(hi)}%` : ''}`}
      className={cn('relative h-3 rounded-full border-[1.5px] border-ink bg-sunken', className)}
    >
      {hi > lo && <span className="absolute inset-y-0 bg-seq-1" style={{ left: `${lo}%`, width: `${hi - lo}%` }} />}
      <span className="absolute -top-[5px] h-[19px] w-1.5 rounded-[3px] bg-ink" style={{ left: `calc(${v}% - 3px)` }} />
    </div>
  );
}

export { RangeBar };
