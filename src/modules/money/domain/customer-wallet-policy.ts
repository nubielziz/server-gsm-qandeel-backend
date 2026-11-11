// The customer wallet policy (feature 21, plan § 5.8): the eight settings turned into one value with safe defaults, and the pure rules that
// use it: top-up limits, liveness of an open top-up, the store status of a top-up, the customer's memo and the spendable figures.
import type { FieldError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { CUSTOMER_WALLET_SETTINGS, CUSTOMER_WALLET_SETTING_RANGES } from '../../platform';

/** At most this many unpaid ("live") top-ups per customer (plan P8). */
export const MAX_OPEN_TOPUPS = 3;

/** An automatic top-up without a payment stops counting as unpaid after this many hours (its hosted page has expired by then). */
export const AUTOMATIC_TOPUP_LIVE_HOURS = 24;

/** The customer wallet settings, read once per use case. */
export interface CustomerWalletPolicy {
  /** The master switch: off blocks new top-ups and balance payments (P6). */
  readonly enabled: boolean;
  /** Whether automatic (card) gateways may top up (O7). */
  readonly cardTopUps: boolean;
  readonly minTopUp: Money;
  readonly maxTopUp: Money;
  readonly maxBalance: Money;
  readonly topUpsPerDay: number;
  readonly topUpAmountPerDay: Money;
  /** Adjustments above this need a second approver (O14). */
  readonly adjustApprovalLimit: Money;
}

/**
 * The defaults of the eight settings (lead rule L5).
 *
 * Why: the owner's defaults: switches off, $5 to $500 per top-up, $1,000 at most on the balance, 5 top-ups and $1,000 per 24 hours, an
 * approval limit of $500.
 */
export const CUSTOMER_WALLET_DEFAULTS = {
  enabled: false,
  cardTopUps: false,
  minTopUp: 5,
  maxTopUp: 500,
  maxBalance: 1000,
  topUpsPerDay: 5,
  topUpAmountPerDay: 1000,
  adjustApprovalLimit: 500,
} as const;

function whole(settings: Readonly<Record<string, unknown>>, key: string, fallback: number): number {
  const value = settings[key];
  const range = CUSTOMER_WALLET_SETTING_RANGES[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || !range) return fallback;
  return value >= range.min && value <= range.max ? value : fallback;
}

/**
 * Turns the settings snapshot into the wallet policy.
 *
 * Why: plan 21 § 5.8: a value of the wrong type or range falls back to its default, and a minimum above the maximum falls back to both
 * defaults, so a mistake in the console can never lift a limit or lock every top-up.
 *
 * @param settings the snapshot of `SettingsReader.all()`
 * @returns the policy
 */
export function customerWalletPolicy(settings: Readonly<Record<string, unknown>>): CustomerWalletPolicy {
  const keys = CUSTOMER_WALLET_SETTINGS;
  const d = CUSTOMER_WALLET_DEFAULTS;
  let min = whole(settings, keys.minTopUp, d.minTopUp);
  let max = whole(settings, keys.maxTopUp, d.maxTopUp);
  if (min > max) {
    min = d.minTopUp;
    max = d.maxTopUp;
  }
  return {
    enabled: settings[keys.enabled] === true,
    cardTopUps: settings[keys.cardTopUps] === true,
    minTopUp: Money.of(min),
    maxTopUp: Money.of(max),
    maxBalance: Money.of(whole(settings, keys.maxBalance, d.maxBalance)),
    topUpsPerDay: whole(settings, keys.topUpsPerDay, d.topUpsPerDay),
    topUpAmountPerDay: Money.of(whole(settings, keys.topUpAmountPerDay, d.topUpAmountPerDay)),
    adjustApprovalLimit: Money.of(whole(settings, keys.adjustApprovalLimit, d.adjustApprovalLimit)),
  };
}

/** An open top-up as the liveness rule sees it. */
export interface OpenTopUpFacts {
  /** Whether the top-up's gateway is manual (bank, CliQ): staff review it, so it never expires by itself. */
  readonly manual: boolean;
  readonly createdAt: Date;
  /** Whether a payment waits for review or for the automatic credit. */
  readonly hasPendingPayment: boolean;
}

/**
 * Tells whether an open top-up still counts as unpaid.
 *
 * Why: plan 21 § 5.6.4 e: an open manual top-up waits for the customer's transfer; an automatic one whose hosted page was never paid
 * stops blocking the customer after 24 hours; a top-up with a pending payment is money in flight.
 *
 * @param topUp the open top-up
 * @param now the clock's time
 * @returns true when it counts against the unpaid and daily limits
 */
export function isLiveTopUp(topUp: OpenTopUpFacts, now: Date): boolean {
  if (topUp.manual || topUp.hasPendingPayment) return true;
  return now.getTime() - topUp.createdAt.getTime() < AUTOMATIC_TOPUP_LIVE_HOURS * 3_600_000;
}

/** What {@link checkTopUp} compares a new top-up with. */
export interface TopUpCheckInput {
  /** What the customer pays. */
  readonly amount: Money;
  /** The gateway fee on it. */
  readonly fee: Money;
  /** The gateway's own minimum and maximum (`0` = none). */
  readonly gatewayMin: string;
  readonly gatewayMax: string;
  /** The wallet balance now (may be negative). */
  readonly balance: Money;
  /** Live unpaid top-ups of the customer, and the net they would add. */
  readonly liveOpenCount: number;
  readonly pendingNet: Money;
  /** Top-ups of the trailing 24 hours that count (live open or paid), without this one. */
  readonly dayCount: number;
  readonly dayAmount: Money;
}

/** A refusal of {@link checkTopUp}: a field error (`422`) or the "too many unpaid" conflict (`409`). */
export type TopUpRefusal = { readonly field: FieldError } | { readonly conflict: string };

/**
 * Checks a new top-up against the gateway, the policy and the customer's recent top-ups.
 *
 * Why: plan 21 § 5.6.4 e and O8: the limits are the owner's settings, enforced in SQL-fed pure code under the customer's advisory lock (the
 * Redis limiter is only a hint). Each refusal is a `422` on `amount` with its code, except the unpaid limit (`409 CONFLICT`).
 *
 * @param input the new top-up and the customer's figures
 * @param policy the wallet policy
 * @returns the first refusal, or `undefined` when the top-up may be created
 */
export function checkTopUp(input: TopUpCheckInput, policy: CustomerWalletPolicy): TopUpRefusal | undefined {
  const fail = (code: string, message: string): TopUpRefusal => ({ field: { field: 'amount', code, message } });
  const gatewayMin = Money.of(input.gatewayMin);
  const min = gatewayMin.cmp(policy.minTopUp) > 0 ? gatewayMin : policy.minTopUp;
  if (input.amount.cmp(min) < 0) return fail('min', `The smallest top-up is ${min.toWire()} USD.`);
  const gatewayMax = Money.of(input.gatewayMax);
  const max = !gatewayMax.isZero() && gatewayMax.cmp(policy.maxTopUp) < 0 ? gatewayMax : policy.maxTopUp;
  if (input.amount.cmp(max) > 0) return fail('max', `The largest top-up is ${max.toWire()} USD.`);
  if (input.fee.cmp(input.amount) >= 0) return fail('fee', 'The amount does not cover the fee of this payment method.');
  if (input.liveOpenCount >= MAX_OPEN_TOPUPS) {
    return { conflict: `You have ${MAX_OPEN_TOPUPS} unpaid top-ups. Pay or cancel one first.` };
  }
  if (input.dayCount + 1 > policy.topUpsPerDay) {
    return fail('daily_count', `You can top up at most ${policy.topUpsPerDay} times in 24 hours.`);
  }
  if (input.dayAmount.add(input.amount).cmp(policy.topUpAmountPerDay) > 0) {
    return fail('daily_amount', `You can top up at most ${policy.topUpAmountPerDay.toWire()} USD in 24 hours.`);
  }
  const net = input.amount.sub(input.fee);
  if (input.balance.add(input.pendingNet).add(net).cmp(policy.maxBalance) > 0) {
    return fail('max_balance', `Your store balance can hold at most ${policy.maxBalance.toWire()} USD.`);
  }
  return undefined;
}

/** The store status of a top-up (plan § 7.1 `TopUp.status`). */
export type TopUpStatus = 'awaiting_payment' | 'in_review' | 'credited' | 'rejected' | 'cancelled';

/**
 * Derives the store status of a top-up from its invoice and its newest payment.
 *
 * Why: plan 21 § 5.6.4: a top-up is an invoice and, once paid, a payment; the store sees one object.
 *
 * @param invoiceStatus `open`, `paid` or `void`
 * @param paymentStatus the newest payment's status, or `null` when there is none
 * @returns the store status
 */
export function topUpStatusOf(invoiceStatus: string, paymentStatus: string | null): TopUpStatus {
  if (invoiceStatus === 'paid') return 'credited';
  if (invoiceStatus === 'void') return paymentStatus === 'rejected' ? 'rejected' : 'cancelled';
  return paymentStatus === 'pending' ? 'in_review' : 'awaiting_payment';
}

/**
 * The memo a customer reads on their statement.
 *
 * Why: P3 and risk K12: a staff adjustment's memo holds the staff reason, an internal note; the customer reads "Balance adjustment". System
 * memos name only `PAY-`, `SF-`, `RF-` and `DP-` numbers and are shown as they are.
 *
 * @param kind the ledger kind of the line
 * @param storedMemo the transaction's memo
 * @returns the memo to show the customer
 */
export function customerMemo(kind: string, storedMemo: string): string {
  return kind === 'adjustment' ? 'Balance adjustment' : storedMemo;
}

/**
 * What a customer can spend from the balance now.
 *
 * Why: plan 21 § 7.1: nothing while the wallet is frozen, the switch is off or the balance is below zero; else the balance.
 *
 * @param facts the balance, whether it is frozen and whether the wallet is switched on
 * @returns the available amount
 */
export function availableOf(facts: { balance: Money; frozen: boolean; enabled: boolean }): Money {
  if (facts.frozen || !facts.enabled || !facts.balance.isPositive()) return Money.zero();
  return facts.balance;
}

/**
 * How much more the balance may receive through top-ups.
 *
 * Why: plan 21 § 7.1 `room = max(0, maxBalance − balance − pending)`, so the store can tell the customer the largest top-up that fits.
 *
 * @param maxBalance the policy's maximum balance
 * @param balance the balance now
 * @param pendingNet the net of live unpaid top-ups
 * @returns the room, never below zero
 */
export function roomOf(maxBalance: Money, balance: Money, pendingNet: Money): Money {
  const room = maxBalance.sub(balance).sub(pendingNet);
  return room.isNegative() ? Money.zero() : room;
}
