// A short built-in list of throw-away mailbox providers (feature 18): the "Disposable email domain" signal and the rule that blocks
// them. Staff add more domains to the blocklist (kind `domain`), which blocks them outright. Pure, no database.

/** Domains of well-known disposable mailbox services, lower case. */
export const DISPOSABLE_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  '10minutemail.com',
  '10minutemail.net',
  '20minutemail.com',
  'guerrillamail.com',
  'guerrillamail.net',
  'guerrillamail.org',
  'guerrillamailblock.com',
  'sharklasers.com',
  'grr.la',
  'mailinator.com',
  'maildrop.cc',
  'tempmail.com',
  'temp-mail.org',
  'temp-mail.io',
  'tempmailo.com',
  'tempinbox.com',
  'throwawaymail.com',
  'trashmail.com',
  'trashmail.net',
  'yopmail.com',
  'yopmail.net',
  'getnada.com',
  'nada.email',
  'dispostable.com',
  'fakeinbox.com',
  'mintemail.com',
  'mailnesia.com',
  'mohmal.com',
  'emailondeck.com',
  'spamgourmet.com',
  'burnermail.io',
  'discard.email',
  'moakt.com',
  'tempail.com',
  'mytemp.email',
]);

/**
 * Tells whether an email address belongs to a disposable mailbox provider.
 *
 * @param email an address
 * @returns true when its domain (or a parent domain) is on the list
 */
export function isDisposableEmail(email: string): boolean {
  const domain = email
    .slice(email.lastIndexOf('@') + 1)
    .trim()
    .toLowerCase();
  if (domain === '') return false;
  const labels = domain.split('.');
  // `mail.yopmail.com` is the same provider as `yopmail.com`.
  for (let start = 0; start < labels.length - 1; start += 1) {
    if (DISPOSABLE_EMAIL_DOMAINS.has(labels.slice(start).join('.'))) return true;
  }
  return false;
}
