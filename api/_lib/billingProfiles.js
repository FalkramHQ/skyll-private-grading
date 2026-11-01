/* School billing profiles (FLKRM-485): the Bill To / GSTN / PAN / Place of
 * Supply blocks of a Skyll invoice. The profile also decides who is invoiced:
 * a school without one (demo and internal schools) is never billed. */

/** Place of supply: the 28 states and 8 union territories of India. */
export const INDIAN_STATES = Object.freeze([
  'Andaman and Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chandigarh',
  'Chhattisgarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Goa', 'Gujarat', 'Haryana',
  'Himachal Pradesh', 'Jammu and Kashmir', 'Jharkhand', 'Karnataka', 'Kerala', 'Ladakh', 'Lakshadweep',
  'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Puducherry',
  'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand',
  'West Bengal',
]);

const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PAN = /^[A-Z]{5}\d{4}[A-Z]$/;
const LIMITS = { legalName: 200, address: 500 };

const clean = (value) => String(value ?? '').trim();
const taxId = (value) => clean(value).toUpperCase().replace(/\s+/g, '');

/**
 * Validate and normalise a profile from user input. Returns { profile } or
 * { error }. GSTIN and PAN are optional (not every institute is
 * GST-registered) but must be well-formed when given.
 */
export function validateBillingProfile(input = {}) {
  const legalName = clean(input.legalName).replace(/\s+/g, ' ');
  // Keep the address's line breaks (it prints as-is in Bill To), tidy the rest.
  const address = clean(input.address).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join('\n');
  const gstin = taxId(input.gstin) || null;
  const pan = taxId(input.pan) || null;
  const placeOfSupply = clean(input.placeOfSupply);
  if (!legalName) return { error: 'Legal name is required.' };
  if (legalName.length > LIMITS.legalName) return { error: `Legal name must be at most ${LIMITS.legalName} characters.` };
  if (!address) return { error: 'Address is required.' };
  if (address.length > LIMITS.address) return { error: `Address must be at most ${LIMITS.address} characters.` };
  if (!INDIAN_STATES.includes(placeOfSupply)) return { error: 'Place of supply must be an Indian state or union territory.' };
  if (gstin && !GSTIN.test(gstin)) return { error: 'GSTIN is not in the valid 15-character format.' };
  if (pan && !PAN.test(pan)) return { error: 'PAN is not in the valid 10-character format (e.g. ABCDE1234F).' };
  return { profile: { legalName, address, gstin, pan, placeOfSupply } };
}

/** API shape of a school_billing_profiles row (null when there is none). */
export function presentBillingProfile(row) {
  if (!row) return null;
  return {
    schoolId: row.school_id,
    legalName: row.legal_name,
    address: row.address,
    gstin: row.gstin || null,
    pan: row.pan || null,
    placeOfSupply: row.place_of_supply,
    updatedBy: row.updated_by || null,
    updatedAt: row.updated_at || null,
  };
}

/** Invoice generation requires legal name, address and place of supply. */
export function isBillingProfileComplete(profile) {
  return Boolean(profile && clean(profile.legalName) && clean(profile.address) && INDIAN_STATES.includes(profile.placeOfSupply));
}

export async function getBillingProfile(db, schoolId) {
  const result = await db.execute({ sql: 'SELECT * FROM school_billing_profiles WHERE school_id = ? LIMIT 1', args: [schoolId] });
  return presentBillingProfile(result.rows[0]);
}
