// Masking of personal data in logs (decision 012): email as r***@domain, phone and IMEI keep only their last digits.
// Registered as pino serializers for the keys `email`, `phone` and `imei`; call the functions directly for nested data.

/**
 * Masks an email address: first character of the name, `***`, then the domain.
 *
 * Why: logs are shipped to a log store; staff and customers' addresses must not be readable there (decision 012).
 *
 * @param value an email address (anything else is hidden completely)
 * @returns e.g. `r***@gsm-supply.example`, or `***` when the value is not an email
 */
export function maskEmail(value: unknown): string {
  const match = typeof value === 'string' ? /^([^@\s])[^@\s]*@([^@\s]+)$/.exec(value) : null;
  return match ? `${match[1]}***@${match[2]}` : '***';
}

function keepLastDigits(value: unknown, keep: number): string {
  const digits = typeof value === 'string' || typeof value === 'number' ? String(value).replace(/\D/g, '') : '';
  return digits.length > keep ? `***${digits.slice(-keep)}` : '***';
}

/**
 * Masks a phone number, keeping the last 3 digits.
 *
 * Why: decision 012: phone numbers are personal data and must not be readable in a log store.
 *
 * @param value a phone number in any format
 * @returns e.g. `***567`, or `***` when there are too few digits
 */
export function maskPhone(value: unknown): string {
  return keepLastDigits(value, 3);
}

/**
 * Masks an IMEI, keeping the last 4 digits.
 *
 * Why: decision 012: an IMEI identifies a customer's device; only its last digits help support.
 *
 * @param value an IMEI (15 digits, spaces and dashes allowed)
 * @returns e.g. `***3809`, or `***` when there are too few digits
 */
export function maskImei(value: unknown): string {
  return keepLastDigits(value, 4);
}
