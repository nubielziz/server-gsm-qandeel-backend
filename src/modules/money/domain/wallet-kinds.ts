// Which wallet an account has: the kind of the wallet follows the kind of the rank (decision 064). Pure.
import type { RankKind } from '../../identity';

/** The ledger account kind of an account's spendable wallet. */
export type WalletLedgerKind = 'client_wallet' | 'customer_wallet';

/**
 * Names the ledger account kind of the wallet a rank kind uses.
 *
 * Why: a merchant rank uses `client_wallet` (with its `client_hold`, credit when the rank allows it, hold and settle); any other rank uses
 * `customer_wallet` (pay first, never below zero). An unknown kind gets the retail wallet: the mapping fails closed, like the rank kind it follows.
 *
 * @param rankKind the kind of the account's rank
 * @returns `client_wallet` for `merchant`, `customer_wallet` otherwise
 */
export function walletKindOfRank(rankKind: RankKind): WalletLedgerKind {
  return rankKind === 'merchant' ? 'client_wallet' : 'customer_wallet';
}
