const LONG_DATE = { day: 'numeric', month: 'long', year: 'numeric' };

/**
 * A stored date or timestamp as "25 October 2026". A date-only value
 * ("2026-10-25") is read as that calendar day, not UTC midnight, so it never
 * shifts a day. Anything unparseable gives '' rather than raw text on screen.
 */
export function formatLongDate(value, options = LONG_DATE) {
  if (!value) return '';
  const raw = String(value).trim();
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00` : raw);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('en-IN', options);
}
