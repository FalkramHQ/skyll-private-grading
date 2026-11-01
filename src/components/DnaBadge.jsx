import React from 'react';

// ─── Learner DNA mode config ───────────────────────────────────────
// These visual motifs deliberately mirror the evidence-bound learning modes
// in LEARNER_DNA_SPEC.md. They are not personality types.
// Flat palette from tokens only: categorical chart-1..4 in their fixed order,
// then seq-5 and ink for the last two modes. Accents are lime/coral; the disc is
// paper-soft. `glow` is kept for API compatibility and mirrors `wash`.
// Neutral enough for both loud (student) and quiet (teacher) screens.
const ARCHETYPES = [
  {
    id: 'architect',
    title: 'The Architect',
    keywords: /architect|concept building/,
    c1: '#4B4BE8', c2: '#C9F230', wash: '#FAF8F2', glow: '#FAF8F2',
  },
  {
    id: 'pathfinder',
    title: 'The Pathfinder',
    keywords: /pathfinder|problem interpretation|method selection/,
    c1: '#E0622F', c2: '#C9F230', wash: '#FAF8F2', glow: '#FAF8F2',
  },
  {
    id: 'maker',
    title: 'The Maker',
    keywords: /maker|execution|completion/,
    c1: '#0E9480', c2: '#C9F230', wash: '#FAF8F2', glow: '#FAF8F2',
  },
  {
    id: 'cartographer',
    title: 'The Cartographer',
    keywords: /cartographer|representation|diagram|notation|equation|graph|data/,
    c1: '#9B3FA8', c2: '#C9F230', wash: '#FAF8F2', glow: '#FAF8F2',
  },
  {
    id: 'calibrator',
    title: 'The Calibrator',
    keywords: /calibrator|verification|correction/,
    c1: '#1C1C80', c2: '#FF6A3D', wash: '#FAF8F2', glow: '#FAF8F2',
  },
  {
    id: 'bridgebuilder',
    title: 'The Bridgebuilder',
    keywords: /bridgebuilder|transfer|changed question form|context/,
    c1: '#111111', c2: '#C9F230', wash: '#FAF8F2', glow: '#FAF8F2',
  },
];

function getInfo(personaTitle = '') {
  const lower = personaTitle.toLowerCase();
  for (const a of ARCHETYPES) if (a.keywords.test(lower)) return a;
  return ARCHETYPES[5];
}

// Fine tick marks around the bezel (precision-instrument feel)
function Bezel({ color }) {
  const ticks = [];
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2;
    const major = i % 5 === 0;
    const r1 = major ? 66 : 68;
    ticks.push(
      <line
        key={i}
        x1={80 + Math.cos(a) * r1} y1={80 + Math.sin(a) * r1}
        x2={80 + Math.cos(a) * 70} y2={80 + Math.sin(a) * 70}
        stroke={color} strokeWidth={major ? 1 : 0.5}
        opacity={major ? 0.35 : 0.18} strokeLinecap="round"
      />
    );
  }
  return <g>{ticks}</g>;
}

// ─── Shared frame: flat disc, ink ring, no gradients or blur ─────
const INK = '#111111';

function BadgeFrame({ info, children }) {
  const { id, c1, wash } = info;
  const p = `dna_${id}`;
  return (
    <svg viewBox="0 0 160 160" className="w-full h-full" aria-hidden="true">
      <circle cx="80" cy="80" r="76" fill="#FFFFFF" stroke={INK} strokeWidth="3" />
      <Bezel color={INK} />
      <circle cx="80" cy="80" r="63" fill={wash} stroke={INK} strokeWidth="1.5" />
      <g>{children(p, { ...info, c1 })}</g>
    </svg>
  );
}

// ─── 1. The Architect - interlocking geometry ────────────────────
function Architect({ info }) {
  return (
    <BadgeFrame info={info}>
      {(p, { c1, c2 }) => (
        <g>
          <circle cx="80" cy="64" r="20" fill="none" stroke={c1} strokeWidth="1.6" opacity="0.55" />
          <circle cx="63" cy="90" r="20" fill="none" stroke={c1} strokeWidth="1.6" opacity="0.55" />
          <circle cx="97" cy="90" r="20" fill="none" stroke={c1} strokeWidth="1.6" opacity="0.55" />
          <polygon points="80,60 62,94 98,94" fill={c1} opacity="0.18" />
          <polygon points="80,60 62,94 98,94" fill="none" stroke={c1} strokeWidth="2" strokeLinejoin="round" />
          <circle cx="80" cy="60" r="3.4" fill={c1} />
          <circle cx="62" cy="94" r="3.4" fill={c1} />
          <circle cx="98" cy="94" r="3.4" fill={c1} />
          <circle cx="80" cy="80" r="2.4" fill={c2} />
        </g>
      )}
    </BadgeFrame>
  );
}

// ─── 2. The Keeper - growth rings + ledger ───────────────────────
function Keeper({ info }) {
  return (
    <BadgeFrame info={info}>
      {(p, { c1 }) => (
        <g>
          <circle cx="80" cy="80" r="34" fill="none" stroke={c1} strokeWidth="1.4" opacity="0.3" />
          <circle cx="80" cy="80" r="27" fill="none" stroke={c1} strokeWidth="1.4" opacity="0.4" />
          <circle cx="80" cy="80" r="20" fill="none" stroke={c1} strokeWidth="1.4" opacity="0.5" />
          <path d="M 80 66 C 72 60 60 60 54 64 L 54 96 C 60 92 72 92 80 98 Z" fill={c1} opacity="0.85" />
          <path d="M 80 66 C 88 60 100 60 106 64 L 106 96 C 100 92 88 92 80 98 Z" fill={c1} opacity="0.6" />
          <line x1="80" y1="66" x2="80" y2="98" stroke="#FFFFFF" strokeWidth="1.4" opacity="0.7" />
          <line x1="60" y1="72" x2="74" y2="74" stroke="#FFFFFF" strokeWidth="1" opacity="0.5" />
          <line x1="60" y1="80" x2="74" y2="82" stroke="#FFFFFF" strokeWidth="1" opacity="0.4" />
          <line x1="86" y1="74" x2="100" y2="72" stroke="#FFFFFF" strokeWidth="1" opacity="0.5" />
        </g>
      )}
    </BadgeFrame>
  );
}

// ─── 3. The Dreamer - neural bloom ───────────────────────────────
function Dreamer({ info }) {
  const petals = [0, 60, 120, 180, 240, 300];
  return (
    <BadgeFrame info={info}>
      {(p, { c1 }) => (
        <g>
          {petals.map((deg) => (
            <ellipse key={deg} cx="80" cy="58" rx="8" ry="20" fill={c1} opacity="0.5" transform={`rotate(${deg} 80 80)`} />
          ))}
          {petals.map((deg) => {
            const a = (deg * Math.PI) / 180;
            return <circle key={`d${deg}`} cx={80 + Math.sin(a) * 36} cy={80 - Math.cos(a) * 36} r="2.6" fill={c1} opacity="0.7" />;
          })}
          <circle cx="80" cy="80" r="10" fill={c1} />
          <circle cx="80" cy="80" r="5" fill="#FFFFFF" opacity="0.85" />
          <circle cx="80" cy="80" r="2.4" fill={c1} />
        </g>
      )}
    </BadgeFrame>
  );
}

// ─── 4. The Spark - lightning + motion ───────────────────────────
function Spark({ info }) {
  return (
    <BadgeFrame info={info}>
      {(p, { c1, c2 }) => (
        <g>
          <path d="M 44 64 Q 56 62 66 66" fill="none" stroke={c2} strokeWidth="2.5" strokeLinecap="round" opacity="0.5" />
          <path d="M 40 80 Q 54 78 64 82" fill="none" stroke={c2} strokeWidth="2.5" strokeLinecap="round" opacity="0.4" />
          <path d="M 44 96 Q 56 94 66 98" fill="none" stroke={c2} strokeWidth="2.5" strokeLinecap="round" opacity="0.5" />
          <polygon points="92,44 66,84 82,84 70,116 104,72 86,72 98,44" fill={c1} stroke="#FFFFFF" strokeWidth="1" strokeLinejoin="round" />
          <polygon points="92,44 78,66 86,66" fill="#FFFFFF" opacity="0.4" />
        </g>
      )}
    </BadgeFrame>
  );
}

// ─── 5. The Artisan - faceted gem ────────────────────────────────
function Artisan({ info }) {
  return (
    <BadgeFrame info={info}>
      {(p, { c1 }) => (
        <g>
          <polygon points="80,46 104,66 94,108 66,108 56,66" fill={c1} stroke="#FFFFFF" strokeWidth="1.2" strokeLinejoin="round" />
          <polygon points="80,46 104,66 80,72 56,66" fill="#FFFFFF" opacity="0.28" />
          <line x1="80" y1="72" x2="80" y2="108" stroke="#FFFFFF" strokeWidth="0.9" opacity="0.45" />
          <line x1="56" y1="66" x2="80" y2="72" stroke="#FFFFFF" strokeWidth="0.9" opacity="0.4" />
          <line x1="104" y1="66" x2="80" y2="72" stroke="#FFFFFF" strokeWidth="0.9" opacity="0.4" />
          <line x1="80" y1="72" x2="66" y2="108" stroke="#FFFFFF" strokeWidth="0.7" opacity="0.3" />
          <line x1="80" y1="72" x2="94" y2="108" stroke="#FFFFFF" strokeWidth="0.7" opacity="0.3" />
          <circle cx="72" cy="60" r="1.6" fill="#FFFFFF" opacity="0.85" />
        </g>
      )}
    </BadgeFrame>
  );
}

// ─── 6. The Voyager - compass star + orbit ───────────────────────
function Voyager({ info }) {
  return (
    <BadgeFrame info={info}>
      {(p, { c1, c2 }) => (
        <g>
          <ellipse cx="80" cy="80" rx="38" ry="20" fill="none" stroke={c1} strokeWidth="1.3" opacity="0.35" transform="rotate(-25 80 80)" />
          <circle cx="113" cy="66" r="2.6" fill={c2} opacity="0.8" />
          <polygon points="80,48 86,74 80,80 74,74" fill={c1} />
          <polygon points="80,112 74,86 80,80 86,86" fill={c1} opacity="0.7" />
          <polygon points="48,80 74,74 80,80 74,86" fill={c1} opacity="0.85" />
          <polygon points="112,80 86,86 80,80 86,74" fill={c1} opacity="0.85" />
          <circle cx="80" cy="80" r="4" fill="#FFFFFF" />
          <circle cx="80" cy="80" r="2" fill={c1} />
        </g>
      )}
    </BadgeFrame>
  );
}

const MOTIFS = {
  architect: Architect,
  pathfinder: Keeper,
  maker: Dreamer,
  cartographer: Spark,
  calibrator: Artisan,
  bridgebuilder: Voyager,
};

export default function DnaBadge({ personaTitle, size = 96 }) {
  const info = getInfo(personaTitle);
  const Motif = MOTIFS[info.id] || Voyager;
  return (
    <div style={{ width: size, height: size, flexShrink: 0 }}>
      <Motif info={info} />
    </div>
  );
}

export { ARCHETYPES, getInfo };
