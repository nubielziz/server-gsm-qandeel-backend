// Rules of the merchant invoices (map routes /admin/invoices, /client/invoices, stage 8): the number, the due date, the tax and
// the totals of a manual and of a top-up invoice, the checks on what staff and merchants type, and the limits of decision 049
// (open top-ups, receipts in review, the issuer's own approval). Pure.
import type { FieldError } from '../../../common/errors';
import { Money } from '../../../common/money';
import type { InvoiceKind } from '../db/schema';

/** Setting key of the B2B VAT rate in percent (user rule 3: the rate stays a setting, default 0). */
export const B2B_VAT_RATE_KEY = 'billing.b2b_vat_rate_percent';
/** Setting key of the days an invoice is due after it is issued (B41: 14). */
export const INVOICE_DUE_DAYS_KEY = 'billing.invoice_due_days';
/** The due date of an invoice when the setting is missing: 14 days after issue (B41, finance Q6). */
export const DEFAULT_INVOICE_DUE_DAYS = 14;
/** The accepted range of {@link INVOICE_DUE_DAYS_KEY}. */
export const INVOICE_DUE_DAYS_BOUNDS = { min: 1, max: 365 } as const;

const DAY_MS = 86_400_000;
const PERCENT = /^\d{1,3}(\.\d{1,4})?$/;

/** The longest description of a manual invoice. */
export const MAX_INVOICE_DESCRIPTION = 500;

/**
 * The invoice number: the year it was issued and its running number.
 *
 * Why: the console shows `INV-2026-0042` (finance/mocks/invoices.ts `invoiceNumber`): the number follows the invoice id, so it is
 * unique without a counter of its own.
 *
 * @param year the year of the issue date
 * @param id the invoice id
 * @returns for example `INV-2026-0042`
 */
export function invoiceNumber(year: number, id: number): string {
  return `INV-${year}-${String(id).padStart(4, '0')}`;
}

/**
 * The payment reference the console shows (`PAY-1000`).
 *
 * @param id the payment id
 * @returns the reference
 */
export function paymentRef(id: number): string {
  return `PAY-${id}`;
}

/**
 * When an invoice issued now falls due.
 *
 * @param now the issue time
 * @param days the days allowed
 * @returns the due time
 */
export function dueAtOf(now: Date, days: number): Date {
  return new Date(now.getTime() + days * DAY_MS);
}

/**
 * Reads the B2B VAT rate from the settings value.
 *
 * Why: a bad value saved by mistake must not tax merchants, so anything that is not a percent from 0 to 100 reads as `0`.
 *
 * @param value the stored setting (a number or a numeric text), or `undefined`
 * @returns the rate as a percent string with up to four decimals (`'0'` when absent or invalid)
 */
export function vatRateFrom(value: unknown): string {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  return PERCENT.test(text) && Number(text) <= 100 ? text : '0';
}

/** The money columns of an invoice. */
export interface InvoiceTotals {
  readonly amount: Money;
  readonly fee: Money;
  readonly net: Money;
  readonly tax: Money;
  readonly total: Money;
}

/**
 * The totals of a manual invoice issued by staff (user rule 3).
 *
 * Why: no fee; the net is the amount, the tax is the B2B VAT rate (0 for now) of the net and the total is net plus tax. Paying it
 * credits the wallet with the net amount.
 *
 * @param amount the amount staff typed
 * @param vatRate the B2B VAT rate in percent
 * @returns amount, fee 0, net, tax and total
 */
export function manualInvoiceTotals(amount: Money, vatRate: string): InvoiceTotals {
  const tax = amount.pct(vatRate);
  return { amount, fee: Money.zero(), net: amount, tax, total: amount.add(tax) };
}

/**
 * The totals of a top-up invoice a merchant asks for (B163).
 *
 * Why: the merchant pays `amount` (the total), the gateway fee comes out of it and the wallet receives the net. The VAT rate is
 * shown on the invoice (0 for now) and changes neither the payment nor the credit.
 *
 * @param amount what the merchant pays
 * @param fee the gateway fee on it
 * @param vatRate the B2B VAT rate in percent
 * @returns amount, fee, net, tax and total (= amount)
 */
export function topupInvoiceTotals(amount: Money, fee: Money, vatRate: string): InvoiceTotals {
  const net = amount.sub(fee);
  return { amount, fee, net, tax: net.pct(vatRate), total: amount };
}

/**
 * Reads an amount typed for an invoice or a deposit.
 *
 * @param text the amount as sent (up to four decimals)
 * @returns the amount, or the problem on `amount`
 */
export function parseAmount(text: string): { amount: Money } | { problem: FieldError } {
  const trimmed = text.trim();
  if (!/^\d{1,14}(\.\d{1,4})?$/.test(trimmed)) {
    return { problem: { field: 'amount', code: 'format', message: 'Enter an amount like 25 or 25.50.' } };
  }
  const amount = Money.of(trimmed);
  if (!amount.isPositive()) {
    return { problem: { field: 'amount', code: 'range', message: 'Enter an amount greater than zero.' } };
  }
  return { amount };
}

/**
 * Checks the description of a manual invoice.
 *
 * @param description the text as sent, already trimmed
 * @returns the problem on `description`, or `undefined`
 */
export function checkDescription(description: string): FieldError | undefined {
  if (description === '') return { field: 'description', code: 'required', message: 'Say what the invoice is for.' };
  if (description.length > MAX_INVOICE_DESCRIPTION) {
    return {
      field: 'description',
      code: 'length',
      message: `Keep the description to ${MAX_INVOICE_DESCRIPTION} characters or fewer.`,
    };
  }
  return undefined;
}

/** How many unpaid top-up invoices a merchant may hold, and how long an unpaid one counts (decision 049). */
export const MERCHANT_OPEN_TOPUPS = { max: 5, liveHours: 24 } as const;

/**
 * Tells whether a merchant may not open another top-up invoice.
 *
 * Why: decision 049: at most five unpaid top-up invoices that are less than 24 hours old or have a receipt in review. A merchant cannot
 * cancel a top-up, so an older unpaid invoice stops counting (it stays payable).
 *
 * @param liveOpen the merchant's live unpaid top-up invoices
 * @returns true when the next one is refused
 */
export function tooManyOpenTopUps(liveOpen: number): boolean {
  return liveOpen >= MERCHANT_OPEN_TOPUPS.max;
}

/** The refusal of a sixth live top-up invoice (`409 CONFLICT`, decision 049). */
export const OPEN_TOPUPS_DETAIL = `You have ${MERCHANT_OPEN_TOPUPS.max} unpaid top-up invoices. Pay one of them first, or try again later.`;

/**
 * Tells whether a merchant may not send another top-up receipt for review.
 *
 * Why: decision 049: an unpaid top-up older than 24 hours stops counting towards the five open invoices but stays payable, so the
 * receipts waiting for review are capped as well: at most five per merchant.
 *
 * @param pendingReceipts the merchant's receipts on top-up invoices that wait for review
 * @returns true when the next receipt is refused
 */
export function tooManyPendingReceipts(pendingReceipts: number): boolean {
  return pendingReceipts >= MERCHANT_OPEN_TOPUPS.max;
}

/** The refusal of a sixth receipt in review (`409 CONFLICT`, decision 049). */
export const PENDING_RECEIPTS_DETAIL = `You have ${MERCHANT_OPEN_TOPUPS.max} top-up receipts waiting for review. Wait until one of them is reviewed, then send this one.`;

/**
 * Tells whether an invoice is a manual invoice the given staff member issued.
 *
 * Why: decision 049: the payment of a staff-issued invoice is approved by someone else, or by an Owner.
 *
 * @param invoice the invoice (kind and issuer)
 * @param staffId the staff member who approves
 * @returns true when that staff member issued it
 */
export function isIssuedBy(
  invoice: { readonly kind: InvoiceKind; readonly issuedBy: number | null },
  staffId: number,
): boolean {
  return invoice.kind === 'manual' && invoice.issuedBy !== null && invoice.issuedBy === staffId;
}

/**
 * Tells whether approving a payment credits a top-up that a merchant or customer made through a manual method (a transfer receipt).
 *
 * Why: decision 049: these approvals count towards the staff member's 24-hour limit `wallet.receipt_approval_limit`; an automatic
 * gateway's top-up sent to review (the gateway confirmed the money) and the payment of a staff-issued invoice (the issuer rule applies)
 * do not.
 *
 * @param invoice the invoice the payment pays (its kind)
 * @param gateway the gateway the payment came through
 * @returns true when the approval counts
 */
export function isTransferTopUp(
  invoice: { readonly kind: InvoiceKind },
  gateway: { readonly isManual: boolean },
): boolean {
  return invoice.kind === 'topup' && gateway.isManual;
}

/** The refusal of the issuer's own approval (`403 FORBIDDEN`, decision 049). */
export const SELF_APPROVAL_DETAIL = 'You issued this invoice: another staff member, or an owner, approves its payment.';
