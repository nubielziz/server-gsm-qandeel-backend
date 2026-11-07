// Rules of the top-up payments (map routes /admin/payments*, the payment webhook and the automatic credit job, stage 8): when an
// automatic gateway's payment credits itself, who may review it, and what the job decides after it asks the gateway. Pure.
import { Money } from '../../../common/money';
import { paymentRef } from './invoice-rules';

/** Setting key of the minutes an automatic gateway's confirmed top-up waits before it credits itself (user rule 6, default 10). */
export const AUTO_CREDIT_DELAY_KEY = 'payments.auto_credit_delay_minutes';
/** The wait when the setting is missing. */
export const DEFAULT_AUTO_CREDIT_DELAY_MINUTES = 10;
/** The accepted range of {@link AUTO_CREDIT_DELAY_KEY}: one minute to one day. */
export const AUTO_CREDIT_DELAY_BOUNDS = { min: 1, max: 1440 } as const;
/** How long the job waits before it asks the gateway again about a payment that is still unconfirmed. */
export const RECHECK_MINUTES = 5;
/** How long a payment may stay unconfirmed at the gateway before it goes to staff review. */
export const MAX_UNCONFIRMED_HOURS = 24;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/**
 * When a confirmed top-up of an automatic gateway credits itself.
 *
 * Why: user rule 6 and RESOLUTIONS money-3: the delay setting (10 minutes) after the confirmation; the gateway's `hold_hours` only
 * lengthens it.
 *
 * @param capturedAt the confirmation time
 * @param delayMinutes the setting `payments.auto_credit_delay_minutes`
 * @param holdHours the gateway's `hold_hours`
 * @returns the time of the credit
 */
export function autoCreditAtOf(capturedAt: Date, delayMinutes: number, holdHours: number): Date {
  return new Date(capturedAt.getTime() + Math.max(delayMinutes * MINUTE_MS, holdHours * HOUR_MS));
}

/**
 * The note a waiting automatic top-up shows the reviewer.
 *
 * @param autoCreditAt the time it credits itself
 * @returns the console's text
 */
export function waitingNote(autoCreditAt: Date): string {
  return `Credited automatically after the gateway check at ${autoCreditAt.toISOString()}`;
}

/** Why a staff decision on a payment was refused. */
export interface ReviewRefusal {
  readonly code: 'PAYMENT_ALREADY_REVIEWED' | 'PAYMENT_AUTO_CREDIT_PENDING';
  readonly detail: string;
}

/**
 * Whether staff may approve or reject a payment now.
 *
 * Why: RESOLUTIONS money-2 and money-3: only a pending payment can be reviewed, and a payment of an automatic gateway only once the
 * job (or risk) sent it to staff (`review_required`); otherwise the job credits it by itself.
 *
 * @param payment its id, status and review flag
 * @param gateway whether the gateway is manual
 * @returns the refusal, or `undefined` when staff may decide
 */
export function reviewRefusal(
  payment: { readonly id: number; readonly status: string; readonly reviewRequired: boolean },
  gateway: { readonly isManual: boolean },
): ReviewRefusal | undefined {
  if (payment.status !== 'pending') {
    return { code: 'PAYMENT_ALREADY_REVIEWED', detail: `${paymentRef(payment.id)} was already ${payment.status}.` };
  }
  if (!gateway.isManual && !payment.reviewRequired) {
    return {
      code: 'PAYMENT_AUTO_CREDIT_PENDING',
      detail: `${paymentRef(payment.id)} is credited automatically after the gateway check.`,
    };
  }
  return undefined;
}

/** What the gateway's API says about a payment. */
export type GatewayStatus = 'confirmed' | 'pending' | 'failed';

/** What the job does with a due payment. */
export type AutoCreditDecision =
  | { readonly action: 'credit' }
  | { readonly action: 'recheck'; readonly at: Date }
  | { readonly action: 'review'; readonly reason: string };

/**
 * Decides what the job does with a payment that is due, after it asked the gateway.
 *
 * Why: user rule 6: credit only while the gateway still says confirmed (a crypto gateway says so only after its required
 * confirmations); a payment the gateway no longer confirms goes to staff; a payment that is still unconfirmed is asked about
 * again later, and goes to staff after a day.
 *
 * @param input the gateway's answer, the confirmation time and now
 * @returns credit, ask again at a time, or send to staff with a reason
 */
export function decideAutoCredit(input: {
  readonly gateway: GatewayStatus;
  readonly capturedAt: Date;
  readonly now: Date;
}): AutoCreditDecision {
  if (input.gateway === 'confirmed') return { action: 'credit' };
  if (input.gateway === 'failed') {
    return { action: 'review', reason: 'The gateway no longer reports this payment as confirmed.' };
  }
  if (input.now.getTime() - input.capturedAt.getTime() >= MAX_UNCONFIRMED_HOURS * HOUR_MS) {
    return {
      action: 'review',
      reason: `The gateway has not confirmed this payment after ${MAX_UNCONFIRMED_HOURS} hours.`,
    };
  }
  return { action: 'recheck', at: new Date(input.now.getTime() + RECHECK_MINUTES * MINUTE_MS) };
}

/**
 * Whether what a gateway says was paid is not what the invoice asked for.
 *
 * Why: a payment is credited at its invoice's amount, so a confirmation of another amount or another currency must never credit
 * (money that never arrived). The webhook sends such a payment to staff review with this text, and crediting refuses it again from
 * the stored gateway event, so neither staff approval nor the automatic job can credit it; staff reject it and adjust the wallet.
 *
 * @param reported what the gateway says (`null` when its event does not say)
 * @param invoice what the invoice asked for
 * @returns the reason the payment does not match, or `undefined` when it does (or the gateway does not say)
 */
export function confirmationMismatch(
  reported: { readonly amount: string | null; readonly currency: string | null },
  invoice: { readonly amount: string; readonly currency: string },
): string | undefined {
  if (reported.currency !== null && reported.currency.toUpperCase() !== invoice.currency.toUpperCase()) {
    return `The gateway reports a payment in ${reported.currency}; the invoice is in ${invoice.currency}.`;
  }
  if (reported.amount !== null && !Money.of(reported.amount).eq(Money.of(invoice.amount))) {
    return `The gateway reports ${Money.of(reported.amount).toWire()} paid; the invoice is ${invoice.amount}.`;
  }
  return undefined;
}
