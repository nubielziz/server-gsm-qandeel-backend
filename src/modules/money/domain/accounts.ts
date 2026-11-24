// Ledger account rules shared by the writer, the readers and the wallet views (decision 024): which side each account kind
// normally sits on, how a stored balance maps to the debit-positive sign of the wire, and the wallet figures.
import { Money } from '../../../common/money';
import type { LedgerAccountKind, LedgerOwnerType } from '../db/schema';
import type { AccountRef } from './ledger-lines';

/**
 * The ledger is kept in the base currency (decision 011); merchants hold USD today.
 *
 * Why: B111 and decision 011: foreign-currency payments are posted at their locked rate, so every ledger account is USD.
 */
export const BASE_CURRENCY = 'USD';

/**
 * The one owner type of every wallet and hold in the ledger.
 *
 * Why: decision 064: a merchant and a shopper are one account type, so `client_wallet`, `client_hold` and `customer_wallet` are all owned
 * by `('account', id)`; the ledger identity `(kind, owner_type, owner_id, currency)` then holds at most one wallet of each kind per account.
 * Rows written before the merge keep their old owner words only until the expand migration re-keys them.
 */
export const ACCOUNT_OWNER_TYPE = 'account' as const satisfies LedgerOwnerType;

/**
 * The ledger account of an account's merchant-kind wallet.
 *
 * Why: the one place a `client_wallet` reference is built, so every money event names the owner the same way (decision 064).
 *
 * @param accountId the account (a merchant keeps its old number as its account id)
 * @returns the reference of the `client_wallet` of the account
 */
export function walletAccountOf(accountId: number): AccountRef {
  return { kind: 'client_wallet', ownerType: ACCOUNT_OWNER_TYPE, ownerId: accountId };
}

/**
 * The ledger account of what an account's open orders hold.
 *
 * @param accountId the account
 * @returns the reference of the `client_hold` of the account
 */
export function holdAccountOf(accountId: number): AccountRef {
  return { kind: 'client_hold', ownerType: ACCOUNT_OWNER_TYPE, ownerId: accountId };
}

/**
 * The ledger account of an account's store-kind wallet (the store balance).
 *
 * @param accountId the account
 * @returns the reference of the `customer_wallet` of the account
 */
export function storeWalletAccountOf(accountId: number): AccountRef {
  return { kind: 'customer_wallet', ownerType: ACCOUNT_OWNER_TYPE, ownerId: accountId };
}

/** The side of a journal on which an account's balance grows. */
export type NormalSide = 'debit' | 'credit';

/**
 * Account kinds whose balance grows with debits (assets and expenses).
 *
 * Why: decision 024 "Normal side from the map's kinds": asset and expense are debit-normal. The map lists `bank`,
 * `gateway_clearing` and `supplier_prepaid` as assets; `chargeback_loss`, `gateway_fees`, `cogs`, `adjustments` and
 * `commission_expense` as expenses.
 */
export const DEBIT_NORMAL_KINDS = [
  'bank',
  'gateway_clearing',
  'supplier_prepaid',
  'chargeback_loss',
  'gateway_fees',
  'cogs',
  'adjustments',
  'commission_expense',
] as const satisfies readonly LedgerAccountKind[];

/**
 * Account kinds whose balance grows with credits (liabilities, income and equity).
 *
 * Why: decision 024: liability and income are credit-normal; `owner_capital` is equity, the counterpart of opening balances. A
 * customer's store balance (`customer_wallet`, feature 21) is a liability like a merchant wallet; the trial balance and the reconcile
 * read this list, so a missing kind would flag every customer wallet.
 */
export const CREDIT_NORMAL_KINDS = [
  'fee_income',
  'vat_payable',
  'customer_funds',
  'revenue',
  'owner_capital',
  'client_wallet',
  'client_hold',
  'customer_wallet',
] as const satisfies readonly LedgerAccountKind[];

const DEBIT_NORMAL = new Set<LedgerAccountKind>(DEBIT_NORMAL_KINDS);

/**
 * Tells on which side an account kind normally sits.
 *
 * Why: `ledger_accounts.balance` and `ledger_entries.balance_after` are kept in this sign (decision 024), so a wallet
 * balance reads as "merchant money" without flipping.
 *
 * @param kind an account kind
 * @returns `debit` for assets and expenses, `credit` for liabilities, income and equity
 */
export function normalSideOf(kind: LedgerAccountKind): NormalSide {
  return DEBIT_NORMAL.has(kind) ? 'debit' : 'credit';
}

/**
 * Turns a debit-positive amount into the change of a balance kept in the account's normal sign.
 *
 * Why: decision 024: a debit-normal balance grows with `+= amount`, a credit-normal one with `-= amount` (the entry amount
 * is signed: debit above zero, credit below).
 *
 * @param kind the account kind
 * @param signedAmount the entry amount, debit positive
 * @returns the change to add to the stored balance
 */
export function balanceDelta(kind: LedgerAccountKind, signedAmount: Money): Money {
  return normalSideOf(kind) === 'debit' ? signedAmount : signedAmount.neg();
}

/**
 * Converts a balance in the account's normal sign to the debit-positive sign of the wire.
 *
 * Why: the trial balance, the reconcile report and a ledger line's `balanceAfter` use one sign for every account (ANSWERS
 * finance Q2: "debit-positive"), so a credit-normal account reads negative.
 *
 * @param kind the account kind
 * @param balance the stored balance
 * @returns the same balance, debit positive
 */
export function toDebitPositive(kind: LedgerAccountKind, balance: Money): Money {
  return normalSideOf(kind) === 'debit' ? balance : balance.neg();
}

/** The four wallet figures of a merchant, as wire `Money` strings (resolution identity-platform-1; decision 024). */
export interface WalletView {
  /** The wallet balance, merchant side (positive is the merchant's money); negative while credit is in use. */
  readonly balance: string;
  /** What open orders hold (`client_hold`). */
  readonly reserved: string;
  /** The wallet's `overdraft_limit`. */
  readonly creditLimit: string;
  /** What the merchant can spend now: balance plus credit limit (a hold already left the wallet). */
  readonly available: string;
}

/**
 * Builds the wallet view from the two accounts' figures.
 *
 * Why: decision 024 "Wallet figures on the wire": `available = balance + creditLimit`, because a hold has already moved its
 * amount out of the wallet. One function so every route (admin, portal, Dhru) answers the same numbers.
 *
 * @param figures wallet balance, hold balance and credit limit
 * @returns the four figures as wire strings
 */
export function walletViewOf(figures: { balance: Money; reserved: Money; creditLimit: Money }): WalletView {
  return {
    balance: figures.balance.toWire(),
    reserved: figures.reserved.toWire(),
    creditLimit: figures.creditLimit.toWire(),
    available: figures.balance.add(figures.creditLimit).toWire(),
  };
}

/** What the live wallet of one account is made of (decision 064: the wallet kind follows the rank kind). */
export interface LiveWalletFacts {
  /** `merchant`: `client_wallet` and `client_hold`, credit when the rank allows it; `store`: `customer_wallet`, pay first. */
  readonly kind: 'merchant' | 'store';
  /** The wallet balance in the account's own sign (zero while the wallet was never opened). */
  readonly balance: Money;
  /** The balance of the hold (merchant kind only; zero otherwise). */
  readonly hold: Money;
  /** The credit limit (merchant kind only; zero otherwise). */
  readonly creditLimit: Money;
  /** Whether staff put the wallet on hold. */
  readonly frozen: boolean;
  /** Whether the wallet may be used at all: always true for a merchant wallet, the master switch for a store balance. */
  readonly enabled: boolean;
}

/**
 * Builds the four wallet figures of an account from its live wallet.
 *
 * Why: a merchant wallet answers `available = balance + creditLimit` (a hold has already left the wallet, decision 024); a store balance has
 * neither hold nor credit, and what can be spent is nothing while the wallet is on hold, switched off or not above zero (plan 21 § 7.1, the
 * same rule as the store balance's own `availableOf`). One function, so the account list and the wallet routes answer the same numbers.
 *
 * @param facts the live wallet of the account
 * @returns the four figures as wire strings
 */
export function liveWalletFigures(facts: LiveWalletFacts): WalletView {
  if (facts.kind === 'merchant') {
    return walletViewOf({ balance: facts.balance, reserved: facts.hold, creditLimit: facts.creditLimit });
  }
  const zero = Money.zero();
  const spendable = facts.frozen || !facts.enabled || !facts.balance.isPositive() ? zero : facts.balance;
  return {
    balance: facts.balance.toWire(),
    reserved: zero.toWire(),
    creditLimit: zero.toWire(),
    available: spendable.toWire(),
  };
}

/**
 * The wallet view of a merchant that has no accounts yet.
 *
 * Why: money.md: "Zeros when the merchant has no accounts yet".
 *
 * @returns zero balance, reserve, limit and available
 */
export function emptyWalletView(): WalletView {
  const zero = Money.zero();
  return walletViewOf({ balance: zero, reserved: zero, creditLimit: zero });
}
