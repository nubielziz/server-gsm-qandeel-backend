// The buyer rules of the order engine (decision 064): pure answers about who may place a hold-and-settle order, whether a money move reads
// the buyer's live wallet, and when a reopen is refused. No database: the use cases read the buyer under its account row lock and ask here.
import type { OrderSource } from '../db/schema';
import { isPrepaidOrder } from './door';
import type { OrderMoneyMove } from './order-machine';

/** The rank kind of an account as the session and the wire say it. */
export type BuyerRankKind = 'retail' | 'merchant';

/** The kind of wallet an account lives on now: a merchant rank holds a merchant wallet, any other rank a store balance. */
export type LiveWalletKind = 'merchant' | 'store';

/** The refusals of a placement from the merchant wallet (the portal and Dhru). */
export type PlacementRefusal = 'RANK_NOT_ALLOWED' | 'ACCOUNT_SUSPENDED';

/** The sentences staff and merchants read next to the title of a placement refusal (`detail`). */
export const PLACEMENT_REFUSAL_DETAILS: Readonly<Record<PlacementRefusal, string>> = {
  RANK_NOT_ALLOWED: 'This account cannot place orders from a wallet. Order from the shop instead.',
  ACCOUNT_SUSPENDED: 'This account is suspended and cannot place orders.',
};

/** The sentence of the refusal of a reopen after the account changed rank (`409 RANK_CHANGED`). */
export const REOPEN_REFUSED_DETAIL = 'Refund the order instead.';

/**
 * The sentence of the refusal of a refund or a reopen of a completed hold-and-settle order whose account was erased (`409 ANONYMIZED`):
 * nobody can sign in to that account any more, so money credited to its wallet would be stranded there (decision 064).
 */
export const ERASED_BUYER_DETAIL =
  'This account was erased, so no money can move on its wallet. Pay a refund back another way.';

/**
 * Decides whether an account may place a hold-and-settle order.
 *
 * Why: decision 064: the placement is the second line behind the rank gate. A retail rank has no merchant wallet to hold from (403
 * `RANK_NOT_ALLOWED`) and an account that may not act (suspended, blocked, anonymized) places nothing (403 `ACCOUNT_SUSPENDED`); the rank
 * is judged first. The caller reads both facts under the account row lock (`FOR KEY SHARE`, decision 064), so a rank
 * change that races the placement is either seen or waited for.
 *
 * @param buyer the account's rank kind now and whether its status lets it act (`canAct` of the identity module)
 * @returns the refusal code, or `undefined` when the account may place
 */
export function placementRefusal(buyer: {
  readonly rankKind: BuyerRankKind;
  readonly mayAct: boolean;
}): PlacementRefusal | undefined {
  if (buyer.rankKind !== 'merchant') return 'RANK_NOT_ALLOWED';
  if (!buyer.mayAct) return 'ACCOUNT_SUSPENDED';
  return undefined;
}

/**
 * Tells whether a money move reads the account's live wallet kind.
 *
 * Why: decision 064: the money path of an existing order follows its door, never the rank today, except that a refund and a reopen of a
 * completed hold-and-settle order meet the account as it is now. A refund credits the live wallet; a reopen puts the revenue back on the
 * merchant hold, which a retail account no longer has. The paid-first orders never read it: their money moves through customer funds, and
 * the refund of a balance payment is the money module's.
 *
 * @param order the order (its door)
 * @param move the money move the machine decided, or `null`
 * @returns true when the use case must lock the account and read the wallet kind before it posts
 */
export function readsLiveWallet(order: { readonly source: OrderSource }, move: OrderMoneyMove | null): boolean {
  return !isPrepaidOrder(order) && (move === 'refund' || move === 'reopen');
}

/**
 * Decides whether a reopen is refused because the account changed rank.
 *
 * Why: a reopen of a completed hold-and-settle order is a new debit on `client_hold`, not a refund: when the account's live wallet is no
 * longer the merchant wallet it is refused (409 `RANK_CHANGED`, "Refund the order instead."). Reject and cancel of an open
 * order cannot meet a crossing (the `live_order` blocker of the rank change), and a refund is never refused (it credits the live wallet).
 *
 * @param order the order (its door)
 * @param move the money move the machine decided
 * @param wallet the account's live wallet kind, read under the account row lock
 * @returns `RANK_CHANGED` for a reopen of a hold-and-settle order whose account lives on a store balance now, otherwise `undefined`
 */
export function reopenRefusal(
  order: { readonly source: OrderSource },
  move: OrderMoneyMove | null,
  wallet: LiveWalletKind,
): 'RANK_CHANGED' | undefined {
  return move === 'reopen' && !isPrepaidOrder(order) && wallet !== 'merchant' ? 'RANK_CHANGED' : undefined;
}

/**
 * Names the ledger account kind a refund of a completed hold-and-settle order credits.
 *
 * Why: decision 064: a refund always credits the account's live wallet, the merchant wallet while the rank is a merchant rank and the store
 * balance after a crossing; the account keeps one live wallet and nothing lands on the other.
 *
 * @param wallet the account's live wallet kind
 * @returns `client_wallet` or `customer_wallet`
 */
export function refundCreditsKind(wallet: LiveWalletKind): 'client_wallet' | 'customer_wallet' {
  return wallet === 'merchant' ? 'client_wallet' : 'customer_wallet';
}
