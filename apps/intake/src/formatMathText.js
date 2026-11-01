/**
 * Turn common LaTeX / math markup into readable plain text for React Native.
 * OTA-safe: no native KaTeX / WebView dependency.
 */

function unwrapBraces(input) {
  const text = String(input || '');
  if (text.startsWith('{') && text.endsWith('}')) return text.slice(1, -1);
  return text;
}

function replaceCommand(text, command, replacer) {
  const pattern = new RegExp(`\\\\${command}\\s*(\\{[^{}]*\\}|[A-Za-z0-9])`, 'g');
  return text.replace(pattern, (_, arg) => replacer(unwrapBraces(arg)));
}

function replaceFrac(text) {
  return text.replace(/\\frac\s*(\{[^{}]*\}|[A-Za-z0-9])\s*(\{[^{}]*\}|[A-Za-z0-9])/g, (_, num, den) => {
    return `(${unwrapBraces(num)})/(${unwrapBraces(den)})`;
  });
}

function replaceSqrt(text) {
  return text.replace(/\\sqrt\s*(?:\[[^\]]*\])?\s*(\{[^{}]*\}|[A-Za-z0-9])/g, (_, arg) => {
    return `√(${unwrapBraces(arg)})`;
  });
}

function replaceVec(text) {
  return replaceCommand(text, 'vec', (arg) => `${arg}⃗`);
}

function replaceOverline(text) {
  return replaceCommand(text, 'overline', (arg) => `${arg}̅`);
}

function replaceText(text) {
  return replaceCommand(text, 'text', (arg) => arg)
    .replace(/\\mathrm\s*(\{[^{}]*\}|[A-Za-z0-9])/g, (_, arg) => unwrapBraces(arg))
    .replace(/\\mathbf\s*(\{[^{}]*\}|[A-Za-z0-9])/g, (_, arg) => unwrapBraces(arg));
}

const SYMBOL_MAP = [
  [/\\times/g, '×'],
  [/\\div/g, '÷'],
  [/\\pm/g, '±'],
  [/\\mp/g, '∓'],
  [/\\cdot/g, '·'],
  [/\\bullet/g, '•'],
  [/\\leq|\\le\b/g, '≤'],
  [/\\geq|\\ge\b/g, '≥'],
  [/\\neq|\\ne\b/g, '≠'],
  [/\\approx/g, '≈'],
  [/\\infty/g, '∞'],
  [/\\rightarrow|\\to\b/g, '→'],
  [/\\leftarrow/g, '←'],
  [/\\Rightarrow/g, '⇒'],
  [/\\Leftrightarrow|\\iff/g, '⇔'],
  [/\\degree/g, '°'],
  [/\\%/g, '%'],
  [/\\alpha/g, 'α'],
  [/\\beta/g, 'β'],
  [/\\gamma/g, 'γ'],
  [/\\delta/g, 'δ'],
  [/\\theta/g, 'θ'],
  [/\\lambda/g, 'λ'],
  [/\\mu/g, 'μ'],
  [/\\pi/g, 'π'],
  [/\\sigma/g, 'σ'],
  [/\\phi/g, 'φ'],
  [/\\omega/g, 'ω'],
  [/\\Delta/g, 'Δ'],
  [/\\Sigma/g, 'Σ'],
  [/\\Omega/g, 'Ω'],
  [/\\left\s*/g, ''],
  [/\\right\s*/g, ''],
  [/\\,/g, ' '],
  [/\\;/g, ' '],
  [/\\!/g, ''],
  [/\\quad/g, '  '],
  [/\\qquad/g, '    '],
  [/\\\\/g, '\n'],
];

/**
 * @param {unknown} value
 * @returns {string}
 */
export function formatMathText(value) {
  if (value == null) return '';
  let text = String(value);
  if (!text.trim()) return '';

  // Normalize common delimiters first.
  text = text
    .replace(/\$\$([\s\S]*?)\$\$/g, '$1')
    .replace(/\$([^$]+)\$/g, '$1')
    .replace(/\\\(([\s\S]*?)\\\)/g, '$1')
    .replace(/\\\[([\s\S]*?)\\\]/g, '$1');

  // Iteratively expand nested-ish simple commands.
  for (let i = 0; i < 4; i += 1) {
    const before = text;
    text = replaceFrac(text);
    text = replaceSqrt(text);
    text = replaceVec(text);
    text = replaceOverline(text);
    text = replaceText(text);
    text = replaceCommand(text, 'hat', (arg) => `${arg}̂`);
    text = replaceCommand(text, 'bar', (arg) => `${arg}̄`);
    if (text === before) break;
  }

  for (const [pattern, replacement] of SYMBOL_MAP) {
    text = text.replace(pattern, replacement);
  }

  // Superscripts / subscripts: x^{2}, x_1, x^2
  text = text
    .replace(/\^\{([^{}]+)\}/g, '^($1)')
    .replace(/_\{([^{}]+)\}/g, '_($1)')
    .replace(/\^([A-Za-z0-9+-])/g, '^$1')
    .replace(/_([A-Za-z0-9+-])/g, '_$1');

  // Strip remaining simple braces used only for grouping.
  text = text.replace(/\{([^{}]+)\}/g, '$1');

  // Drop leftover single backslash commands we did not map.
  text = text.replace(/\\([a-zA-Z]+)/g, '$1');

  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
