// The key of the `account-mail` limiter (feature 20, decision 052): five account emails an hour per account and kind of mail.
import { RateLimitService } from '../../../infra/rate-limit';

/** Whose account a mail goes to: the first part of the key (merchant and staff ids overlap, and customers have ids of their own). */
export type AccountMailSubject = 'client' | 'staff' | 'customer';

/**
 * The kinds of account mail the limiter counts separately.
 *
 * Why: the mails a visitor can ask for (`forgot_password`, `sign_in_link`) have kinds apart from the ones staff send
 * (`password_link`), so a stranger who spends them cannot block a link a staff member sends (decision 052).
 */
export type AccountMailKind = 'password_link' | 'verification' | 'email_change' | 'forgot_password' | 'sign_in_link';

/**
 * The limiter key of one kind of mail to one account.
 *
 * Why: a staff member or a merchant must not mail-bomb an inbox or use up the mail quota (decision 021, feature 20, O-11). The
 * subject type is part of the key because merchant and staff ids overlap; the kind is part of it so a verification resend does
 * not use up the password-link budget. The merchant's own resend and the staff action share the key `verification`.
 *
 * @param subject whose account: `client` (merchant), `staff` or `customer`
 * @param id the account id
 * @param kind the kind of mail
 * @returns a 32-character hex key for `RateLimitService.enforce('account-mail', key)`
 */
export function accountMailKey(subject: AccountMailSubject, id: number, kind: AccountMailKind): string {
  return RateLimitService.compositeKey(subject, String(id), kind);
}
