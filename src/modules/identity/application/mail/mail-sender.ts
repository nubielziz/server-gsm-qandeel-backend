// MailSender: the seam between the merchant mail jobs and a real mail transport (feature 12a replaces the development sender
// with templates and delivery). Event types: merchant.email_verification, merchant.password_reset, merchant.invited.

/** The three mails of the merchant portal. */
export type MerchantMailKind = 'email_verification' | 'password_reset' | 'invited';

/**
 * What a merchant mail job hands to the sender.
 *
 * Why: the outbox carries ids only, so the job re-reads the merchant and the link row and passes what a template needs to
 * choose the words: who, what kind, and when the link stops working. The link itself is not here: the token exists in clear
 * text only in the request that created it (decision 019), which is why feature 12a must settle how the token reaches the
 * mailer (see the identity README, "Merchant mail").
 */
export interface MerchantMail {
  readonly kind: MerchantMailKind;
  readonly clientId: number;
  readonly email: string;
  readonly name: string;
  /** The `auth_tokens` row of the link. */
  readonly tokenId: number;
  /** When the link stops working. */
  readonly expiresAt: Date;
}

/**
 * Delivers a mail.
 *
 * Why: the job must not know whether mail goes out by SMTP, an API or a log line. Throw to have the queue retry the job
 * (5 attempts, backoff); resolve when the mail was accepted.
 */
export interface MailSender {
  /**
   * Hands one mail to the transport.
   *
   * @param mail what to send
   * @throws {Error} when the transport did not accept it (the queue retries)
   */
  send(mail: MerchantMail): Promise<void>;
}

/** The Nest token of the {@link MailSender} implementation. Feature 12a provides the real one under this token. */
export const MAIL_SENDER = Symbol('MAIL_SENDER');
