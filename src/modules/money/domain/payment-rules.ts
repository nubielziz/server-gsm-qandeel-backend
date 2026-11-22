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
 * Decision 048: an event that does not say what was paid (no currency, or no amount it states exactly) is a mismatch too: the amount
 * cannot be vouched for. The currency is judged first.
 *
 * @param reported what the gateway says (`null` when its event does not say)
 * @param invoice what the invoice asked for
 * @returns the reason the payment does not match, or `undefined` only when the gateway states the invoice's currency and amount
 */
export function confirmationMismatch(
  reported: { readonly amount: string | null; readonly currency: string | null },
  invoice: { readonly amount: string; readonly currency: string },
): string | undefined {
  if (reported.currency === null) {
    return `The gateway does not say in which currency this payment was made; the invoice is in ${invoice.currency}.`;
  }
  if (reported.currency.toUpperCase() !== invoice.currency.toUpperCase()) {
    return `The gateway reports a payment in ${reported.currency}; the invoice is in ${invoice.currency}.`;
  }
  if (reported.amount === null) {
    return `The gateway does not say how much was paid; the invoice is ${invoice.amount}.`;
  }
  if (!Money.of(reported.amount).eq(Money.of(invoice.amount))) {
    return `The gateway reports ${Money.of(reported.amount).toWire()} paid; the invoice is ${invoice.amount}.`;
  }
  return undefined;
}

/**
 * The review note of a confirmation for a top-up invoice that is no longer open.
 *
 * Why: decision 048: a confirmation for an invoice that is `paid` or `void` is money the gateway holds for the customer or merchant,
 * so it is recorded for staff review instead of being dropped; crediting refuses an invoice that is not open, so it is never credited.
 *
 * @param invoiceNumber the invoice's number (`INV-2026-0001`)
 * @param status the invoice's status (`paid` or `void`)
 * @returns the sentence for `payments.review_note`
 */
export function closedInvoiceNote(invoiceNumber: string, status: string): string {
  return `The gateway confirmed this payment for ${invoiceNumber}, which is ${status}: it is never credited. Refund it at the gateway or adjust the wallet by hand, then reject it (the reason you give is sent to the customer).`;
}

/** What a gateway's record can show happened to a payment after it was made (decision 048). */
export const PAYMENT_AFTERMATHS = ['refunded', 'partially_refunded', 'disputed'] as const;

/** One value of {@link PAYMENT_AFTERMATHS}. */
export type PaymentAftermath = (typeof PAYMENT_AFTERMATHS)[number];

/**
 * The note of a payment whose gateway record shows that its money went back, in full or in part, or is disputed.
 *
 * Why: decision 048: such a payment is not money to use as quoted. A storefront capture holds it (nothing is sent back: the money already
 * went back or is contested) and the automatic credit sends a top-up to staff review with this note.
 *
 * @param aftermath what the record shows
 * @returns the sentence for `payments.review_note`
 */
export function aftermathNote(aftermath: PaymentAftermath): string {
  if (aftermath === 'refunded')
    return "The gateway's record shows this payment was refunded in full after it was made.";
  if (aftermath === 'partially_refunded') {
    return "The gateway's record shows part of this payment was refunded after it was made.";
  }
  return "The gateway's record shows this payment is disputed.";
}

/**
 * What differs between the gateway's record of a top-up payment and its invoice.
 *
 * Why: decision 048: before a top-up is credited automatically the gateway's own record must belong to this invoice (when it states the
 * reference its checkout was opened with: a page opened before the record carried one states none and passes), show nothing refunded or
 * disputed since, and show the invoice's amount and currency as received (an amount or currency the record does not state is a
 * difference). Every difference is named, so staff see what to check.
 *
 * @param record what the gateway's record says (a record that says paid)
 * @param invoice the invoice's number, amount and currency
 * @returns the note for staff review, or `undefined` when the record matches the invoice
 */
export function topUpRecordProblem(
  record: {
    readonly amount: string | null;
    readonly currency: string | null;
    readonly belongsTo: string | null;
    readonly afterPayment?: PaymentAftermath | undefined;
  },
  invoice: { readonly number: string; readonly amount: string; readonly currency: string },
): string | undefined {
  const mismatch = confirmationMismatch(record, invoice);
  const problems = [
    record.belongsTo !== null && record.belongsTo !== invoice.number
      ? `The gateway's record of this payment names ${record.belongsTo}, not ${invoice.number}.`
      : undefined,
    record.afterPayment === undefined ? undefined : aftermathNote(record.afterPayment),
    mismatch === undefined ? undefined : `The gateway's record does not match the invoice. ${mismatch}`,
  ].filter((problem): problem is string => problem !== undefined);
  return problems.length === 0 ? undefined : problems.join(' ');
}

/** One decimal digit of any script (Unicode encodes each script's digits as a run of ten, zero first). */
const DECIMAL_DIGIT = /\p{Nd}/u;

/** The ASCII digit of a decimal digit of any script: its distance from the zero of its run of ten. */
function asciiDigit(digit: string): string {
  const code = digit.codePointAt(0)!;
  let first = code;
  while (DECIMAL_DIGIT.test(String.fromCodePoint(first - 1))) first -= 1;
  return String((code - first) % 10);
}

/**
 * The one form a bank reference of a manual method is compared and stored in: compatibility forms folded (NFKC, so full-width letters
 * and digits are the plain ones), digits of any script read as their ASCII digits, upper case, without white space, dashes (the minus
 * sign included) and invisible (control, format and default-ignorable) characters, the blank braille pattern included.
 *
 * Why: a bank reference names one transfer however it was typed (`ft-2611 0177 88`, `FT2611017788`, the same text with an
 * invisible character, in full-width letters or with Arabic-Indic digits are the same transfer and read the same to staff), so both
 * receipt routes judge and keep it in this form, and a pending or approved payment of the gateway holds it (`findLiveBankReference`).
 * A reference that still holds a character other than a printable ASCII one in this form is refused (`bankReferenceProblem`).
 *
 * @param reference the reference as typed
 * @returns the reference in its stored form; empty when only white space, dashes and invisible characters were typed
 */
export function normalizeBankReference(reference: string): string {
  return reference
    .normalize('NFKC')
    .replace(/[\s\p{Pd}\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u2212\u2800]+/gu, '')
    .replace(/\p{Nd}/gu, asciiDigit)
    .toUpperCase();
}

/**
 * Why a bank reference in its stored form cannot be taken: it holds a character other than a printable ASCII one (U+0021 to U+007E).
 *
 * Why: banks print a transfer reference in Latin letters, digits and plain punctuation, and one transfer has one stored reference, so
 * a stored reference holds only characters a person can see and tell apart in plain ASCII: a letter of another script, an accented
 * letter, a combining mark, a private-use or unassigned code point and a symbol outside ASCII are refused. An empty reference
 * (nothing was typed) stays allowed.
 *
 * @param reference the reference in its stored form (`normalizeBankReference`)
 * @returns the sentence for the payer (`422` on `reference`, `invalid`), or `undefined` when the reference may be taken
 */
export function bankReferenceProblem(reference: string): string | undefined {
  return /[^\u0021-\u007e]/u.test(reference)
    ? 'Type the reference as the bank printed it, in Latin letters and digits.'
    : undefined;
}
