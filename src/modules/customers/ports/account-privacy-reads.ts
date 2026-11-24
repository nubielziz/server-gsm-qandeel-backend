// The seam to the privacy facts of an account (decision 064): marketing choice, consent evidence and risk signals. Declared here; the customers
// module implements it (identity cannot import customers, so the staff detail reads them through this class).
import type { DbExecutor } from '../../../infra/db';

/** One consent a buyer gave on an order. */
export interface AccountConsentRecord {
  readonly purpose: string;
  /** The document and its version, as staff read it. */
  readonly document: string;
  /** When it was given (ISO 8601). */
  readonly at: string;
  readonly ip: string;
}

/** The privacy facts of one account. */
export interface AccountPrivacy {
  readonly marketingOptIn: boolean;
  /** The consent evidence of the account's latest shop order; null for an account with none. */
  readonly latestConsents: { readonly orderId: number; readonly records: readonly AccountConsentRecord[] } | null;
  readonly risk: {
    readonly highestScore: number | null;
    readonly signals: readonly { readonly text: string; readonly orderId: number }[];
  };
}

/**
 * Reads the privacy facts of an account for staff.
 *
 * Why: the staff detail shows consent evidence and risk signals next to the account (decision 064), but those rows belong to the checkout
 * and risk data of the customers module; modules read each other only through public classes.
 *
 * Side effects (of the implementation): none; reads consent, checkout and risk rows.
 *
 * @see GET /admin/clients/:id/privacy
 */
export abstract class AccountPrivacyReads {
  /**
   * Reads the privacy facts of one account.
   *
   * @param db the database or a transaction
   * @param accountId the account
   * @returns the marketing choice, the latest consents and the risk summary
   * @throws {AppError} `NOT_FOUND` (404) when no such account exists
   */
  abstract privacyOf(db: DbExecutor, accountId: number): Promise<AccountPrivacy>;
}
