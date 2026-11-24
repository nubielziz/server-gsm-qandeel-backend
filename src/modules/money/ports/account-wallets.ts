// The seam to the wallets of accounts (decision 064): which wallet an account has now, the figures of every account's wallet in one query,
// and the rule that a frozen merchant wallet takes no new hold. Declared here; the money module implements it.
import type { DbExecutor, Transaction } from '../../../infra/db';

/** The kind of the live wallet of an account: `merchant` (wallet and hold, credit when the rank allows it) or `store` (pay first, never below zero). */
export type AccountWalletKind = 'merchant' | 'store';

/**
 * The wallet of an account as the staff list and the wallet routes show it. Money amounts are wire strings (four decimals).
 *
 * Why: one shape for both kinds (decision 064), so the list, the detail and every wallet write answer the same keys.
 */
export interface AccountWalletView {
  readonly kind: AccountWalletKind;
  readonly currency: string;
  /** The wallet balance in the account's own sign: negative while credit is in use. */
  readonly balance: string;
  /** What open orders hold (merchant kind; zero for a store wallet). */
  readonly reserved: string;
  readonly creditLimit: string;
  /** What the account can spend now: balance plus credit limit. */
  readonly available: string;
  /** Whether the rank allows credit. */
  readonly creditAllowed: boolean;
  /** Set while staff keep the wallet on hold: when and why. */
  readonly frozen: { readonly at: string; readonly reason: string } | null;
  /** Whether the wallet may be used at all (the store wallet's switch). */
  readonly enabled: boolean;
  /** Top-ups created and not yet credited. */
  readonly pendingTopUps: { readonly count: number; readonly amount: string };
  /** Disputes of the wallet's card top-ups that are still open. */
  readonly openDisputes: number;
  /** The amount above which a staff adjustment needs the Owner, for this wallet kind. */
  readonly adjustApprovalLimit: string;
}

/**
 * Reads the live wallet of accounts and guards the merchant wallet's freeze.
 *
 * Why: the wallet kind follows the rank kind (decision 064), and a rank change can leave the other kind's wallet at zero behind, so
 * callers never guess a kind: they ask here, under the account row lock they already hold. The list of accounts needs every figure in
 * one query, not one read per row.
 *
 * Side effects (of the implementation): none beyond reads; `assertNotFrozen` reads the account's wallet row.
 *
 * @see GET /admin/clients, GET /client/wallet, GET /store/v1/me/wallet
 */
export abstract class AccountWallets {
  /**
   * Names the kind of the account's live wallet.
   *
   * @param tx the caller's transaction, after it locked the account row (a path reads the rank kind only under that lock)
   * @param accountId the account
   * @returns `merchant` for a merchant rank, `store` for any other
   */
  abstract kindOf(tx: Transaction, accountId: number): Promise<AccountWalletKind>;

  /**
   * Reads the live wallet of many accounts in one query.
   *
   * @param db the database or a transaction
   * @param accountIds the accounts
   * @returns the live wallet of every account that exists (an account that never had a wallet reads as zeros with the kind of its rank);
   *   an id that names no account is missing from the map
   */
  abstract viewsOf(db: DbExecutor, accountIds: readonly number[]): Promise<Map<number, AccountWalletView>>;

  /**
   * Refuses a new hold on a frozen merchant wallet.
   *
   * Why: a frozen `client_wallet` takes no new hold; the order placement calls this after the account row lock and before it posts the hold.
   *
   * @param tx the caller's transaction, after the account row lock
   * @param accountId the account
   * @throws {AppError} `WALLET_FROZEN` (409) when the account's merchant wallet is frozen
   */
  abstract assertNotFrozen(tx: Transaction, accountId: number): Promise<void>;
}
