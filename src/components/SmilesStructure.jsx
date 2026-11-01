import { useEffect, useRef, useState } from 'react';
import { isLikelySmiles, splitReactionMolecules } from '../lib/chemSmiles';

async function loadSmilesDrawer() {
  const mod = await import('smiles-drawer');
  return mod.default || mod;
}

function drawInto(drawer, smiles, el) {
  return new Promise((resolve) => {
    if (!el) {
      resolve(false);
      return;
    }
    el.replaceChildren();
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      drawer.draw(smiles, el, 'light', () => done(true), () => done(false));
    } catch {
      done(false);
      return;
    }
    // Element-target draws sometimes skip callbacks — check SVG contents.
    requestAnimationFrame(() => {
      done(el.childNodes.length > 0);
    });
  });
}

/**
 * Draw a SMILES molecule (or reaction) as an SVG structure diagram.
 * Falls back to the raw string if parsing fails.
 */
export default function SmilesStructure({ smiles, className = '', inline = false }) {
  const raw = String(smiles || '').trim();
  const hostRef = useRef(null);
  const [failed, setFailed] = useState(false);
  const [fragments, setFragments] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    setFragments(null);

    (async () => {
      if (!raw || !isLikelySmiles(raw)) {
        if (!cancelled) setFailed(true);
        return;
      }
      const SD = await loadSmilesDrawer();
      if (cancelled) return;

      const drawer = new SD.SmiDrawer({
        width: inline ? (raw.includes('>') ? 280 : 120) : (raw.includes('>') ? 420 : 220),
        height: inline ? 48 : 140,
        bondThickness: inline ? 1 : 1.2,
        compactDrawing: inline,
      });

      if (raw.includes('>')) {
        const compact = raw.replace(/\s+/g, '');
        const host = hostRef.current;
        if (host) {
          const ok = await drawInto(drawer, compact, host);
          if (cancelled) return;
          if (ok) return;
        }
        const mols = splitReactionMolecules(raw);
        if (!mols.length) {
          if (!cancelled) setFailed(true);
          return;
        }
        if (!cancelled) setFragments(mols);
        return;
      }

      const ok = await drawInto(drawer, raw, hostRef.current);
      if (!cancelled && !ok) setFailed(true);
    })().catch(() => {
      if (!cancelled) setFailed(true);
    });

    return () => {
      cancelled = true;
    };
  }, [raw, inline]);

  useEffect(() => {
    if (!fragments?.length) return undefined;
    let cancelled = false;
    const fragWidth = inline ? 96 : 160;
    const fragHeight = inline ? 48 : 120;

    (async () => {
      const SD = await loadSmilesDrawer();
      if (cancelled) return;
      const drawer = new SD.SmiDrawer({
        width: fragWidth,
        height: fragHeight,
        bondThickness: inline ? 1 : 1.2,
        compactDrawing: inline,
      });
      const nodes = hostRef.current?.querySelectorAll('[data-smiles-frag]') || [];
      let any = false;
      for (let i = 0; i < nodes.length; i += 1) {
         
        const ok = await drawInto(drawer, fragments[i], nodes[i]);
        if (ok) any = true;
      }
      if (!cancelled && !any) setFailed(true);
    })().catch(() => {
      if (!cancelled) setFailed(true);
    });

    return () => {
      cancelled = true;
    };
  }, [fragments, inline]);

  if (!raw) return null;

  if (failed) {
    return (
      <code className={`my-2 block break-all rounded-md bg-sunken px-2 py-1 font-mono text-xs text-foreground-secondary ${className}`}>
        {raw}
      </code>
    );
  }

  if (fragments?.length) {
    return (
      <div
        ref={hostRef}
        className={`${inline ? 'my-1 inline-flex align-middle' : 'my-2 flex'} max-w-full flex-wrap items-center gap-2 overflow-x-auto rounded-lg border border-hairline bg-white px-2 py-1 ${className}`}
        title={raw}
      >
        {fragments.map((frag, i) => (
          <span key={`${frag}-${i}`} className="inline-flex items-center gap-2">
            <svg data-smiles-frag width={inline ? 96 : 160} height={inline ? 48 : 120} className="max-w-full" />
            {i < fragments.length - 1 ? <span className="text-lg text-muted-foreground" aria-hidden="true">→</span> : null}
          </span>
        ))}
      </div>
    );
  }

  const svgWidth = inline ? (raw.includes('>') ? 280 : 120) : (raw.includes('>') ? 420 : 220);
  const svgHeight = inline ? 48 : 140;

  return (
    <div
      className={`${inline ? 'mx-0.5 inline-flex align-middle' : 'my-2 inline-flex'} max-w-full overflow-x-auto rounded-lg border border-hairline bg-white px-1 py-0.5 ${className}`}
      title={raw}
    >
      <svg ref={hostRef} className="max-w-full" width={svgWidth} height={svgHeight} />
    </div>
  );
}
