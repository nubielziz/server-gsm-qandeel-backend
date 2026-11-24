// IMEI intent of the storefront search (feature 29, plan section 5.2): a visitor who pastes an IMEI is not searching, and the IMEI is never recorded.
// Pure.

/** The separators a pasted IMEI may carry: spaces, dashes, dots and slashes. */
const SEPARATORS = /[\s\-./]/g;

/**
 * Checks the Luhn digit of a digit string.
 *
 * @param digits the digits, the check digit last
 * @returns true when the sum is a multiple of 10
 */
export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits.charCodeAt(index) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Tells whether the typed text is an IMEI.
 *
 * Why: plan section 5.2: after removing spaces, dashes, dots and slashes, 15 digits with a valid Luhn check, or 16 digits (an IMEISV:
 * the 14 digits of the IMEI and 2 of software version, which carry no check digit). Such an answer runs no search and is never recorded
 * (an IMEI is a personal identifier of a phone).
 *
 * @param text what the visitor typed
 * @returns `'imei'` for an IMEI or an IMEISV, otherwise `null`
 */
export function imeiIntent(text: string): 'imei' | null {
  const digits = text.replace(SEPARATORS, '');
  if (!/^\d+$/.test(digits)) return null;
  if (digits.length === 15) return luhnValid(digits) ? 'imei' : null;
  return digits.length === 16 ? 'imei' : null;
}
