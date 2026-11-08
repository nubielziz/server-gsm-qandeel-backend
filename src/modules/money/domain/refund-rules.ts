// The pure rules of storefront refunds (feature 16): how much can still go back, how the money goes back (the gateway or by hand),
// what a refund of a delivered or an undelivered order posts, and the fixed texts. No database.
import { Money } from '../../../common/money';
import type { OrderMethod, RefundMethod } from '../db/schema';

/** The note a crypto refund carries: the gateway cannot reverse a coin payment, so staff pay it out (ANSWERS refunds Q4). */
export const CRYPTO_REFUND_NOTE =
  'Crypto payments cannot be refunded by the gateway. Paid out manually from the treasury wallet.';

/** The note of a refund the gateway cannot send (no refund support): staff pay it out by hand. */
export const MANUAL_REFUND_NOTE = 'This payment method cannot be refunded by the gateway. Paid out manually.';

/** The reason of the refund the system opens when it rejects a paid order before delivery. */
export const AUTO_REFUND_REASON = 'The order could not be delivered';

/**
 * What is left to refund on a payment.
 *
 * Why: RESOLUTIONS money-11 and ANSWERS refunds Q3: the upper limit is the paid amount minus the other refunds on the same payment
 * that are completed or on their way out (`processing`): an approved refund is money already promised, so counting only the completed
 * ones would let two approvals refund the same money twice.
 *
 * @param paid what the customer paid, in the payment currency
 * @param taken the sum of the other refunds of the payment that are `processing` or `completed`, in the same currency
 * @returns what can still go back (never negative)
 */
export function refundableLeft(paid: Money, taken: Money): Money {
  const left = paid.sub(taken);
  return left.isPositive() ? left : Money.zero();
}

/**
 * How a refund is paid out.
 *
 * Why: ANSWERS refunds Q4 and money-12: a card or wallet payment goes back through the gateway (`original`); a crypto payment, or a
 * gateway whose driver cannot refund, is paid out by hand (`manual`) and completes at once.
 *
 * @param method the payment's B2C method
 * @param gateway what the payment's gateway can do
 * @returns the refund method word and the note a manual refund carries (`''` for the gateway)
 */
export function refundRoute(
  method: OrderMethod,
  gateway: { readonly supportsRefunds: boolean; readonly driverRefunds: boolean },
): { method: RefundMethod; note: string } {
  if (method === 'crypto') return { method: 'manual', note: CRYPTO_REFUND_NOTE };
  if (!gateway.supportsRefunds || !gateway.driverRefunds) return { method: 'manual', note: MANUAL_REFUND_NOTE };
  return { method: 'original', note: '' };
}

/** The sentence of an approval when the payment has nothing left to refund (everything is already promised or paid back). */
export const NOTHING_LEFT_MESSAGE = 'Nothing is left to refund on this payment.';

/** What an approval is asked and what it needs the order for. */
export interface ApprovalInput {
  /** The amount staff typed (USD), or `undefined` for the amount on the request. */
  readonly requested: Money | undefined;
  /** The amount on the refund row, in USD. */
  readonly onRequestUsd: Money;
  /** What can still go back, in USD. */
  readonly leftUsd: Money;
  /** True when the order was delivered (status `completed`). */
  readonly delivered: boolean;
}

/** The outcome of {@link checkApproval}. */
export type ApprovalCheck =
  | { readonly ok: true; readonly amountUsd: Money }
  | { readonly ok: false; readonly field: 'amount'; readonly message: string };

/**
 * Checks the amount of an approval.
 *
 * Why: ANSWERS refunds Q3: a missing amount is the amount on the request; it must be above zero and at most what can still go back
 * (`Enter an amount between $0.01 and $X.`), and when nothing is left at all the answer is `Nothing is left to refund on this payment.`. A refund of an order that is not delivered cancels the order and returns the whole
 * payment (scenario b2c-refund step 4: the order is rejected, so what the customer paid goes back in full), so it must be the whole
 * of what is left.
 *
 * @param input what staff asked and what the order and the payment allow
 * @returns the amount to refund in USD, or the refusal for the `amount` field
 */
export function checkApproval(input: ApprovalInput): ApprovalCheck {
  const amount = input.requested ?? input.onRequestUsd;
  const left = input.leftUsd;
  // Nothing (not even a cent) can go back: say so instead of an amount range that starts above where it ends.
  if (left.cmp(Money.of('0.01')) < 0) {
    return { ok: false, field: 'amount', message: NOTHING_LEFT_MESSAGE };
  }
  if (!amount.isPositive() || amount.cmp(left) > 0 || amount.cmp(Money.of('0.01')) < 0) {
    return { ok: false, field: 'amount', message: `Enter an amount between $0.01 and $${wholeCents(left)}.` };
  }
  if (!input.delivered && amount.cmp(left) < 0) {
    return {
      ok: false,
      field: 'amount',
      message: `This order was not delivered, so it is cancelled and refunded in full: $${wholeCents(left)}.`,
    };
  }
  return { ok: true, amountUsd: amount };
}

/**
 * An amount as the dialogs print it: two decimals, four when the last two are not zero.
 *
 * @param amount the amount
 * @returns the text without a currency sign
 */
export function wholeCents(amount: Money): string {
  const [whole = '0', fraction = '0000'] = amount.toWire().split('.');
  return `${whole}.${fraction.slice(2) === '00' ? fraction.slice(0, 2) : fraction}`;
}

/**
 * The idempotency key of a gateway refund call.
 *
 * Why: the key makes a repeated call (a queue retry, a staff retry after an unknown outcome) refund once. After the gateway refused a refund for good it
 * would only replay that refusal for the same key, so the next send moves to `refund-<id>-<n>` (`n` is `refunds.send_attempt`); the first
 * attempt keeps the plain `refund-<id>`.
 *
 * @param refundId the refund
 * @param sendAttempt `refunds.send_attempt` (1 for the first send)
 * @returns the key
 */
export function refundSendKey(refundId: number, sendAttempt: number): string {
  return sendAttempt <= 1 ? `refund-${refundId}` : `refund-${refundId}-${sendAttempt}`;
}

/** The shortest decline reason the console accepts: "at least a sentence" (the mock's minimum). */
export const MIN_DECLINE_REASON_LENGTH = 10;

/** The longest decline reason kept. */
export const MAX_DECLINE_REASON_LENGTH = 500;
