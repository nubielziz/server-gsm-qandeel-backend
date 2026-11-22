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

/** A change of the webhook signing keys, as a create or update request carries it (both write-only). */
export interface WebhookSecretChange {
  /** A non-empty value replaces the first key and keeps the second; empty or absent keeps the first. */
  readonly webhookSecret?: string | undefined;
  /** A string sets the second key; `null` removes it; absent keeps it. */
  readonly secondaryWebhookSecret?: string | null | undefined;
}

/**
 * Tells whether a gateway request sets, replaces or removes one of its secrets.
 *
 * Why: decision 046: the API secret and the webhook secrets are what payment confirmations are checked against, so only an Owner
 * sets them. Removing a second webhook secret that the method does not have changes nothing, so it is not a change of credentials.
 *
 * @param change what the request sent
 * @param stored the webhook secrets stored for the method, first one first; leave it out for a method that is being added
 * @returns true for a non-empty `secret` or `webhookSecret`, or any `secondaryWebhookSecret` (a value, or `null` to remove it) except
 *   a `null` for a stored method that has no second secret
 */
export function changesCredentials(
  change: { readonly secret?: string | undefined } & WebhookSecretChange,
  stored?: readonly string[],
): boolean {
  if (change.secret || change.webhookSecret) return true;
  if (change.secondaryWebhookSecret === undefined) return false;
  return !(change.secondaryWebhookSecret === null && stored !== undefined && stored.length < 2);
}

/**
 * Tells whether a change touches the automatic setup of a payment method: its kind or its driver while it is automatic.
 *
 * Why: decision 046: the driver and the manual or automatic kind decide who confirms a payment and with which stored keys, so any
 * change of `isManual` or of `driver` on a method that is automatic before or after the change (a manual method made automatic, an
 * automatic one made manual, a new driver) is kept for Owners like the secrets. A method that is manual before and after keeps its
 * plain rule.
 *
 * @param current the stored kind and driver
 * @param next the kind and driver after the change
 * @returns true when the method is automatic before or after the change and its kind or its driver differs
 */
export function changesAutomaticSetup(
  current: { readonly isManual: boolean; readonly driver: string },
  next: { readonly isManual: boolean; readonly driver: string },
): boolean {
  const automatic = !current.isManual || !next.isManual;
  return automatic && (current.isManual !== next.isManual || current.driver !== next.driver);
}

/**
 * The webhook signing keys a gateway keeps after a change.
 *
 * Why: plan 24C § 3: a gateway keeps up to two keys (a second Stripe endpoint, or the new key while rotating); the second exists only next
 * to a first, so a delivery always has the key staff set first.
 *
 * @param stored the keys stored now, first one first
 * @param change what the request sent
 * @returns the keys to store (empty = none) and whether they differ from the stored ones, or the field error when a second key would
 *   stand alone (`secondaryWebhookSecret`, `requires_first`)
 */
export function nextWebhookSecrets(
  stored: readonly string[],
  change: WebhookSecretChange,
): { readonly secrets: readonly string[]; readonly changed: boolean } | FieldError {
  const first = change.webhookSecret ? change.webhookSecret : stored[0];
  const second = change.secondaryWebhookSecret === undefined ? stored[1] : (change.secondaryWebhookSecret ?? undefined);
  if (second !== undefined && first === undefined) {
    return {
      field: 'secondaryWebhookSecret',
      code: 'requires_first',
      message: 'Set the webhook signing secret before a second one.',
    };
  }
  const secrets = [first, second].filter((secret): secret is string => secret !== undefined && secret !== '');
  const changed = secrets.length !== stored.length || secrets.some((secret, index) => secret !== stored[index]);
  return { secrets, changed };
}

/**
 * The driver ids and codes whose name is the top-up method itself.
 *
 * Why: feature 32 adds the drivers of the ready-made crypto methods (`crypto_transfer`, `binance_pay`, and the two automatic ones that
 * wait for their connection): their payments are `usdt`. The ready-made bank-like ones (`bank_transfer`, `vodafone_cash`,
 * `fawry_transfer`, `instapay`) are manual and already fall to `bank`.
 */
const METHOD_BY_NAME: Readonly<Record<string, TopupMethod>> = {
  bank: 'bank',
  wise: 'wise',
  card: 'card',
  stripe: 'card',
  usdt: 'usdt',
  crypto: 'usdt',
  crypto_transfer: 'usdt',
  binance_pay: 'usdt',
  nowpayments: 'usdt',
  binance_pay_auto: 'usdt',
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

/** The storefront policy that asks a cardholder for 3-D Secure (RULES settings 5; also the risk rule of that name): on unless switched off. */
export const REQUIRE_3DS_KEY = 'require3ds';

/**
 * Tells whether a card checkout asks for 3-D Secure.
 *
 * Why: decision 049: card top-ups follow the same policy as shop card payments: on unless staff stored `false`, and only through a
 * method that supports it. Every checkout that opens a card page asks this one function.
 *
 * @param policy the stored value of `require3ds` (`undefined` when never set)
 * @param supports3ds `payment_gateways.supports_3ds` of the method
 * @returns true when the checkout asks for it
 */
export function asks3ds(policy: unknown, supports3ds: boolean): boolean {
  return policy !== false && supports3ds;
}
