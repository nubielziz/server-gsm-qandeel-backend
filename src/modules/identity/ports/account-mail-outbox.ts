// The seam to the mails of the account links (decision 064): invitation, verification, password reset and the sign-in link.
import type { TransactionContext } from '../../../infra/db';

/**
 * The mails an account link can carry. `magic_link` is for the retail rank only, and so are the two sign-in links of the shop's sign-up
 * (decision 079): `sign_up_link` ("finish creating your account", the link the details wait beside) and `sign_up_existing` ("you already
 * have an account, nothing was changed", the ordinary sign-in link of an address that already has one).
 */
export type AccountMailKind =
  'email_verification' | 'password_reset' | 'invited' | 'magic_link' | 'sign_up_link' | 'sign_up_existing';

/**
 * Writes the outbox row of an account's link mail.
 *
 * Why: an email is async work (decision 020): the use case writes the event in its own transaction and the worker sends the mail. The
 * implementation picks the merchant or the retail mail family by the rank kind it reads under the account row lock, so the callers
 * never choose a family. The event carries ids only, never the token.
 *
 * Side effects (of the implementation): inserts one `outbox_events` row in the caller's transaction.
 */
export abstract class AccountMailOutbox {
  /**
   * Queues one mail.
   *
   * @param work the caller's transaction
   * @param mail the kind, the account and the `auth_tokens` row of the link (the placeholder the mail job rotates)
   */
  abstract enqueue(
    work: Pick<TransactionContext, 'tx'>,
    mail: { readonly kind: AccountMailKind; readonly accountId: number; readonly tokenId?: number },
  ): Promise<void>;
}
