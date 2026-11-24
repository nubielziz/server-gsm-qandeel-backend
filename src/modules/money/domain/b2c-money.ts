// The arithmetic of storefront payments, refunds and disputes (feature 16): base-currency conversion at the locked rate, the VAT
// share of a refund, the gateway fee, the payment status after refunds, and the method words. Pure functions on exact decimals.
import { Decimal } from 'decimal.js';
import type { JsonObject } from '../../../common/contract';
import { Money } from '../../../common/money';
import type { OrderMethod, OrderPaymentStatus } from '../db/schema';

/** Exact decimals with half-up rounding, whatever the global Decimal settings are. */
const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

const asMoney = (value: Decimal, places = 4): Money => Money.of(value.toDecimalPlaces(places).toFixed(4));

/**
 * Converts an amount in the payment's currency to the base currency (USD).
 *
 * Why: RESOLUTIONS money-5, B111: payment, refund and dispute rows keep the original currency; the ledger and the wire are in USD, at
 * the rate locked in the checkout session (units of the currency per 1 USD, so USD is the amount divided by it).
 *
 * @param amount the amount in the payment currency
 * @param fxRate the session's locked rate (units per USD); `1` for USD
 * @returns the USD amount, rounded half up to 4 decimals
 */
export function toUsd(amount: Money, fxRate: string): Money {
  return asMoney(new D(amount.toWire()).div(new D(fxRate)));
}

/**
 * Converts a USD amount to the payment currency, rounded to the currency's own decimals.
 *
 * Why: the gateway is asked for the amount in the buyer's currency, in the currency's smallest unit, so a USD figure staff typed is
 * rounded to cents (or the currency's digits) once, here.
 *
 * @param usd the USD amount
 * @param fxRate the session's locked rate
 * @param decimals the currency's fraction digits (0 to 4)
 * @returns the amount in the currency, written with four decimals
 */
export function fromUsd(usd: Money, fxRate: string, decimals: number): Money {
  return asMoney(new D(usd.toWire()).times(new D(fxRate)), decimals);
}

/**
 * Writes an amount the way a customer email shows it: the currency's own number of decimals, then the code (`3.84 GBP`, `1200 JPY`).
 *
 * Why: payment and refund amounts are stored with four decimals but were rounded to the currency's digits when they were made, so keeping
 * only those digits loses nothing; the email must not print `3.8400`.
 *
 * @param amount a stored amount (four decimals)
 * @param currency the ISO code
 * @param decimals the currency's fraction digits (0 to 4)
 * @returns the text for the email
 */
export function amountText(amount: string, currency: string, decimals: number): string {
  const [whole = '0', fraction = ''] = amount.split('.');
  const kept = fraction.padEnd(4, '0').slice(0, Math.max(0, Math.min(decimals, 4)));
  return `${kept === '' ? whole : `${whole}.${kept}`} ${currency}`;
}

/** The parts of a refund: what leaves revenue (or customer funds), what leaves VAT payable, and their sum. */
export interface RefundSplit {
  readonly net: Money;
  readonly vat: Money;
  readonly total: Money;
}

/**
 * Splits a refund into its net and VAT parts.
 *
 * Why: RESOLUTIONS money-4 and ANSWERS refunds Q3 (M118): "VAT share = round(tax x amount / paid, 2), net = amount - VAT share"; a
 * refund of everything paid returns exactly the VAT that was paid.
 *
 * @param gross what the customer paid including VAT (USD)
 * @param tax the VAT inside it (USD)
 * @param amount what goes back (USD, at most `gross`)
 * @returns net, VAT and total (the total is `amount`)
 */
export function refundSplit(gross: Money, tax: Money, amount: Money): RefundSplit {
  if (gross.isZero() || tax.isZero()) return { net: amount, vat: Money.zero(), total: amount };
  if (amount.cmp(gross) >= 0) return { net: gross.sub(tax), vat: tax, total: gross };
  const vat = asMoney(new D(tax.toWire()).times(new D(amount.toWire())).div(new D(gross.toWire())), 2);
  return { net: amount.sub(vat), vat, total: amount };
}

/**
 * The gateway fee of a payment, in USD.
 *
 * Why: the map's money event `b2c_fee` ("an expense on every payment"); the fee is the gateway's percent of the gross plus its fixed
 * amount, the same formula as a top-up's fee (B167).
 *
 * @param grossUsd what the gateway collected (USD)
 * @param feePercent the gateway's percent
 * @param feeFixed the gateway's fixed fee (USD)
 * @returns the fee
 */
export function gatewayFeeUsd(grossUsd: Money, feePercent: string, feeFixed: string): Money {
  return grossUsd.pct(feePercent).add(Money.of(feeFixed));
}

/**
 * The status an order payment has after its completed refunds.
 *
 * Why: RESOLUTIONS money-5: refund completion sets `partial_refund` or `refunded` (completed refunds summed against the amount); a
 * payment with none is `captured`.
 *
 * @param paid what was paid, in the payment currency
 * @param refunded the sum of the completed refunds, in the same currency
 * @returns `captured`, `partial_refund` or `refunded`
 */
export function statusAfterRefunds(
  paid: Money,
  refunded: Money,
): Extract<OrderPaymentStatus, 'captured' | 'partial_refund' | 'refunded'> {
  if (!refunded.isPositive()) return 'captured';
  return refunded.cmp(paid) >= 0 ? 'refunded' : 'partial_refund';
}

/**
 * The order payment methods a gateway reports: every `ORDER_METHODS` value but the store balance.
 *
 * Why: plan 21 § 5.6.7: a gateway driver never reports `balance`, so `/pay` and a capture keep these three words; the wires that show a
 * stored payment use `ORDER_METHODS` ({@link storedOrderMethod}).
 */
export const GATEWAY_ORDER_METHODS = ['card', 'wallet', 'crypto'] as const satisfies readonly OrderMethod[];

/** One value of {@link GATEWAY_ORDER_METHODS}. */
export type GatewayOrderMethod = (typeof GATEWAY_ORDER_METHODS)[number];

/**
 * The B2C method word of a stored or reported method.
 *
 * Why: RESOLUTIONS b2c-6: `card`, `wallet` and `crypto` as they are, `usdt` is crypto, anything else is a card.
 *
 * @param method the stored `method_type` or a driver's word
 * @returns `card`, `wallet` or `crypto`
 */
export function b2cPaymentMethod(method: string): GatewayOrderMethod {
  if (method === 'card' || method === 'wallet' || method === 'crypto') return method;
  return method === 'usdt' ? 'crypto' : 'card';
}

/**
 * The B2C method word of a stored order payment, the store balance included.
 *
 * Why: plan 21 § 5.6.7: a payment from the customer's store balance keeps `balance` on every wire that shows a stored payment (refunds,
 * the payments report, the risk queue); a gateway's word goes through {@link b2cPaymentMethod}.
 *
 * @param method the stored `method_type`
 * @returns `balance` for a balance payment, else `card`, `wallet` or `crypto`
 */
export function storedOrderMethod(method: string): OrderMethod {
  return method === 'balance' ? 'balance' : b2cPaymentMethod(method);
}

/**
 * The card brand line a payment shows.
 *
 * Why: RESOLUTIONS money-4: card is `<Brand> •••• <last4>`, crypto `<COIN> <network>`, a wallet its name; a driver that cannot tell
 * sends nothing and the line is empty.
 *
 * @param method the payment's B2C method
 * @param details what the driver read from the event
 * @returns the display text, or `''`
 */
export function brandLine(
  method: OrderMethod,
  details: {
    brand?: string | undefined;
    last4?: string | undefined;
    coin?: string | undefined;
    network?: string | undefined;
  },
): string {
  const title = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);
  if (method === 'card' && details.brand) {
    return details.last4 ? `${title(details.brand)} •••• ${details.last4}` : title(details.brand);
  }
  if (method === 'crypto' && details.coin) {
    return details.network ? `${details.coin.toUpperCase()} ${details.network}` : details.coin.toUpperCase();
  }
  if (method === 'wallet' && details.brand) return details.brand.split(/[_ ]+/).map(title).join(' ');
  return '';
}

/**
 * What a confirmation tells about how an order was paid: the method and the brand line.
 *
 * Why: a payment opens as the method of its gateway's driver (`card`, or `crypto` for a coin); the confirmation says more: a card payment
 * made with Apple Pay or Google Pay is a `wallet` payment (RESOLUTIONS b2c-6), and its brand line comes from the event (money-4).
 *
 * @param stored the payment's method as stored when it opened
 * @param details what the driver read from the event
 * @returns the method and the brand line (`''` when the driver could not tell)
 */
export function paymentFacts(
  stored: string,
  details:
    | {
        brand?: string | undefined;
        last4?: string | undefined;
        coin?: string | undefined;
        network?: string | undefined;
        wallet?: string | undefined;
      }
    | undefined,
): { method: GatewayOrderMethod; brand: string } {
  const method: GatewayOrderMethod = details?.wallet ? 'wallet' : b2cPaymentMethod(stored);
  return { method, brand: brandLine(method, details ?? {}) };
}

/**
 * Tells whether a confirmation says another amount or currency than the payment that was opened.
 *
 * Why: the gateway collected what it says it collected; a storefront payment whose confirmed amount or currency differs from the quote
 * must not create an order at the locked price (the buyer paid something else). It is held for staff, like a top-up (B167). Decision
 * 048: a confirmation that does not say its currency or its amount does not match either (what was paid cannot be vouched for); the
 * currency is judged first.
 *
 * @param event what the gateway says was paid (4-decimal text and ISO code, `null` when the event does not say)
 * @param payment what the payment was opened for
 * @returns the sentence for staff, or `undefined` only when the gateway states the payment's currency and amount
 */
export function storefrontMismatch(
  event: { readonly amount: string | null; readonly currency: string | null },
  payment: { readonly amount: string; readonly currency: string },
): string | undefined {
  if (event.currency === null) {
    return `The gateway's confirmation does not say the currency; the payment was opened in ${payment.currency}.`;
  }
  if (event.currency !== payment.currency) {
    return `The gateway confirmed ${event.currency} but the payment was opened in ${payment.currency}.`;
  }
  if (event.amount === null) {
    return `The gateway's confirmation does not say the amount; the payment was opened for ${payment.amount}.`;
  }
  if (Money.of(event.amount).cmp(Money.of(payment.amount)) !== 0) {
    return `The gateway confirmed ${event.amount} but the payment was opened for ${payment.amount}.`;
  }
  return undefined;
}

const MINUTE_MS = 60_000;

/**
 * How long after the checkout's price lock ends a payment is still used at the locked price (minutes).
 *
 * Why: decision 048: the hosted page closes this long after the lock, and a payment made later is not used at the old price.
 */
export const CONFIRMATION_GRACE_MINUTES = 30;

/**
 * The shortest life of a hosted card page: the gateway's minimum (30 minutes after it was created) plus one minute for the call.
 *
 * Why: decision 048: a page opened in the last minutes of the price lock still gets a life the gateway accepts.
 */
export const HOSTED_PAGE_MIN_LIFETIME_MS = 31 * MINUTE_MS;

/**
 * The most payment pages a checkout keeps open at once (pending, not held).
 *
 * Why: decision 048: each page is a gateway call and a possible payment; three cover a buyer who changes the method twice.
 */
export const MAX_LIVE_PAYMENTS_PER_CHECKOUT = 3;

/**
 * From this age of a confirmation (its own event time, else when the payment opened), a gateway record that still cannot be read
 * holds the payment for staff instead of asking the gateway to deliver the event again (hours).
 *
 * Why: decision 048: the gateway retries a delivery for a few days; a long outage must not lose the confirmation when it stops.
 */
export const GATEWAY_CHECK_GIVE_UP_HOURS = 24;

/**
 * When the hosted card page of a payment must close.
 *
 * Why: decision 048: the page closes {@link CONFIRMATION_GRACE_MINUTES} after the checkout's price lock ends, and never sooner than
 * {@link HOSTED_PAGE_MIN_LIFETIME_MS} after it is opened (the gateway refuses a shorter life).
 *
 * @param lockEndsAt when the checkout's price lock ends (`checkout_sessions.expires_at`)
 * @param now the clock's time when the page is opened
 * @returns the later of the two times
 */
export function hostedPageExpiry(lockEndsAt: Date, now: Date): Date {
  return new Date(
    Math.max(
      lockEndsAt.getTime() + CONFIRMATION_GRACE_MINUTES * MINUTE_MS,
      now.getTime() + HOSTED_PAGE_MIN_LIFETIME_MS,
    ),
  );
}

/**
 * How late a payment was made after the checkout's price lock ended, beyond the grace.
 *
 * Why: decision 048: lateness is judged on when the buyer paid (the gateway's own time), never on when the confirmation was processed, so
 * a delivery the gateway repeats never makes an on-time payment late. Exactly {@link CONFIRMATION_GRACE_MINUTES} after the lock is in time.
 *
 * @param lockEndsAt when the checkout's price lock ended
 * @param paidAt when the buyer paid
 * @returns the whole minutes after the lock end when the payment is late, else `undefined`
 */
export function minutesLate(lockEndsAt: Date, paidAt: Date): number | undefined {
  const after = paidAt.getTime() - lockEndsAt.getTime();
  if (after <= CONFIRMATION_GRACE_MINUTES * MINUTE_MS) return undefined;
  return Math.floor(after / MINUTE_MS);
}

/**
 * The risk signal of a payment made after the checkout's price lock ended.
 *
 * Why: decision 048: a late payment is booked on an order placed held; this sentence is its review reason and its hold sentence.
 *
 * @param minutes the minutes after the lock end ({@link minutesLate})
 * @returns the sentence
 */
export function lateConfirmationSignal(minutes: number): string {
  return `Paid ${minutes} minutes after the checkout's price lock ended`;
}

/** The refund reason of a late payment that is sent back at once (decision 048). */
export const LATE_REFUND_REASON = "Paid after the checkout's price lock ended: refunded automatically";

/** The key of `payments.raw` under which a held storefront payment records whether its money arrived (decision 048). */
export const HOLD_MARK_KEY = 'gsmHold';

/**
 * The stored event of a held storefront payment, with the mark of whether the gateway's record showed its money received.
 *
 * Why: decision 048: a held payment whose money arrived may only be closed as paid back, never as "no money received" (that would take it
 * off the money integrity check while the money is still there). The mark is kept with the event the hold stores (no column of its own).
 *
 * @param raw the event as received
 * @param moneyReceived true when the record (or, when the driver cannot check, the confirmation) showed money received for this payment
 * @returns the event with the mark under {@link HOLD_MARK_KEY}
 */
export function withHoldMark(raw: JsonObject, moneyReceived: boolean): JsonObject {
  return { ...raw, [HOLD_MARK_KEY]: { moneyReceived } };
}

/**
 * Reads the mark {@link withHoldMark} stored.
 *
 * @param raw the payment's stored event
 * @returns the mark, or `undefined` for a payment held before the mark existed (or never held)
 */
export function holdMarkOf(raw: Readonly<Record<string, unknown>>): boolean | undefined {
  const mark = raw[HOLD_MARK_KEY];
  if (typeof mark !== 'object' || mark === null || Array.isArray(mark)) return undefined;
  const received = (mark as Record<string, unknown>)['moneyReceived'];
  return typeof received === 'boolean' ? received : undefined;
}

/**
 * The number of significant decimals of an amount.
 *
 * Why: decision 048: a card method charges in fixed steps (0.01 or whole units); an amount with more significant decimals than the step
 * cannot be charged exactly and is refused before a page opens.
 *
 * @param amount the amount
 * @returns the decimals of its 4-decimal wire form without trailing zeros (`3.3960` is 3, `3.4000` is 1, `576.0000` is 0)
 */
export function fractionDigits(amount: Money): number {
  const fraction = amount.toWire().split('.')[1] ?? '';
  return fraction.replace(/0+$/, '').length;
}

/**
 * The USD amount a row in the payment's currency stands for, for the wire.
 *
 * Why: an amount that is the whole payment is exactly what the checkout locked in USD; only a part is converted, so a full refund or a
 * dispute of the whole payment shows `4.7900`, not `4.7889` from converting the rounded GBP back.
 *
 * @param amount the amount in the payment currency
 * @param payment the payment's own amount and the USD gross the session locked, when known
 * @param fxRate the locked rate
 * @returns the USD amount
 */
export function wireUsd(
  amount: Money,
  payment: { readonly amount: string; readonly grossUsd: string } | undefined,
  fxRate: string,
): Money {
  if (payment && amount.cmp(Money.of(payment.amount)) === 0) return Money.of(payment.grossUsd);
  return toUsd(amount, fxRate);
}

/**
 * The fingerprint of a `/pay` request: what makes two calls with one `Idempotency-Key` "the same request".
 *
 * Why: ALIGNMENT § 7: the same key and the same request answer the same payment again, another request under the key is refused. The
 * request is the method the buyer chose and where the gateway sends them back; the checkout and the key are already the payment's own.
 *
 * @param gatewayCode the `code` of the chosen payment method
 * @param returnUrl the return address of the request
 * @returns a text that is equal exactly for equal requests
 */
export function payRequestFingerprint(gatewayCode: string, returnUrl: string): string {
  return JSON.stringify([gatewayCode, returnUrl]);
}

/**
 * Tells whether an order came through the shop door.
 *
 * Why: decision 064: the door is `orders.source`, never a null buyer column; a `store` order was paid first through the shop checkout and
 * is the only kind that gets the storefront customer mails and a tax receipt. This is the rule of the orders module's `isPrepaidOrder`: money
 * cannot import a value from orders (decision 032, orders import money), so the one word is written here too and a unit test pins it.
 *
 * @param order the order, or anything with its source
 * @returns true for the `store` door
 */
export function isShopOrder(order: { readonly source: string }): boolean {
  return order.source === 'store';
}
