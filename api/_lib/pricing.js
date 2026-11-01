/* Per-school invoice pricing (#311).
 *
 * A school may have price bands, "up to N marks → ₹X per paper". A paper takes
 * the first band whose limit is at least its total (52 marks → "up to 70").
 * A school without bands keeps the default: 25 paise per mark (₹0.25/mark).
 * A banded school's paper above its top band has no price: generation is
 * refused until a band covers it. Prices apply when an invoice is generated;
 * every invoice line freezes the price it was billed at.
 */

export const DEFAULT_RATE_PAISE_PER_MARK = 25;
export const MAX_BANDS = 10;
const MAX_LIMIT = 1000;
const MAX_PRICE_PAISE = 1_000_000; // ₹10,000 per paper

/**
 * Validate bands from user input: [{ maxMarks, pricePaise }]. Returns
 * { bands } sorted by limit, or { error }. An empty list means the default.
 */
export function validateBands(input) {
  if (input == null) return { bands: [] };
  if (!Array.isArray(input)) return { error: 'bands must be a list.' };
  if (input.length > MAX_BANDS) return { error: `At most ${MAX_BANDS} price bands per school.` };
  const bands = [];
  for (const band of input) {
    const maxMarks = Number(band?.maxMarks);
    const pricePaise = Number(band?.pricePaise);
    if (!Number.isInteger(maxMarks) || maxMarks < 1 || maxMarks > MAX_LIMIT) return { error: `Each band needs a whole-number marks limit from 1 to ${MAX_LIMIT}.` };
    if (!Number.isInteger(pricePaise) || pricePaise < 1 || pricePaise > MAX_PRICE_PAISE) return { error: 'Each band needs a price of at least ₹0.01 (and at most ₹10,000) per paper.' };
    bands.push({ maxMarks, pricePaise });
  }
  bands.sort((a, b) => a.maxMarks - b.maxMarks);
  for (let i = 1; i < bands.length; i += 1) {
    if (bands[i].maxMarks === bands[i - 1].maxMarks) return { error: `Two bands share the limit "up to ${bands[i].maxMarks} marks".` };
  }
  return { bands };
}

/**
 * The price of one paper. Returns { amountPaise, ratePaisePerMark,
 * pricePaisePerPaper } or null when a banded school has no band covering the
 * paper's total.
 */
export function priceForPaper(maxMarks, bands = []) {
  const total = Number(maxMarks);
  if (!bands.length) return { amountPaise: Math.round(total * DEFAULT_RATE_PAISE_PER_MARK), ratePaisePerMark: DEFAULT_RATE_PAISE_PER_MARK, pricePaisePerPaper: null };
  const band = bands.find((candidate) => candidate.maxMarks >= total);
  return band ? { amountPaise: band.pricePaise, ratePaisePerMark: null, pricePaisePerPaper: band.pricePaise } : null;
}

export async function getPricingBands(db, schoolId) {
  const result = await db.execute({ sql: 'SELECT max_marks, price_paise FROM school_pricing_bands WHERE school_id = ? ORDER BY max_marks', args: [schoolId] });
  return result.rows.map((row) => ({ maxMarks: Number(row.max_marks), pricePaise: Number(row.price_paise) }));
}

/** All schools' bands, keyed by school id (for the billing-profiles list). */
export async function getAllPricingBands(db) {
  const result = await db.execute('SELECT school_id, max_marks, price_paise FROM school_pricing_bands ORDER BY school_id, max_marks');
  const bySchool = new Map();
  for (const row of result.rows) {
    if (!bySchool.has(row.school_id)) bySchool.set(row.school_id, []);
    bySchool.get(row.school_id).push({ maxMarks: Number(row.max_marks), pricePaise: Number(row.price_paise) });
  }
  return bySchool;
}

/** Statements that replace a school's bands (run in the same batch as the profile save). */
export function replaceBandsStatements(schoolId, bands, { updatedBy, now }) {
  return [
    { sql: 'DELETE FROM school_pricing_bands WHERE school_id = ?', args: [schoolId] },
    ...bands.map((band) => ({
      sql: 'INSERT INTO school_pricing_bands (school_id, max_marks, price_paise, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)',
      args: [schoolId, band.maxMarks, band.pricePaise, updatedBy, now],
    })),
  ];
}
