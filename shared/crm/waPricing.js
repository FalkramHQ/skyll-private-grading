// Meta's WhatsApp prices for India, used for estimates and the monthly limit
// (CRM M2 phase 2, D15). Meta bills per delivered template message; these are
// estimates shown to staff, not invoices. Amounts are millipaise (1/1000 of a
// paisa) because the prices are fractions of a paisa. Before 18% GST.
export const WA_PRICES_MILLIPAISE = Object.freeze({
  utility: 11_500, // ₹0.115
  marketing: 86_310, // ₹0.8631 (Skyll sends none)
  service: 11_500, // free-text replies after the monthly free allowance
});

// Free-text replies inside the 24-hour window are free up to this many per number per month.
export const WA_FREE_SERVICE_PER_MONTH = 1000;
export const GST_RATE = 0.18;

/** Millipaise → paise including GST, rounded up (what a class would roughly pay). */
export function withGstPaise(millipaise) {
  return Math.ceil((Number(millipaise || 0) * (1 + GST_RATE)) / 1000);
}

/** "≈ ₹5" style estimate text for millipaise before GST. */
export function estimateLabel(millipaise) {
  const paise = withGstPaise(millipaise);
  if (paise === 0) return 'free';
  const rupees = paise / 100;
  return `≈ ₹${rupees < 10 ? rupees.toFixed(2) : Math.round(rupees).toLocaleString('en-IN')}`;
}
