// The per-recipient budget of the mails a visitor can ask for (the sign-in link, forgot password; decision 052).
import type { RateLimitService } from '../../../infra/rate-limit';
import { accountAddressMailKey, accountMailKey } from '../domain/account-mail';
import { NO_ACCOUNT_ID } from '../domain/public-links';

/**
 * Spends one point of the `account-mail` budget of a recipient for a mail a visitor asked for, and says whether the mail may go.
 *
 * Why: decision 052. Anybody can ask for a sign-in link or a reset link for any email, so the mails are capped per recipient (five an
 * hour per account and kind, apart from the mails staff send). The same call is made for every request: an email without an account, or
 * one that gets no mail, spends a point on the key of "no account", so the work does not tell who has an account. The caller answers
 * as usual either way. One account type has one budget (decision 064): the key does not depend on the rank.
 *
 * Side effects: counts one point on the cache Redis (`gsm:{env}:ratelimit:account-mail:{hash}`).
 *
 * @param limits the rate limiter
 * @param subject whose budget: always `account` (the parameter keeps the call shape of the two budgets it replaces)
 * @param accountId the account id, or `undefined` when the email gets no mail (unknown, suspended, a guest of a merchant email)
 * @param kind the kind of mail the visitor asked for
 * @returns true when the account exists and its budget still had a point
 */
export async function takePublicMailPoint(
  limits: RateLimitService,
  subject: 'account',
  accountId: number | undefined,
  kind: 'forgot_password' | 'sign_in_link',
): Promise<boolean> {
  const result = await limits.consume('account-mail', accountMailKey(subject, accountId ?? NO_ACCOUNT_ID, kind));
  return accountId !== undefined && result.allowed;
}

/**
 * Spends one point of the `account-mail` budget of an address that has no login account, for the note or the sign-up link a visitor
 * asked for, and says whether the mail may go.
 *
 * Why: decision 079 (its review): the note to an address without an account is addressed to the typed email and no row is made for it,
 * so its budget is keyed by the address: five mails an hour per address, whoever asks. Its re-review: the sign-up links of such an
 * address (sent to its guest row) spend from the same budget, so the notes and the links of one address are five an hour together. One
 * call for every such request, so the work does not tell a blocked address from another one.
 *
 * Side effects: counts one point on the cache Redis (`gsm:{env}:ratelimit:account-mail:{hash}`).
 *
 * @param limits the rate limiter
 * @param email the normalised address
 * @returns true when the address's budget still had a point
 */
export async function takeAddressMailPoint(limits: RateLimitService, email: string): Promise<boolean> {
  const result = await limits.consume('account-mail', accountAddressMailKey(email, 'sign_in_link'));
  return result.allowed;
}
