// Phone number normalisation for messaging providers (WhatsApp/SMS).
// Neutral helper shared by the server and the browser (CRM form validation).

/**
 * Normalise a phone number to E.164.
 * Indian numbers: 10-digit → +91XXXXXXXXXX; leading 0/00 stripped.
 * Returns null when the input cannot be a valid mobile number.
 */
export function normalizePhone(raw, defaultCountryCode = '91') {
  if (!raw) return null;
  let digits = String(raw).replace(/[^\d+]/g, '');
  const hadPlus = digits.startsWith('+');
  digits = digits.replace(/\+/g, '');

  if (hadPlus) {
    return digits.length >= 10 && digits.length <= 15 ? `+${digits}` : null;
  }
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 10) return `+${defaultCountryCode}${digits}`;
  if (digits.length === 12 && digits.startsWith(defaultCountryCode)) return `+${digits}`;
  return digits.length >= 10 && digits.length <= 15 ? `+${digits}` : null;
}
