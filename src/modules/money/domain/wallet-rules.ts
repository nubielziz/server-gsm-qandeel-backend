// Wallet rules that need no database: the credit limit (user rule 2), the manual adjustment limits (ANSWERS merchants Q4, decision 049),
// and the pure parts of the staff wallet actions of one account (decision 064): the keys, the pools by wallet kind, the replay checks,
// the refusals and the statement window.
import type { ParsedFilter } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { Money } from '../../../common/money';
import type { RankKind } from '../../identity';
import type { AccountWalletKind, AccountWalletView } from '../ports/account-wallets';
import { BASE_CURRENCY } from './accounts';
import type { WalletLedgerKind } from './wallet-kinds';

/**
 * Checks a credit limit against the merchant group's overdraft permission and returns it.
 *
 * Why: user rule 2 (resolution identity-platform-3): a limit above zero on a group without `overdraft_allowed` is `422` on
 * `creditLimit`, and a negative limit is `422` too. One function serves `MerchantAccounts.open` and
 * `PATCH /admin/clients/:id/credit-limit`, so both answer alike. Lowering a limit below the credit in use is allowed (new
 * orders are refused until a top-up).
 *
 * @param creditLimit the limit as wire `Money`
 * @param overdraftAllowed `client_groups.overdraft_allowed` of the merchant's group
 * @returns the limit as `Money`
 * @throws {AppError} `VALIDATION_FAILED` on `creditLimit` when it is negative, or above zero and the group allows no credit
 */
export function checkCreditLimit(creditLimit: string, overdraftAllowed: boolean): Money {
  const limit = Money.fromWire(creditLimit);
  if (limit.isNegative()) {
    throw new AppError('VALIDATION_FAILED', {
      errors: [{ field: 'creditLimit', code: 'min', message: 'The credit limit cannot be negative.' }],
    });
  }
  if (limit.isPositive() && !overdraftAllowed) {
    throw new AppError('VALIDATION_FAILED', {
      errors: [{ field: 'creditLimit', code: 'not_allowed', message: 'This group does not allow credit.' }],
    });
  }
  return limit;
}

/**
 * The setting that holds the single-approver limit of manual adjustments.
 *
 * Why: ANSWERS merchants Q4: the demo's $10,000 is a setting, `wallet.adjust_approval_limit`.
 */
export const ADJUST_APPROVAL_LIMIT_KEY = 'wallet.adjust_approval_limit';

/** The default of {@link ADJUST_APPROVAL_LIMIT_KEY}: the demo's $10,000. */
export const DEFAULT_ADJUST_APPROVAL_LIMIT = '10000.0000';

/**
 * Reads the approval limit setting.
 *
 * Why: the setting is free JSON (a number or an amount text); a bad value must not lock every adjustment or lift the limit,
 * so anything that is not a non-negative amount with at most four places falls back to the default.
 *
 * @param value the raw setting value (`undefined` when never set)
 * @returns the limit
 */
export function approvalLimitOf(value: unknown): Money {
  const fallback = Money.fromWire(DEFAULT_ADJUST_APPROVAL_LIMIT);
  try {
    // A JSON number is read through its shortest decimal text, so 250.5 means exactly 250.5000; exponents and more than
    // four places are refused by Money.of.
    const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
    if (typeof text === 'string') {
      const limit = Money.of(text);
      return limit.isNegative() ? fallback : limit;
    }
  } catch {
    // A malformed value falls through to the default.
  }
  return fallback;
}

/**
 * Writes a dollar amount for a refusal: `$10,000` for whole dollars, `$10,000.50` for whole cents, and every place that is not zero
 * otherwise (`$10,000.0001`).
 *
 * Why: the adjustment and credit-limit refusals name the limit the way the console shows it (ANSWERS merchants Q4); a total just above
 * the limit must not read as the limit itself.
 *
 * @param amount the amount
 * @returns the text with a dollar sign and thousands separators
 */
export function dollarsText(amount: Money): string {
  const [whole = '0', places = '0000'] = amount.toWire().split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (/^0+$/.test(places)) return `$${grouped}`;
  return `$${grouped}.${places.replace(/0+$/, '').padEnd(2, '0')}`;
}

/** How far back a staff member's credits count towards the approval limit: 24 hours (decision 049). */
export const ADJUST_WINDOW_MS = 24 * 60 * 60 * 1000;

/** What {@link adjustmentNeedsOwner} judges. */
export interface AdjustmentFacts {
  readonly direction: 'credit' | 'debit';
  readonly amount: Money;
  /** What the same staff member credited to wallets of the same kind within the window, this request not included. */
  readonly creditedInWindow: Money;
  /** The approval limit of that kind of wallet. */
  readonly limit: Money;
  /** The caller holds `*`. */
  readonly owner: boolean;
}

/**
 * Tells whether a manual adjustment needs an Owner.
 *
 * Why: decision 049 (amends ANSWERS merchants Q4): the approval limit caps what one staff member credits within 24 hours, so several
 * requests carry no more than one; a debit is judged alone; an Owner is the approver of what goes beyond. Strictly above the limit.
 *
 * @param facts the adjustment and the staff member's recent credits
 * @returns true when the adjustment is refused for anyone but an Owner
 */
export function adjustmentNeedsOwner(facts: AdjustmentFacts): boolean {
  if (facts.owner) return false;
  const counted = facts.direction === 'credit' ? facts.creditedInWindow.add(facts.amount) : facts.amount;
  return counted.cmp(facts.limit) > 0;
}

/**
 * The refusal of an adjustment above the limit (`409 APPROVAL_REQUIRED`).
 *
 * Why: decision 049: the console shows the detail, so it names the limit and, for a credit, the 24-hour total it would reach.
 *
 * @param facts the adjustment and the staff member's recent credits
 * @returns the detail the console shows
 */
export function adjustmentRefusalDetail(facts: Omit<AdjustmentFacts, 'owner'>): string {
  return facts.direction === 'credit'
    ? `Credits over ${dollarsText(facts.limit)} in 24 hours need an owner: yours would come to ${dollarsText(facts.creditedInWindow.add(facts.amount))}.`
    : `Debits over ${dollarsText(facts.limit)} need an owner.`;
}

/**
 * Tells whether a credit limit needs an Owner: it is above the approval limit of merchant adjustments and higher than the limit it replaces.
 *
 * Why: decision 049: a credit limit is money the merchant can spend; above what one staff member may credit by hand, an Owner decides.
 * Lowering a limit, or sending it unchanged, never needs one.
 *
 * @param next the new limit
 * @param current the limit it replaces (zero for a new merchant)
 * @param approvalLimit `wallet.adjust_approval_limit`
 * @returns true when only an Owner may set it
 */
export function creditLimitNeedsOwner(next: Money, current: Money, approvalLimit: Money): boolean {
  return next.cmp(approvalLimit) > 0 && next.cmp(current) > 0;
}

/**
 * The part by which a new credit limit exceeds the limit it replaces: what a raise adds to the staff member's 24-hour sum.
 *
 * Why: decision 049: a credit limit is money the merchant can spend, so the raised part counts with the staff member's credit
 * adjustments; a lowering, or a limit sent unchanged, counts nothing (and gives nothing back).
 *
 * @param next the new limit
 * @param current the limit it replaces (zero for a new merchant)
 * @returns the difference when the limit goes up, zero otherwise
 */
export function creditLimitRaise(next: Money, current: Money): Money {
  return next.cmp(current) > 0 ? next.sub(current) : Money.zero();
}

/**
 * The refusal of a credit-limit raise that takes the staff member's 24-hour sum above the approval limit (`403 FORBIDDEN`).
 *
 * Why: decision 049: the console shows the detail on the credit-limit dialog and on the merchant invitation; it names the limit and the
 * total the sum of credits and raises would reach.
 *
 * @param approvalLimit `wallet.adjust_approval_limit`
 * @param total the staff member's credits and raises within 24 hours, this raise included
 * @returns the detail the console shows
 */
export function creditSumRefusalDetail(approvalLimit: Money, total: Money): string {
  return `Credits and credit-limit raises over ${dollarsText(approvalLimit)} in 24 hours need an owner: yours would come to ${dollarsText(total)}.`;
}

/**
 * The refusal of a receipt approval that takes the staff member's 24-hour total above the limit (`409 APPROVAL_REQUIRED`).
 *
 * Why: decision 049: what one staff member credits by approving transfer receipts within 24 hours is capped like their adjustments; the
 * console shows the detail, so it names the limit and the total it would reach.
 *
 * @param limit `wallet.receipt_approval_limit`
 * @param total what the staff member's approvals of transfer top-ups credited within 24 hours, this one included
 * @returns the detail the console shows
 */
export function receiptApprovalRefusalDetail(limit: Money, total: Money): string {
  return `Approved transfer top-ups over ${dollarsText(limit)} in 24 hours need an owner: yours would come to ${dollarsText(total)}.`;
}

/**
 * The refusal of a credit limit above the approval limit (`403 FORBIDDEN`).
 *
 * Why: decision 049: the console shows the detail on the credit-limit dialog and on the merchant invitation.
 *
 * @param approvalLimit `wallet.adjust_approval_limit`
 * @returns the detail the console shows
 */
export function creditLimitOwnerDetail(approvalLimit: Money): string {
  return `Only an owner can set a credit limit above ${dollarsText(approvalLimit)}.`;
}

/** The two pools a staff member's credits are counted in: merchant wallets and store balances (the approval limit of each is its own). */
export type WalletPool = AccountWalletKind;

/**
 * Names the pool and the wallet a rank kind uses.
 *
 * Why: the approval pools follow the wallet kind of the account now (decision 064), not the type word the old rows carried: a merchant
 * rank gives merchant credits (`client_wallet`), any other rank gives store credits (`customer_wallet`).
 *
 * @param rankKind the kind of the account's rank
 * @returns the wallet kind of the pool and the ledger account kind of its wallet
 */
export function poolOfRank(rankKind: RankKind): { pool: WalletPool; ledgerKind: WalletLedgerKind } {
  return rankKind === 'merchant'
    ? { pool: 'merchant', ledgerKind: 'client_wallet' }
    : { pool: 'store', ledgerKind: 'customer_wallet' };
}

/**
 * The ledger idempotency key of a staff adjustment.
 *
 * Why: one form for both wallet kinds, `adjust:<accountId>:<Idempotency-Key>`. The account id is global, so a retry posts once whichever kind
 * the wallet has.
 *
 * @param accountId the account
 * @param idempotencyKey the caller's `Idempotency-Key`
 * @returns the key
 */
export function adjustmentKeyOf(accountId: number, idempotencyKey: string): string {
  return `adjust:${accountId}:${idempotencyKey}`;
}

/**
 * The keys a store adjustment of the same request carried before the accounts merged.
 *
 * Why: a retry of a pre-release adjustment arrives after the release, and the old key was `adjust:customer:<oldId>:<k>` with the number
 * of the customer row; the map tells which old numbers point at the account, and a journal under one of those keys is a replay, not a second
 * posting. A merchant's old key already has the new form (merchants kept their ids), so only the customer numbers count.
 *
 * @param pairs the old numbers of the account (`LegacyAccounts.legacyIdsOf`)
 * @param idempotencyKey the caller's `Idempotency-Key`
 * @returns the old keys, without repeats; empty for an account made after the merge
 */
export function legacyAdjustmentKeysOf(
  pairs: ReadonlyArray<{ readonly type: string; readonly id: number }>,
  idempotencyKey: string,
): string[] {
  const keys = pairs
    .filter((pair) => pair.type === 'customer')
    .map((pair) => `adjust:customer:${pair.id}:${idempotencyKey}`);
  return [...new Set(keys)];
}

/** The posted journal of an adjustment, as far as the replay check needs it. */
export interface PostedAdjustment {
  readonly memo: string;
  /** The journal lines (amount signed, debit positive) with the kind of their account. */
  readonly entries: ReadonlyArray<{ readonly amount: string; readonly account: { readonly kind: string } }>;
}

/**
 * Tells whether a stored journal is the adjustment a request asks for.
 *
 * Why: a key reused for a different adjustment is a client bug: refuse it instead of answering the first one. The journal may sit on either
 * wallet kind (the kind can have changed since the first request), so the wallet line is the one on any wallet account.
 *
 * @param first the journal found under the key
 * @param memo what this request would write (`Manual <direction>: <reason>`)
 * @param direction `credit` or `debit`
 * @param amount the positive amount
 * @returns true when the memo and the wallet line agree
 */
export function isSameAdjustment(
  first: PostedAdjustment,
  memo: string,
  direction: 'credit' | 'debit',
  amount: Money,
): boolean {
  const walletLine = first.entries.find(
    (entry) => entry.account.kind === 'client_wallet' || entry.account.kind === 'customer_wallet',
  );
  if (first.memo !== memo || !walletLine) return false;
  // The wallet line is signed debit positive: a credit to the wallet is negative.
  return Money.of(walletLine.amount).eq(direction === 'credit' ? amount.neg() : amount);
}

/**
 * The refusal of a credit to a store balance that cannot hold one.
 *
 * Why: a store balance belongs to an account that can sign in and is not erased; a debit is always allowed (it can only take money back).
 *
 * @param account the account's status and whether it has a login
 * @param direction `credit` or `debit`
 * @returns the refusal code, or `undefined` when the adjustment may go on
 */
export function storeCreditRefusal(
  account: { readonly status: string; readonly hasAccount: boolean },
  direction: 'credit' | 'debit',
): 'ANONYMIZED' | 'NO_ACCOUNT' | undefined {
  if (direction !== 'credit') return undefined;
  if (account.status === 'anonymized') return 'ANONYMIZED';
  return account.hasAccount ? undefined : 'NO_ACCOUNT';
}

/** The three staff wallet actions that carry an `Idempotency-Key` stored in `wallet_action_keys` (`WALLET_ACTIONS`). */
export type WalletActionName = 'freeze' | 'unfreeze' | 'credit_limit';

/** A JSON value written with its object keys in order, so two spellings of one body hash alike. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, inner]) => inner !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonicalJson(inner)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * The text a staff wallet action is hashed from.
 *
 * Why: the stored key must tell "the same request again" from "another request under the same key": the hash covers the action and
 * the validated body, never the account (the key is unique per account already) and never the staff member.
 *
 * @param action which action
 * @param body the validated body (reason, or the credit limit)
 * @returns a canonical text; the caller keys-hashes it (`TokenService.lookupHash`, decision 054)
 */
export function walletActionRequestOf(action: WalletActionName, body: Readonly<Record<string, unknown>>): string {
  return `wallet-action:${action}:${canonicalJson(body)}`;
}

/**
 * The refusal of a credit limit on a store balance.
 *
 * Why: credit belongs to the merchant kind only; a store balance never goes below zero except by a chargeback clawback.
 *
 * @returns `422` on `creditLimit`, code `not_allowed`
 */
export function storeCreditLimitRefusal(): AppError {
  return new AppError('VALIDATION_FAILED', {
    errors: [{ field: 'creditLimit', code: 'not_allowed', message: 'A store balance has no credit limit.' }],
  });
}

/** What {@link unfreezeRefusal} judges. */
export interface UnfreezeFacts {
  readonly kind: WalletPool;
  /** The wallet balance in the account's own sign. */
  readonly balance: Money;
  /** Open disputes of the account's card top-ups. */
  readonly openDisputes: number;
}

/**
 * Tells why a hold may not be lifted yet.
 *
 * Why: a person decides to lift a hold (plan 21 P2), but a store balance below zero stays held until it is brought back (the database also
 * refuses it at commit), and so does any wallet with an open dispute of one of its top-ups. A merchant wallet below zero is a use of
 * credit and does not stop an unfreeze.
 *
 * @param facts the wallet kind, its balance and the open top-up disputes
 * @returns `negative_balance` (409 `CONFLICT`), `open_dispute` (409 `OPEN_DISPUTE`) or `undefined`
 */
export function unfreezeRefusal(facts: UnfreezeFacts): 'negative_balance' | 'open_dispute' | undefined {
  if (facts.kind === 'store' && facts.balance.isNegative()) return 'negative_balance';
  return facts.openDisputes > 0 ? 'open_dispute' : undefined;
}

/**
 * How an audit row names an account: the name, else the email; an anonymized one by number (its old name is personal data).
 *
 * @param account the account's id, name, email and status
 * @returns the label
 */
export function accountLabelOf(account: {
  readonly id: number;
  readonly name: string;
  readonly email: string;
  readonly status: string;
}): string {
  if (account.status === 'anonymized') return `account ${account.id}`;
  return account.name.trim() || account.email;
}

/** Which wallet a statement request asks for: the live one, or the history of an inactive one. */
export type StatementWallet = 'live' | 'merchant' | 'store';

/**
 * Names the ledger account kind a statement reads.
 *
 * Why: the statement lists the live wallet; `wallet=merchant|store` reads the history of a wallet the rank change left behind.
 *
 * @param choice the `wallet` parameter (`live` when absent)
 * @param liveKind the ledger kind of the account's live wallet
 * @returns `client_wallet` or `customer_wallet`
 */
export function statementLedgerKindOf(
  choice: StatementWallet | undefined,
  liveKind: WalletLedgerKind,
): WalletLedgerKind {
  if (choice === 'merchant') return 'client_wallet';
  if (choice === 'store') return 'customer_wallet';
  return liveKind;
}

/**
 * Reads the posting-time window of a statement request.
 *
 * @param filters the parsed filters of the list request (`createdAt` with `gte` and `lte`)
 * @returns the first and last instant, each only when the request sent it
 */
export function statementWindowOf(filters: readonly ParsedFilter[]): { from?: Date; to?: Date } {
  const at = (op: 'gte' | 'lte') => {
    const value = filters.find((filter) => filter.field === 'createdAt' && filter.op === op)?.values[0];
    return value instanceof Date ? value : undefined;
  };
  const from = at('gte');
  const to = at('lte');
  return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
}

/** What {@link emptyAccountWallet} needs to describe a wallet that has no ledger row yet. */
export interface EmptyWalletFacts {
  readonly kind: WalletPool;
  /** Whether the account's rank allows credit (merchant kind only). */
  readonly creditAllowed: boolean;
  /** The store balance's master switch (always true for a merchant wallet). */
  readonly enabled: boolean;
  /** The approval limit of this wallet kind. */
  readonly adjustApprovalLimit: Money;
}

/**
 * The wallet view of an account that never had a wallet: all zeros.
 *
 * Why: money.md: "zeros while no accounts exist"; the wallet is opened by its first posting, hold or credit limit, so a read before that
 * answers the same keys with zero figures.
 *
 * @param facts the kind and the three facts a zero wallet still carries
 * @returns the view
 */
export function emptyAccountWallet(facts: EmptyWalletFacts): AccountWalletView {
  const zero = Money.zero().toWire();
  return {
    kind: facts.kind,
    currency: BASE_CURRENCY,
    balance: zero,
    reserved: zero,
    creditLimit: zero,
    available: zero,
    creditAllowed: facts.creditAllowed,
    frozen: null,
    enabled: facts.enabled,
    pendingTopUps: { count: 0, amount: zero },
    openDisputes: 0,
    adjustApprovalLimit: facts.adjustApprovalLimit.toWire(),
  };
}
