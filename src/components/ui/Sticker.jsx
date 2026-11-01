import * as React from 'react';
import { cn } from '../../lib/utils';

// Loud volume only (student, parent, marketing). At most two per screen and
// never on review or grading pages. Coral means "next" or "look here", never an error.
const TONES = {
  lime: 'bg-lime text-ink',
  coral: 'bg-coral text-ink',
  white: 'bg-card text-ink',
  ink: 'bg-ink text-lime',
};

function Sticker({ tone = 'lime', tilt = 4, className, style, ...props }) {
  return (
    <span
      className={cn('inline-flex items-center gap-1.5 rounded-full border-2 border-ink px-3 py-1 text-[13px] font-bold leading-none', TONES[tone] || TONES.lime, className)}
      style={{ transform: tilt ? `rotate(${tilt}deg)` : undefined, ...style }}
      {...props}
    />
  );
}

export { Sticker };
