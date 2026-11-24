// The stateless token of a marketing email's unsubscribe link (feature 23, plan section 9.6, S10): the account id and a keyed MAC over it.
import type { TokenService } from '../../../../infra/crypto';

/** How many hex characters of the MAC the token keeps: 128 bits. */
const MAC_HEX_LENGTH = 32;
/**
 * The message a new token signs (decision 064): the account id under a prefix of its own, so the token of account 7 never equals
 * the token that was sent to customer 7 before the accounts were merged (customer 7 and account 7 are different people).
 */
const ACCOUNT_PREFIX = 'marketing-unsubscribe:account:';
/** The message a token sent before the accounts were merged signed: the old customer number. Read only, never made. */
const CUSTOMER_PREFIX = 'marketing-unsubscribe:customer:';

/** The id in base 36, when it is a positive safe integer written the way `toString(36)` writes it. */
function idOf(text: string): number | undefined {
  const id = Number.parseInt(text, 36);
  return Number.isSafeInteger(id) && id > 0 && id.toString(36) === text ? id : undefined;
}

const macOf = (tokens: TokenService, prefix: string, id: number): string =>
  tokens.lookupHash(`${prefix}${id}`).slice(0, MAC_HEX_LENGTH);

/**
 * Whom an unsubscribe token names.
 *
 * Why: `account` is an account id. `customer` is an old customer number from a mail sent before the accounts were merged: it is NOT an account
 * id and must be resolved through the legacy id map (`LegacyAccounts.resolve('customer', id)`), never read as one.
 */
export interface UnsubscribeSubject {
  readonly kind: 'account' | 'customer';
  readonly id: number;
}

/**
 * Makes the unsubscribe token of an account.
 *
 * Why: S10: an unsubscribe link must keep working for as long as the email exists, so the token is stateless and never expires; it is
 * `<id in base 36>.<128 bits of HMAC-SHA256(lookup key, 'marketing-unsubscribe:account:' + id)>`. The id is not secret, the MAC is, and the
 * token can only switch marketing off, never on.
 *
 * @param tokens the token service (the lookup key `LOOKUP_HASH_KEY`, decision 054: a link in a sent mail keeps working when the pepper changes)
 * @param accountId the account (any rank; a guest row too)
 * @returns the token (letters, digits and one dot)
 */
export function marketingUnsubscribeToken(tokens: TokenService, accountId: number): string {
  return `${accountId.toString(36)}.${macOf(tokens, ACCOUNT_PREFIX, accountId)}`;
}

/**
 * Reads an unsubscribe token.
 *
 * Why: decision 064: the two prefixes share one token format, so only the MAC tells them apart: a token that verifies under the account prefix
 * names an account; one that verifies under the old customer prefix (sent before the release, never expiring) names an old customer
 * number. Both comparisons run, so the time taken does not say which one matched.
 *
 * @param tokens the token service
 * @param token the text of the link
 * @returns the account or the old customer number the token names, or `undefined` when the token is malformed, tampered with or made for another id
 */
export function parseMarketingUnsubscribeToken(tokens: TokenService, token: string): UnsubscribeSubject | undefined {
  const match = /^([0-9a-z]{1,13})\.([0-9a-f]{32})$/.exec(token);
  if (!match) return undefined;
  const id = idOf(match[1]!);
  if (id === undefined) return undefined;
  const isAccount = tokens.equals(match[2]!, macOf(tokens, ACCOUNT_PREFIX, id));
  const isCustomer = tokens.equals(match[2]!, macOf(tokens, CUSTOMER_PREFIX, id));
  if (isAccount) return { kind: 'account', id };
  return isCustomer ? { kind: 'customer', id } : undefined;
}
