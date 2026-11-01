import MathText from './MathText';

/* Outcome tints for a sub-part. Full marks are success green; the words in the
 * status pill carry the meaning, the tint only confirms it. */
function outcomeOf(part) {
  if (part.marks_total > 0 && part.marks_obtained >= part.marks_total) {
    return { bg: 'var(--success-soft)', color: 'var(--success-soft-foreground)' };
  }
  if (part.marks_obtained > 0) return { bg: 'var(--warning-soft)', color: 'var(--warning-soft-foreground)' };
  return { bg: 'var(--sunken)', color: 'var(--foreground-secondary)' };
}

const LABEL = { fontSize: 12, fontWeight: 700, color: 'var(--foreground-secondary)', letterSpacing: '0.02em', margin: '0 0 4px' };
const LINE = { fontSize: 13, margin: '0 0 3px', lineHeight: 1.5 };

/* Presentational sub-part breakdown for structured compound questions.
 * Renders one readable row per sub-part: label + marks, a text status badge
 * (state is never conveyed by colour alone), the prompt, the student's response,
 * and the expected answer where not fully correct. The overall question total is
 * shown by the caller (header chip); each row carries marks_obtained/marks_total
 * so the row sum is checkable. `reasoning` is collapsible via native <details>. */
export default function SubPartBreakdown({ parts = [], reasoning = '', block = false }) {
  if (!Array.isArray(parts) || parts.length === 0) return null;

  return (
    <div className={block ? 'subpart-breakdown' : undefined} style={{ marginBottom: 8 }}>
      <p style={LABEL}>Sub-part breakdown</p>
      <div style={{ border: '1px solid var(--hairline)', borderRadius: 10, overflow: 'hidden', background: '#fff' }}>
        {parts.map((part, pi) => {
          const outcome = outcomeOf(part);
          return (
            <div key={pi} className="subpart-breakdown-row" style={{ display: 'grid', gridTemplateColumns: 'minmax(48px, auto) 1fr', gap: 8, padding: '10px 12px', borderTop: pi === 0 ? 'none' : '1px solid var(--hairline)', alignItems: 'start' }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)', whiteSpace: 'nowrap' }}>{part.label}</span>
                <span style={{ fontSize: 13, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: 'var(--ink)', background: '#fff', border: '1.5px solid var(--ink)', padding: '0 7px', borderRadius: 999, whiteSpace: 'nowrap' }}>
                  {part.marks_obtained}/{part.marks_total}
                </span>
              </div>
              <div style={{ minWidth: 0 }}>
                <span style={{ display: 'inline-block', fontSize: 12, fontWeight: 700, color: outcome.color, background: outcome.bg, padding: '2px 8px', borderRadius: 999, marginBottom: 5 }}>
                  {part.statusLabel || part.status || 'Not attempted'}
                </span>
                {part.prompt && <p style={{ ...LINE, color: 'var(--ink)' }}><strong>Prompt:</strong> <MathText text={part.prompt} stripJargon={false} /></p>}
                {part.response && <p style={{ ...LINE, color: 'var(--foreground-secondary)' }}><strong>Your answer:</strong> <MathText text={part.response} stripJargon={false} /></p>}
                {part.expected != null && part.expected !== '' && part.status !== 'correct' && (
                  <p style={{ ...LINE, color: 'var(--ink)' }}><strong style={{ color: 'var(--success-soft-foreground)' }}>Expected:</strong> <MathText text={part.expected} stripJargon={false} /></p>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {reasoning && (
        <details style={{ marginTop: 6 }}>
          <summary style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', cursor: 'pointer', userSelect: 'none', padding: '4px 0' }}>Detailed reasoning</summary>
          <div className="markdown-content" style={{ fontSize: 13, color: 'var(--foreground-secondary)', margin: '6px 0 0', lineHeight: 1.55, padding: '8px 10px', background: 'var(--paper)', borderRadius: 8 }}>
            <MathText text={reasoning} stripJargon={false} block />
          </div>
        </details>
      )}
    </div>
  );
}
