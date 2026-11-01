/* Invoice formatting shared by the PDF (api/_lib/invoicePdf.js) and the admin
 * page (src/pages/AdminInvoices.jsx), so the two never disagree (FLKRM-487). */

const inrNumber = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const asDate = (value) => new Date(`${String(value).slice(0, 10)}T00:00:00Z`);

/** Paise → "1,23,456.75": Indian digit grouping, no currency sign. */
export const formatINR = (paise) => inrNumber.format(Number(paise || 0) / 100);

/** '2026-09' → 'September 2026'. */
export const periodLabel = (period) => new Date(`${period}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** '2026-09-05' → '5 Sept 2026'; empty → '—'. */
export const shortDate = (date) => (date ? asDate(date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—');

/** '2026-10-02' → '2 October 2026'. */
export const longDate = (date) => asDate(date).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** 'SKY/2026-27/0001' → 'SKY-2026-27-0001.pdf'. */
export const invoicePdfFilename = (number) => `${String(number).replace(/\//g, '-')}.pdf`;

/**
 * Rate column of an invoice line: '₹20.00 / paper' for a banded line (#311),
 * '₹0.25 / mark' for the default per-mark rule.
 */
export const formatLineRate = (line) => (line?.pricePaisePerPaper != null
  ? `₹${formatINR(line.pricePaisePerPaper)} / paper`
  : `₹${formatINR(line?.ratePaisePerMark)} / mark`);
