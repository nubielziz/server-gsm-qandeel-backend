// The stateless token of a marketing email's unsubscribe link (feature 23, plan section 9.6, S10): the customer id and a keyed MAC over it.
import type { TokenService } from '../../../../infra/crypto';

/** How many hex characters of the MAC the token keeps: 128 bits. */
const MAC_HEX_LENGTH = 32;
const MESSAGE_PREFIX = 'marketing-unsubscribe:customer:';

/** The id in base 36, when it is a positive safe integer written the way `toString(36)` writes it. */
function idOf(text: string): number | undefined {
  const id = Number.parseInt(text, 36);
  return Number.isSafeInteger(id) && id > 0 && id.toString(36) === text ? id : undefined;
}

const macOf = (tokens: TokenService, customerId: number): string =>
  tokens.lookupHash(`${MESSAGE_PREFIX}${customerId}`).slice(0, MAC_HEX_LENGTH);

/**
 * Makes the unsubscribe token of a customer.
 *
 * Why: S10: an unsubscribe link must keep working for as long as the email exists, so the token is stateless and never expires; it is
 * `<id in base 36>.<128 bits of HMAC-SHA256(lookup key, 'marketing-unsubscribe:customer:' + id)>`. The id is not secret, the MAC is, and the
 * token can only switch marketing off, never on.
 *
 * @param tokens the token service (the lookup key `LOOKUP_HASH_KEY`, decision 054: a link in a sent mail keeps working when the pepper changes)
 * @param customerId the customer
 * @returns the token (letters, digits and one dot)
 */
export function marketingUnsubscribeToken(tokens: TokenService, customerId: number): string {
  return `${customerId.toString(36)}.${macOf(tokens, customerId)}`;
}

/**
 * Reads an unsubscribe token.
 *
 * @param tokens the token service
 * @param token the text of the link
 * @returns the customer id, or `undefined` when the token is malformed, tampered with or made for another id
 */
export function parseMarketingUnsubscribeToken(tokens: TokenService, token: string): number | undefined {
  const match = /^([0-9a-z]{1,13})\.([0-9a-f]{32})$/.exec(token);
  if (!match) return undefined;
  const customerId = idOf(match[1]!);
  if (customerId === undefined) return undefined;
  return tokens.equals(match[2]!, macOf(tokens, customerId)) ? customerId : undefined;
}
