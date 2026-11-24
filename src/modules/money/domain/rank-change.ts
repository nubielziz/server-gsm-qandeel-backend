// The pure rules of the rank change (decision 064): which wallets a change between two kinds touches, the blockers money finds
// itself, the order and words of every blocker, the ledger lines and key of the balance move, and the one refusal inside a kind. No I/O, so the
// rules are unit-tested; the use case (`application/account-rank-change.service.ts`) reads the facts and calls them.
import type { FieldError } from '../../../common/errors';
import { Money } from '../../../common/money';
import type { RankKind } from '../../identity';
import type { LedgerAccountKind } from '../db/schema';
import type { RankBlockerCode } from '../ports/rank-change-guards';
import { type LedgerLine, creditLine, debitLine } from './ledger-lines';
import { type WalletLedgerKind, walletKindOfRank } from './wallet-kinds';

/**
 * Every blocker code, in the order the answer lists them.
 *
 * Why: the console words each code and lists them together; a fixed order makes the answer, the tests and the console's list agree whatever
 * order the checks of the modules ran in. `credit_limit` is the one refusal inside a kind (it is never found together with the others).
 */
export const RANK_BLOCKER_ORDER = [
  'guest',
  'open_hold',
  'live_order',
  'open_topup',
  'open_dispute',
  'open_refund',
  'open_checkout',
  'frozen',
  'negative_balance',
  'credit_limit',
] as const satisfies readonly RankBlockerCode[];

/**
 * The sentence of each blocker, in plain English.
 *
 * Why: the console shows the `errors[].message` of a refused rank change as it is (and words the codes itself); the sentence says what
 * staff must finish, not which table said so.
 */
export const RANK_BLOCKER_MESSAGES: Readonly<Record<RankBlockerCode, string>> = {
  guest: 'This is a guest. Make an account first: a guest keeps the retail rank.',
  open_hold: 'Orders still hold part of the wallet. Wait for them to finish.',
  live_order: 'An order of this account is still being processed or is waiting for its verification.',
  open_topup: 'A top-up is still open.',
  open_dispute: 'A dispute on a top-up is still open.',
  open_refund: 'A refund to the store balance is still being made.',
  open_checkout: 'A checkout started by this account is still open.',
  frozen: 'A wallet of this account is on hold. Lift the hold first.',
  negative_balance: 'The wallet is below zero. Bring it to zero first.',
  credit_limit: 'The new rank allows no credit and the credit limit is above zero. Set the limit to zero first.',
};

/**
 * Puts blocker codes in the canonical order and keeps each once.
 *
 * @param codes the codes found by money and by the registered checks, in any order and with repeats
 * @returns the distinct codes in {@link RANK_BLOCKER_ORDER}
 */
export function orderBlockers(codes: readonly RankBlockerCode[]): RankBlockerCode[] {
  const found = new Set(codes);
  return RANK_BLOCKER_ORDER.filter((code) => found.has(code));
}

/**
 * The `errors[]` entries of a refused rank change: one per blocker, on the field `groupId`.
 *
 * @param codes the blockers (any order)
 * @returns the field errors in canonical order, each with its code and sentence
 */
export function blockerErrors(codes: readonly RankBlockerCode[]): FieldError[] {
  return orderBlockers(codes).map((code) => ({ field: 'groupId', code, message: RANK_BLOCKER_MESSAGES[code] }));
}

/**
 * Tells whether a change moves an account between the two kinds of wallet.
 *
 * Why: only a change across kinds moves money, ends sessions and opens wallets; inside one kind the rank is just a different row.
 *
 * @param from the kind of the rank before
 * @param to the kind of the rank after
 * @returns true when the kinds differ
 */
export function crossesKinds(from: RankKind, to: RankKind): boolean {
  return from !== to;
}

/** What a change across kinds does to the wallets of the account. */
export interface RankMovePlan {
  /** The wallet the balance leaves (the live wallet of the old kind). */
  readonly source: WalletLedgerKind;
  /** The wallet the balance enters (the live wallet of the new kind). */
  readonly target: WalletLedgerKind;
  /** The ledger accounts the new kind needs and that may be missing: they are opened before anything is locked. */
  readonly open: readonly LedgerAccountKind[];
  /** Whether the credit limit of the merchant wallet is set to zero (leaving the merchant kind). */
  readonly clearsCreditLimit: boolean;
}

/**
 * Plans the wallets of a change across kinds.
 *
 * Why: decision 064: retail to merchant opens the merchant wallet and its hold; merchant to retail opens the store balance and
 * drops the credit limit, because a store balance never has credit. The source and target follow the rank kinds (`walletKindOfRank`).
 *
 * @param from the kind of the rank before
 * @param to the kind of the rank after (a different kind)
 * @returns the source and target wallets, what to open and whether the limit is cleared
 * @throws {RangeError} when both kinds are the same (nothing crosses)
 */
export function planRankMove(from: RankKind, to: RankKind): RankMovePlan {
  if (!crossesKinds(from, to)) throw new RangeError('A rank change inside one kind moves no wallet.');
  return {
    source: walletKindOfRank(from),
    target: walletKindOfRank(to),
    open: to === 'merchant' ? ['client_wallet', 'client_hold'] : ['customer_wallet'],
    clearsCreditLimit: from === 'merchant',
  };
}

/** What money reads about an account, under the locks of the rank change, to find its own blockers. */
export interface RankMoneyFacts {
  /** False for a guest row. */
  readonly hasAccount: boolean;
  /** The balance of `client_hold` (zero when it does not exist). */
  readonly holdBalance: Money;
  /** The balance of the source wallet (zero when it does not exist). */
  readonly sourceBalance: Money;
  /** Whether any wallet of the account, of either kind, is on hold. */
  readonly anyWalletFrozen: boolean;
  /** Whether a top-up invoice or a top-up payment is still open (see the repository). */
  readonly openTopUp: boolean;
  /** Whether a dispute of one of the account's top-up payments is still open. */
  readonly openDispute: boolean;
  /** Whether a refund to the store balance is still requested or processing. */
  readonly openBalanceRefund: boolean;
}

/**
 * Finds the blockers that money itself owns.
 *
 * Why: decision 064: the blockers are collected together and answered together, nothing is written when any applies. Money reads its
 * own tables for these; `live_order` and `open_checkout` come from the checks the orders and customers modules register.
 *
 * @param facts what the repository read under the locks
 * @returns the codes that apply, in canonical order
 */
export function moneyBlockers(facts: RankMoneyFacts): RankBlockerCode[] {
  const found: RankBlockerCode[] = [];
  if (!facts.hasAccount) found.push('guest');
  if (!facts.holdBalance.isZero()) found.push('open_hold');
  if (facts.openTopUp) found.push('open_topup');
  if (facts.openDispute) found.push('open_dispute');
  if (facts.openBalanceRefund) found.push('open_refund');
  if (facts.anyWalletFrozen) found.push('frozen');
  if (facts.sourceBalance.isNegative()) found.push('negative_balance');
  return orderBlockers(found);
}

/**
 * The one refusal inside a kind: a merchant rank without credit while the credit limit is above zero.
 *
 * Why: today's rule (user rule 2): a limit above zero needs a rank that allows credit. Between two merchant ranks nothing else blocks a change.
 *
 * @param facts whether the target rank allows credit and the credit limit now
 * @returns `credit_limit` when the change must be refused, else `undefined`
 */
export function sameKindRefusal(facts: {
  readonly targetAllowsCredit: boolean;
  readonly creditLimit: Money;
}): RankBlockerCode | undefined {
  return !facts.targetAllowsCredit && facts.creditLimit.isPositive() ? 'credit_limit' : undefined;
}

/**
 * The ledger key of the balance move of one request.
 *
 * Why: decision 064: the key is `rank:<accountId>:<Idempotency-Key>`. It is unique per request, so retry, replay, and a later change back with
 * another key each post exactly once; the history row's own unique key stops a second posting before the ledger is asked.
 *
 * @param accountId the account
 * @param idempotencyKey the request's `Idempotency-Key`
 * @returns the key
 */
export function rankMoveKey(accountId: number, idempotencyKey: string): string {
  return `rank:${accountId}:${idempotencyKey}`;
}

/**
 * The words of the journal of the move.
 *
 * @param toRankName the name of the new rank
 * @param to the kind of the new rank
 * @returns the memo the statement shows
 */
export function rankMoveMemo(toRankName: string, to: RankKind): string {
  return to === 'merchant'
    ? `Moved from the store balance with the rank change to ${toRankName}`
    : `Moved to the store balance with the rank change to ${toRankName}`;
}

/**
 * The journal lines of the balance move: the whole balance leaves the source wallet and enters the target wallet.
 *
 * Why: both wallets are liabilities of the same account, so the move is Dr source / Cr target (merchant to retail: Dr client_wallet, Cr
 * customer_wallet; retail to merchant the reverse) and nothing else changes: no fee, no income, no cost.
 *
 * @param accountId the account that owns both wallets
 * @param plan the plan of the change (source and target)
 * @param amount the balance to move (above zero)
 * @returns the two lines
 * @throws {RangeError} when the amount is not above zero
 */
export function rankMoveLines(accountId: number, plan: RankMovePlan, amount: Money): LedgerLine[] {
  if (!amount.isPositive()) throw new RangeError('The balance to move must be above zero.');
  return [
    ...debitLine({ kind: plan.source, ownerType: 'account', ownerId: accountId }, amount),
    ...creditLine({ kind: plan.target, ownerType: 'account', ownerId: accountId }, amount),
  ];
}

/**
 * Tells whether a stored change is the same request as the one that arrived.
 *
 * Why: decision 064: a key already stored for the account replays its change when the body names the same rank; another rank under
 * the same key is a different request and is refused (`IDEMPOTENCY_KEY_REUSED`).
 *
 * @param stored the stored change
 * @param requestedGroupId the `groupId` of the new request
 * @returns true when the request repeats the stored change
 */
export function isSameRequest(stored: { readonly toGroupId: number }, requestedGroupId: number): boolean {
  return stored.toGroupId === requestedGroupId;
}
