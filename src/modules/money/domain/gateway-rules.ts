// Rules of the payment gateways (map routes /admin/payment-gateways, /client/payment-methods, stage 8): field checks, the secret
// hint, the top-up method of a gateway, the fee of a deposit and the amount limits. Pure: the services read rows and apply these.
import type { FieldError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { GATEWAY_AUDIENCES, type TopupMethod } from '../db/schema';

/** A gateway code or driver name: lower-case letters, digits, `-` and `_`, up to 40 (it is a URL segment, `/webhooks/payments/:gateway`). */
export const GATEWAY_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;

const PERCENT = /^\d{1,3}(\.\d{1,4})?$/;
const AMOUNT = /^\d{1,14}(\.\d{1,4})?$/;

/** The most hours a gateway may hold an automatic top-up or give a manual review (30 days). */
export const MAX_HOLD_HOURS = 720;

/** The text fields of a gateway as the console sends them (decimals as typed text), merged with the stored row on a change. */
export interface GatewayFields {
  readonly name: string;
  readonly code: string;
  readonly driver: string;
  readonly audience: string;
  readonly feePercent: string;
  readonly feeFixed: string;
  readonly minAmount: string;
  readonly maxAmount: string;
  readonly holdHours: number;
  readonly instructions: string;
}

/**
 * Checks the fields of a gateway.
 *
 * Why: the console's dialog rules (mock gatewayRoutes.ts): non-blank name, code and driver; audience b2c, b2b or both; a fee
 * percent from 0 to 100; money fields from 0; a maximum above zero is not below the minimum; hold hours a whole number from 0 to
 * 720. The code and the driver are lower-case slugs because the code is part of the webhook URL and the driver names the code that
 * talks to the gateway.
 *
 * @param fields the merged fields
 * @returns every problem found, with its field, in the console's order
 */
export function checkGatewayFields(fields: GatewayFields): FieldError[] {
  const problems: FieldError[] = [];
  const bad = (field: string, code: string, message: string) => problems.push({ field, code, message });
  if (fields.name.trim() === '') bad('name', 'required', 'Enter a name.');
  else if (fields.name.length > 80) bad('name', 'length', 'Keep the name to 80 characters or fewer.');
  if (fields.code === '') bad('code', 'required', 'Enter a code.');
  else if (!GATEWAY_SLUG_PATTERN.test(fields.code)) {
    bad('code', 'format', 'Use lower-case letters, digits, "-" and "_" (up to 40 characters).');
  }
  if (fields.driver === '') bad('driver', 'required', 'Enter a driver.');
  else if (!GATEWAY_SLUG_PATTERN.test(fields.driver)) {
    bad('driver', 'format', 'Use lower-case letters, digits, "-" and "_" (up to 40 characters).');
  }
  if (!(GATEWAY_AUDIENCES as readonly string[]).includes(fields.audience)) {
    bad('audience', 'enum', 'Choose B2C, B2B or both.');
  }
  if (!PERCENT.test(fields.feePercent) || Number(fields.feePercent) > 100) {
    bad('feePercent', 'range', 'Enter a fee from 0 to 100 percent, with up to four decimals.');
  }
  for (const field of ['feeFixed', 'minAmount', 'maxAmount'] as const) {
    if (!AMOUNT.test(fields[field])) bad(field, 'amount', 'Enter an amount of 0 or more, with up to four decimals.');
  }
  if (
    AMOUNT.test(fields.minAmount) &&
    AMOUNT.test(fields.maxAmount) &&
    Money.of(fields.maxAmount).isPositive() &&
    Money.of(fields.maxAmount).cmp(Money.of(fields.minAmount)) < 0
  ) {
    bad('maxAmount', 'range', 'The maximum cannot be below the minimum (0 means no limit).');
  }
  if (!Number.isInteger(fields.holdHours) || fields.holdHours < 0 || fields.holdHours > MAX_HOLD_HOURS) {
    bad('holdHours', 'range', `Enter a whole number of hours from 0 to ${MAX_HOLD_HOURS}.`);
  }
  if (fields.instructions.length > 2000) bad('instructions', 'length', 'Keep the instructions to 2000 characters.');
  return problems;
}

/**
 * The hint the console shows for a stored secret: four bullets and the last four characters.
 *
 * Why: RESOLUTIONS money-14: the secret is write-only; the hint only says that one is stored.
 *
 * @param secret the stored credential, if any
 * @returns `••••` plus the last four characters, or `null` when there is no secret
 */
export function secretHintOf(secret: string | undefined | null): string | null {
  if (!secret) return null;
  return `••••${secret.slice(-4)}`;
}

/** The driver ids and codes whose name is the top-up method itself. */
const METHOD_BY_NAME: Readonly<Record<string, TopupMethod>> = {
  bank: 'bank',
  wise: 'wise',
  card: 'card',
  stripe: 'card',
  usdt: 'usdt',
  crypto: 'usdt',
};

/**
 * The top-up method a gateway stands for (the money-2 vocabulary: bank, card, usdt, wise).
 *
 * Why: `payments.method_type` of a top-up is one of four words (RESOLUTIONS money-2) but a gateway row has none: it is read from the
 * driver (`card`, `crypto`, `bank`, `wise`), and an unknown driver is a bank transfer when it is manual and a card otherwise.
 *
 * @param driver the gateway's driver
 * @param isManual whether staff review its payments
 * @returns the method
 */
export function topupMethodOf(driver: string, isManual: boolean): TopupMethod {
  return METHOD_BY_NAME[driver.toLowerCase()] ?? (isManual ? 'bank' : 'card');
}

/** The label of a method in a ledger memo (`Deposit PAY-1000 (Bank transfer)`). */
export const METHOD_LABELS: Readonly<Record<TopupMethod, string>> = {
  bank: 'Bank transfer',
  card: 'Card',
  usdt: 'USDT',
  wise: 'Wise',
};

/**
 * The fee a merchant pays on a deposit: a percent of the amount plus a fixed fee.
 *
 * Why: the merchant pays the gateway fee on top (RULES finance 4): the wallet receives amount minus fee.
 *
 * @param amount what the merchant pays
 * @param feePercent the gateway's percent
 * @param feeFixed the gateway's fixed fee
 * @returns the fee, rounded half up to four decimals
 */
export function depositFee(amount: Money, feePercent: string, feeFixed: string): Money {
  return amount.pct(feePercent).add(Money.of(feeFixed));
}

/**
 * The largest deposit through a gateway for a merchant: the lower of the gateway's maximum and the group's limit per deposit.
 *
 * Why: B162 and catalog-17: `0` means no limit on that side, so a zero never lowers the other.
 *
 * @param gatewayMax the gateway's `max_amount` (0 = no limit)
 * @param depositLimit the merchant group's `deposit_limit` (0 = no limit)
 * @returns the larger-than-zero limit, or `0.0000` when neither side limits
 */
export function effectiveMaxAmount(gatewayMax: string, depositLimit: string): string {
  const a = Money.of(gatewayMax);
  const b = Money.of(depositLimit);
  if (a.isZero()) return b.toWire();
  if (b.isZero()) return a.toWire();
  return (a.cmp(b) <= 0 ? a : b).toWire();
}

/** What {@link checkDepositAmount} compares an amount with. */
export interface DepositLimits {
  readonly minAmount: string;
  readonly maxAmount: string;
  readonly depositLimit: string;
  readonly feePercent: string;
  readonly feeFixed: string;
}

/**
 * Checks a deposit amount against the gateway's limits and the group's limit per deposit.
 *
 * Why: POST /client/invoices refuses an amount outside the gateway's minimum and maximum, above the group's non-zero deposit limit
 * (catalog-17) or too small to cover the fee, as a `422` on `amount`.
 *
 * @param amount the amount the merchant wants to pay
 * @param limits the gateway's limits, the group's limit and the fee
 * @returns the problem on `amount`, or `undefined`
 */
export function checkDepositAmount(amount: Money, limits: DepositLimits): FieldError | undefined {
  const fail = (code: string, message: string): FieldError => ({ field: 'amount', code, message });
  if (!amount.isPositive()) return fail('range', 'Enter an amount greater than zero.');
  const min = Money.of(limits.minAmount);
  if (!min.isZero() && amount.cmp(min) < 0)
    return fail('min', `The minimum for this payment method is ${min.toWire()}.`);
  const max = Money.of(limits.maxAmount);
  if (!max.isZero() && amount.cmp(max) > 0)
    return fail('max', `The maximum for this payment method is ${max.toWire()}.`);
  const group = Money.of(limits.depositLimit);
  if (!group.isZero() && amount.cmp(group) > 0) {
    return fail('deposit_limit', `Your group's limit per deposit is ${group.toWire()}.`);
  }
  if (depositFee(amount, limits.feePercent, limits.feeFixed).cmp(amount) >= 0) {
    return fail('fee', 'The amount does not cover the fee of this payment method.');
  }
  return undefined;
}
