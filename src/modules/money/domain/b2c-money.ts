// The arithmetic of storefront payments, refunds and disputes (feature 16): base-currency conversion at the locked rate, the VAT
// share of a refund, the gateway fee, the payment status after refunds, and the method words. Pure functions on exact decimals.
import { Decimal } from 'decimal.js';
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
 * The B2C method word of a stored or reported method.
 *
 * Why: RESOLUTIONS b2c-6: `card`, `wallet` and `crypto` as they are, `usdt` is crypto, anything else is a card.
 *
 * @param method the stored `method_type` or a driver's word
 * @returns `card`, `wallet` or `crypto`
 */
export function b2cPaymentMethod(method: string): OrderMethod {
  if (method === 'card' || method === 'wallet' || method === 'crypto') return method;
  return method === 'usdt' ? 'crypto' : 'card';
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
): { method: OrderMethod; brand: string } {
  const method: OrderMethod = details?.wallet ? 'wallet' : b2cPaymentMethod(stored);
  return { method, brand: brandLine(method, details ?? {}) };
}

/**
 * Tells whether a confirmation says another amount or currency than the payment that was opened.
 *
 * Why: the gateway collected what it says it collected; a storefront payment whose confirmed amount or currency differs from the quote
 * must not create an order at the locked price (the buyer paid something else). It is held for staff, like a top-up (B167).
 *
 * @param event what the gateway says was paid (4-decimal text and ISO code, `null` when the event does not say)
 * @param payment what the payment was opened for
 * @returns the sentence for staff, or `undefined` when they agree
 */
export function storefrontMismatch(
  event: { readonly amount: string | null; readonly currency: string | null },
  payment: { readonly amount: string; readonly currency: string },
): string | undefined {
  if (event.currency !== null && event.currency !== payment.currency) {
    return `The gateway confirmed ${event.currency} but the payment was opened in ${payment.currency}.`;
  }
  if (event.amount !== null && Money.of(event.amount).cmp(Money.of(payment.amount)) !== 0) {
    return `The gateway confirmed ${event.amount} but the payment was opened for ${payment.amount}.`;
  }
  return undefined;
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
