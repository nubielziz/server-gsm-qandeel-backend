// The per-recipient budget of the mails a visitor can ask for (the sign-in link, forgot password; decision 052).
import type { RateLimitService } from '../../../infra/rate-limit';
import { type AccountMailSubject, accountMailKey } from '../domain/account-mail';
import { NO_ACCOUNT_ID } from '../domain/public-links';

/**
 * Spends one point of the `account-mail` budget of a recipient for a mail a visitor asked for, and says whether the mail may go.
 *
 * Why: decision 052. Anybody can ask for a sign-in link or a reset link for any email, so the mails are capped per recipient (five an
 * hour per account and kind, apart from the mails staff send). The same call is made for every request: an email without an account, or
 * one that gets no mail, spends a point on the key of "no account", so the work does not tell who has an account. The caller answers
 * as usual either way.
 *
 * Side effects: counts one point on the cache Redis (`gsm:{env}:ratelimit:account-mail:{hash}`).
 *
 * @param limits the rate limiter
 * @param subject whose account: a merchant (`client`) or a `customer`
 * @param accountId the account id, or `undefined` when the email gets no mail (unknown, suspended, a guest)
 * @param kind the kind of mail the visitor asked for
 * @returns true when the account exists and its budget still had a point
 */
export async function takePublicMailPoint(
  limits: RateLimitService,
  subject: Extract<AccountMailSubject, 'client' | 'customer'>,
  accountId: number | undefined,
  kind: 'forgot_password' | 'sign_in_link',
): Promise<boolean> {
  const result = await limits.consume('account-mail', accountMailKey(subject, accountId ?? NO_ACCOUNT_ID, kind));
  return accountId !== undefined && result.allowed;
}
