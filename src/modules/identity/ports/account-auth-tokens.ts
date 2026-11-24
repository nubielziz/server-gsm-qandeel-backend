// The seam to the one-time links of accounts (decision 064): invitations, password resets, email verification and the sign-in link are one
// kind of token with one subject type. Declared here; the identity module implements it.
import type { Transaction, TransactionContext } from '../../../infra/db';

/** The purposes a one-time link of an account can have. */
export const ACCOUNT_TOKEN_PURPOSES = ['invite', 'reset', 'verify_email', 'magic_link'] as const;

/** One value of {@link ACCOUNT_TOKEN_PURPOSES}. */
export type AccountTokenPurpose = (typeof ACCOUNT_TOKEN_PURPOSES)[number];

/** What `AccountAuthTokens.issue` takes. */
export interface IssueAccountTokenInput {
  /** The account the link is for (a guest row included for a sign-in link). */
  readonly accountId: number;
  readonly purpose: AccountTokenPurpose;
  /** The staff member who created an invitation; absent for a link nobody sent (forgot password, verification). */
  readonly createdBy?: number | null;
  /** The address of the request that created the link, for the record. */
  readonly ip?: string | null;
  /**
   * Keep the two newest unused links of the family instead of voiding every older one, so at most three work at once. Only for a
   * link the visitor asked for (forgot password): a stranger who asks again must not void the link the owner was sent.
   */
  readonly keepEarlier?: boolean;
  /**
   * The value of the cookie that marks the browser which asked for a sign-in link; only its keyed hash is stored on the link's row, so the
   * exchange can tell that browser from another one. Only for `magic_link`; omitted for every other link.
   */
  readonly browserKey?: string;
}

/** What `AccountAuthTokens.take` finds. */
export interface TakenAccountToken {
  /** The `auth_tokens` row id. */
  readonly tokenId: number;
  /** The account the link belongs to. */
  readonly accountId: number;
  readonly purpose: AccountTokenPurpose;
  /** The keyed hash of the asking browser's cookie stored with a sign-in link, or `null` (see `askedFrom`). */
  readonly browserHash: string | null;
  readonly expiresAt: Date;
}

/**
 * Issues, takes and voids the one-time links of accounts.
 *
 * Why: a link is a credential (one hour, one use, only its keyed hash stored), and every sign-in, reset, verification and invitation
 * flow of every rank uses the same rules; the other use cases call this class and never read `auth_tokens` themselves.
 *
 * Side effects (of the implementation): `issue` inserts an `auth_tokens` row and voids the older unused links of its family; `take`
 * locks the row and the caller marks it used in the same transaction; `voidOpenOf` marks open links used.
 */
export abstract class AccountAuthTokens {
  /**
   * Issues a link and voids the account's older unused ones of the same family.
   *
   * @param work the caller's transaction, so the token and the change that needs it commit together
   * @param input the account, the purpose and who sent it
   * @returns the row id (the only thing an outbox event carries) and the token for the link, which exists in clear text only here
   */
  abstract issue(
    work: Pick<TransactionContext, 'tx'>,
    input: IssueAccountTokenInput,
  ): Promise<{ readonly tokenId: number; readonly token: string }>;

  /**
   * Finds the link of a token and locks it.
   *
   * @param tx the caller's transaction
   * @param token the token as the visitor typed or followed it
   * @param purposes the purposes this flow accepts
   * @returns the link when it is unused, unexpired and of an accepted purpose; `undefined` otherwise (the caller answers one `TOKEN_INVALID`)
   */
  abstract take(
    tx: Transaction,
    token: string,
    purposes: readonly AccountTokenPurpose[],
  ): Promise<TakenAccountToken | undefined>;

  /**
   * Voids the open links of an account.
   *
   * Why: a status change, an email change, a password change and every write that gives an email a login row void the links that must
   * no longer work (for example the sign-in link mailed to the guest row of that email).
   *
   * @param tx the caller's transaction
   * @param accountId the account (or the guest row)
   * @param purposes the purposes to void; every purpose when omitted
   * @returns how many links were voided
   */
  abstract voidOpenOf(tx: Transaction, accountId: number, purposes?: readonly AccountTokenPurpose[]): Promise<number>;

  /**
   * Tells whether a link was asked for by the browser that presents this cookie value.
   *
   * Why: a sign-in link opened in the browser that asked for it signs in at once; opened anywhere else it must not replace another
   * account's session, and the shop says whose account it opened.
   *
   * @param taken the taken or stored link
   * @param browserKey the value of the asking-browser cookie the request carried, if any
   * @returns true only when the link stored a browser hash and the cookie's keyed hash equals it
   */
  abstract askedFrom(taken: { readonly browserHash: string | null }, browserKey: string | undefined): boolean;
}
