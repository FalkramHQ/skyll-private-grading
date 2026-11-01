import React from 'react';

import { cn } from '../lib/utils';

// Notebook loader: a lime grading sticker that inks a tick (styles in
// index.css). Pure CSS + inline SVG, so it renders the same everywhere,
// including under the production CSP.
//
// Geometry is owned by `size`. Do not pass Tailwind w-*/h-*.
// Optional className is for layout/colour only.
//   page   → 48px sticker (default)
//   hero   → 88px sticker (splash / route loaders)
//   inline → three dots in the current text colour (buttons / in-flow)
const STICKER_PX = { page: 48, hero: 88 };

export default function Loader({ className = '', size = 'page', style }) {
  if (size === 'inline') {
    return (
      <span role="status" aria-label="Loading" className={cn('ink-dots', className)} style={style}>
        <span />
        <span />
        <span />
      </span>
    );
  }

  const px = STICKER_PX[size] || STICKER_PX.page;
  return (
    <svg
      role="status"
      aria-label="Loading"
      viewBox="0 0 52 52"
      width={px}
      height={px}
      className={cn('ink-loader', className)}
      style={style}
    >
      <g className="ink-loader__wobble">
        <circle className="ink-loader__shadow" cx="27.5" cy="27.5" r="21" />
        <g className="ink-loader__face">
          <circle className="ink-loader__disc" cx="24" cy="24" r="21" />
          <path className="ink-loader__tick" d="M14.5 24.5l6.5 6.5 13-14" pathLength="1" />
        </g>
      </g>
    </svg>
  );
}
