// Skyll Notebook design tokens for the intake app (React Native).
// Single source of truth for colour, type, radius and hard shadows; mirrors the
// web tokens in src/index.css so the phone and the web read as one product.
//
// Two volumes:
//   LOUD  (student, parent, operator sitting, login, empty/success): 2px ink
//         borders, hard offset shadows, lime/coral stickers (max 2 per screen).
//   QUIET (teacher, admin, settings): paper page, white cards with 1px
//         hairlines, no stickers. Only the primary button gets the hard shadow.

const ink = '#111111';
const paper = '#F5F3EC';
const hairline = '#D9D5CA';
const action = '#3A3AE8';
const actionTint = '#E4E4FB';
const caution = '#8A4B00';

export const palette = {
  // Surfaces
  paper,
  paperSoft: '#FAF8F2',
  sunken: '#ECE9E0',
  white: '#FFFFFF',
  // Ink and text
  ink,
  textSecondary: '#4D4B45',
  muted: '#625F57', // captions, 5.7:1 on paper
  faint: '#8F8B80', // icons and borders only, never text
  inkMutedOnDark: '#BDB9AE', // secondary text on an ink surface
  // Lines
  hairline,
  hairlineStrong: '#C9C4B6',
  // Brand
  action, // white text on it
  actionPressed: '#2A2AB8',
  actionTint,
  lime: '#C9F230', // ink text only
  coral: '#FF6A3D', // ink text only; "next up", never an error
  // Sequential ramp for magnitude charts (light to dark); text never wears these.
  seq1: '#A9A9F4',
  seq2: '#7C7CEF',
  seq3: '#4B4BE8',
  seq4: '#2E2EC2',
  seq5: '#1C1C80',
  // Semantic status (always paired with words or an icon)
  success: '#0B6B3A',
  successSoft: '#DFF5E7',
  caution,
  cautionSoft: '#FFF1CC',
  danger: '#B4122E',
  dangerSoft: '#FDE8EA',
  scrim: 'rgba(17, 17, 17, 0.55)',

  // Legacy names kept so older call sites keep working.
  green: action, // brand/action colour (was emerald); success uses `success`
  mint: actionTint, // selected/active tint
  canvas: paper,
  line: hairline,
  amber: caution,
};

// Font family names registered by src/fonts.js. Each weight is its own family.
export const fontFamily = {
  display: 'BricolageGrotesque_800ExtraBold',
  regular: 'InstrumentSans_400Regular',
  semibold: 'InstrumentSans_600SemiBold',
  bold: 'InstrumentSans_700Bold',
};

// Spread into a Text style: `{ ...type.display, fontSize: 26 }`.
//
// No fontWeight on purpose. On Android, React Native resolves a runtime-loaded
// family only for normal weight: any fontWeight >= 700 skips the loaded file
// and draws the system bold instead. The weight lives in the family name. If
// the fonts never load, the unknown family falls back to the system font.
export const type = {
  display: { fontFamily: fontFamily.display },
  regular: { fontFamily: fontFamily.regular },
  semibold: { fontFamily: fontFamily.semibold },
  bold: { fontFamily: fontFamily.bold },
};

export const radius = { button: 10, control: 12, card: 16, hero: 20, pill: 999 };

// Hard offset shadows (no blur). React Native renders `boxShadow` natively on
// the New Architecture; older Android versions simply show no shadow.
export const shadow = {
  sm: `2px 2px 0px ${ink}`,
  md: `3px 3px 0px ${ink}`,
  lg: `4px 4px 0px ${ink}`,
  xl: `5px 5px 0px ${ink}`,
};

// Pressed state for loud buttons: the surface sinks 2px into its shadow.
export const pressedSink = { transform: [{ translateX: 2 }, { translateY: 2 }], boxShadow: `2px 2px 0px ${ink}` };
