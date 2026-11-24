// The seam to an account's own facts for the modules that serve the retail rank (decision 064): the one builder of `AccountMe` and the
// shop's own profile write. Declared here (a leaf: type-only imports); the identity module's account service implements it.
import type { Transaction } from '../../../infra/db';
import type { RankKind } from './rank-kind';
import type { ClientStatus } from '../db/schema';

/** The columns of the shop's own profile edit (`PATCH /store/v1/me`); a missing key stays as it is. */
export interface RetailProfileColumns {
  readonly name?: string | undefined;
  readonly phone?: string | undefined;
  readonly country?: string | undefined;
  /** The ISO code of the shown currency, or `null` for none. */
  readonly currency?: string | null | undefined;
  readonly marketingOptIn?: boolean | undefined;
}

/**
 * The account of the signed-in caller, as `AccountMe` shows it, ready for the wire: dates are ISO text.
 *
 * Why: `GET /client/auth/me` and `GET /store/v1/me` answer the same keys for every rank (decision 064); one builder makes the value, so
 * the two routes cannot drift. `username` and `company` are empty text when the account has none.
 */
export interface AccountMeView {
  readonly id: number;
  readonly name: string;
  readonly email: string;
  readonly status: ClientStatus;
  readonly rank: {
    readonly id: number;
    readonly name: string;
    readonly kind: RankKind;
    readonly discountPercent: string;
  };
  readonly hasPassword: boolean;
  readonly mustChangePassword: boolean;
  readonly twofaEnabled: boolean;
  readonly currency: string | null;
  readonly marketingOptIn: boolean;
  readonly company: string;
  readonly username: string;
  readonly phone: string;
  readonly country: string;
  readonly address: string;
  readonly taxId: string;
  readonly emailVerifiedAt: string | null;
  readonly createdAt: string;
}

/**
 * The seam to the account's own facts, for the modules that serve an account of the retail rank (decision 064).
 *
 * Why: the `clients` table belongs to the identity module; the customers module answers `GET /store/v1/me` and `PATCH /store/v1/me` and
 * judges the shop's rules (the tax-rate country rule, the shown currencies, the consent record), so it reads the account and writes the
 * profile columns only through this class. The module that provides it is the identity module.
 *
 * Side effects (of the implementation): `lockMeOf` takes the row lock; `saveRetailProfile` updates `clients`.
 *
 * @see GET /store/v1/me, PATCH /store/v1/me
 */
export abstract class AccountOwnProfile {
  /**
   * Describes an account for the wire, read now (never from a cached session view).
   *
   * @param accountId the signed-in account
   * @returns the account as `AccountMe` shows it
   * @throws {AppError} `UNAUTHORIZED` (401) when the account is gone, `ACCOUNT_SUSPENDED` (403) when it is suspended or blocked
   */
  abstract meOf(accountId: number): Promise<AccountMeView>;

  /**
   * Reads an account and locks its row until the transaction ends.
   *
   * @param tx the caller's transaction
   * @param accountId the signed-in account
   * @returns the account as it is now
   * @throws {AppError} `UNAUTHORIZED` (401), `ACCOUNT_SUSPENDED` (403)
   */
  abstract lockMeOf(tx: Transaction, accountId: number): Promise<AccountMeView>;

  /**
   * Writes the columns of the shop's own profile edit.
   *
   * @param tx the caller's transaction, which holds the row lock of `lockMeOf`
   * @param accountId the signed-in account
   * @param columns the columns to change
   * @param now the time of the change
   * @returns the account after the write
   * @throws {AppError} `UNAUTHORIZED` (401) when the account is gone
   */
  abstract saveRetailProfile(
    tx: Transaction,
    accountId: number,
    columns: RetailProfileColumns,
    now: Date,
  ): Promise<AccountMeView>;
}
