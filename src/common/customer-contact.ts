// How staff answers outside the Accounts pages show an account's email address (decisions 047 and 064): masked unless the caller may
// read accounts. Pure; the modules that build those answers share it.

/**
 * What a staff caller may see of an account's contact details outside the Accounts pages.
 *
 * Why: decisions 047 and 064: the address is personal data, so a staff answer carries it in full only for a caller whose role grants
 * `clients:read` (identity's `customerContactOf` decides it), for an account of any rank; everybody else reads the masked form.
 */
export type CustomerContact = 'full' | 'masked';

const CONSOLE_MASK = /^(.{2}).*(@.*)$/;

/**
 * Hides most of an email address: the first two characters, three bullets and the domain (`ja•••@example.com`).
 *
 * Why: decision 047: the console masks an address with this exact pattern and replacement, so its own second pass changes nothing; an
 * address the console would leave whole (a one-character local part, a text without `@`) is hidden here, never shown.
 *
 * @param email the address (any text; an empty string stays empty because there is nothing to hide)
 * @returns the masked text
 */
export function maskCustomerEmail(email: string): string {
  if (email === '') return '';
  // The console's own maskEmail (src/lib/format/text.ts): the same pattern and replacement.
  if (CONSOLE_MASK.test(email)) return email.replace(CONSOLE_MASK, '$1•••$2');
  // The console would leave these whole (a one-character local part, no @): they are hidden here.
  const at = email.lastIndexOf('@');
  return at < 0 ? '•••' : '•••' + email.slice(at);
}

/**
 * Chooses the form of an account's address for a caller.
 *
 * Why: decision 047, rule A: every staff answer outside the Accounts pages passes an account's address through this.
 *
 * @param contact what the caller may see
 * @param email the stored address
 * @returns the address as it is (`full`) or masked
 */
export function customerEmailIn(contact: CustomerContact, email: string): string {
  return contact === 'full' ? email : maskCustomerEmail(email);
}

/**
 * The label of an account in a staff answer: the name, or the masked address when the name is empty.
 *
 * Why: decision 047, rule B: a name never falls back to the full address, for any caller.
 *
 * @param name the account's name (may be empty)
 * @param email the account's address
 * @returns the name, or the masked address
 */
export function customerNameForStaff(name: string, email: string): string {
  return name || maskCustomerEmail(email);
}
