// Input rules of the admin customer routes (POST and PATCH /admin/customers): how a typed name, email, phone and note are
// cleaned before they are stored. Pure functions, unit-tested; the zod contracts apply them on the way in.

/** The fewest characters a customer name has once tidied (the console's dialog says the same). */
export const MIN_NAME_LENGTH = 2;
/** The most characters a customer name may have. */
export const MAX_NAME_LENGTH = 120;
/** The most characters of a phone number. */
export const MAX_PHONE_LENGTH = 40;
/** The most characters of the internal note (the console's dialog limit, customers.md PATCH). */
export const MAX_NOTES_LENGTH = 300;
/** The languages a customer can use (the console's LOCALES). */
export const CUSTOMER_LOCALES = ['en', 'ar'] as const;

/** One value of {@link CUSTOMER_LOCALES}. */
export type CustomerLocale = (typeof CUSTOMER_LOCALES)[number];

/**
 * Tidies a name: trimmed, and every run of white space made one space.
 *
 * Why: customers.md POST: "name (trimmed, inner spaces collapsed, >= 2 chars)"; the same text must not be stored twice
 * with different spacing.
 *
 * @param name the name as typed
 * @returns the tidied name
 */
export function cleanName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

/**
 * Normalises an email as it is stored and compared: trimmed and in lower case.
 *
 * Why: the unique index on `lower(email)` and the blocklist hash compare this form, so every lookup uses it.
 *
 * @param email the email as typed
 * @returns the normalised email
 */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Tidies a phone number: trimmed.
 *
 * Why: the console sends `phone` left out when empty; the column stores `''` for none (customers.md).
 *
 * @param phone the phone as typed
 * @returns the trimmed phone
 */
export function cleanPhone(phone: string): string {
  return phone.trim();
}
