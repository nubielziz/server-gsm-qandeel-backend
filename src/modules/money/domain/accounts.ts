// Ledger account rules shared by the writer, the readers and the wallet views (decision 024): which side each account kind
// normally sits on, how a stored balance maps to the debit-positive sign of the wire, and the wallet figures.
import { Money } from '../../../common/money';
import type { LedgerAccountKind } from '../db/schema';

/**
 * The ledger is kept in the base currency (decision 011); merchants hold USD today.
 *
 * Why: B111 and decision 011: foreign-currency payments are posted at their locked rate, so every ledger account is USD.
 */
export const BASE_CURRENCY = 'USD';

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
 * Why: decision 024: liability and income are credit-normal; `owner_capital` is equity, the counterpart of opening balances.
 */
export const CREDIT_NORMAL_KINDS = [
  'fee_income',
  'vat_payable',
  'customer_funds',
  'revenue',
  'owner_capital',
  'client_wallet',
  'client_hold',
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
 * amount out of the wallet. One function so every route (admin, portal, v1, Dhru) answers the same numbers.
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
