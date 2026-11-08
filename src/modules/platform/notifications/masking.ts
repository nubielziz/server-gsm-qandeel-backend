// Masks recipients of the notification log (platform module, feature 12a, RULES settings 11, M172): the server hides most of an
// address or chat before it leaves the API, so the console never holds more than it prints.

/**
 * Hides most of an email address.
 *
 * Why: the notification log shows who a message went to, but staff reading it do not need the whole address: the first letter and
 * the domain tell the mail apart (`r***@example.com`).
 *
 * @param email an email address
 * @returns the first letter, three stars and the domain; `***` when the text is not an address
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  return `${email.charAt(0)}***${email.slice(at)}`;
}

/**
 * Hides most of a Telegram chat.
 *
 * Why: the merchant's linked chat is an id, not a username, so the mask is an at sign, the first character of the id and three stars
 * (`@1***`), the shape the console prints for a Telegram recipient.
 *
 * @param chatId the Telegram chat id, as text
 * @returns the masked chat; `@***` when there is none
 */
export function maskTelegram(chatId: string | null | undefined): string {
  const first = chatId?.trim().charAt(0) ?? '';
  return first === '' ? '@***' : `@${first}***`;
}

/** Matches an email address inside free text. */
const EMAIL_IN_TEXT = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Masks every email address inside a text and shortens it.
 *
 * Why: a provider's refusal often repeats the address (`550 5.1.1 <user@example.com>: Recipient address rejected`); the failure
 * reason is stored on the row, shown to staff and logged, and a full address must reach none of them (decision 033).
 *
 * @param text an error message from a provider
 * @param max the longest result, in characters
 * @returns the text with addresses masked, at most `max` characters
 */
export function redactAddresses(text: string, max = 300): string {
  const masked = text
    .replace(EMAIL_IN_TEXT, (address) => maskEmail(address))
    .replace(/\s+/g, ' ')
    .trim();
  return masked.length > max ? `${masked.slice(0, max - 1)}…` : masked;
}
