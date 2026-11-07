// The wire shapes of billing (gateways, invoices, payments) built from rows and what was read around them. Pure: the services read
// the merchants, groups, wallets and names for a whole page at once and hand them in.
import type { z } from 'zod';
import { Money } from '../../../common/money';
import type {
  MerchantInvoiceSchema,
  MerchantPaymentSchema,
  PaymentMethodSchema,
} from '../contracts/billing-portal.contracts';
import type { PaymentGatewaySchema } from '../contracts/gateways.contracts';
import type { InvoiceSchema } from '../contracts/invoices.contracts';
import type { PaymentSchema } from '../contracts/payments.contracts';
import type { Invoice, Payment, PaymentGateway } from '../db/schema';
import { effectiveMaxAmount, topupMethodOf } from '../domain/gateway-rules';
import { waitingNote } from '../domain/payment-rules';

/** A gateway on the wire (`PaymentGateway` of the console). */
export type WireGateway = z.output<typeof PaymentGatewaySchema>;
/** An invoice on the wire for staff (`Invoice` of the console). */
export type WireInvoice = z.output<typeof InvoiceSchema>;
/** A top-up payment on the wire for staff (`Payment` of the console). */
export type WirePayment = z.output<typeof PaymentSchema>;
/** A payment method on the merchant portal. */
export type WirePaymentMethod = z.output<typeof PaymentMethodSchema>;
/** An invoice on the merchant portal. */
export type WireMerchantInvoice = z.output<typeof MerchantInvoiceSchema>;
/** A payment of an invoice on the merchant portal. */
export type WireMerchantPayment = z.output<typeof MerchantPaymentSchema>;

const iso = (date: Date | null): string | null => (date ? date.toISOString() : null);

/**
 * Builds a gateway on the wire.
 *
 * @param row the gateway row
 * @param secretHint the hint of the stored credential, or `null`
 * @param volume30d the money taken in the last 30 days (a 4-decimal amount)
 * @returns the console's gateway
 */
export function gatewayToWire(row: PaymentGateway, secretHint: string | null, volume30d: string): WireGateway {
  return {
    id: row.id,
    code: row.code,
    driver: row.driver,
    name: row.name,
    audience: row.audience,
    feePercent: row.feePercent,
    feeFixed: row.feeFixed,
    minAmount: row.minAmount,
    maxAmount: row.maxAmount,
    allowedGroupIds: [...row.allowedGroupIds],
    supportsRefunds: row.supportsRefunds,
    supports3ds: row.supports3ds,
    isManual: row.isManual,
    instructions: row.instructions,
    holdHours: row.holdHours,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    secretHint,
    volume30d,
  };
}

/**
 * Builds an invoice for staff.
 *
 * @param row the invoice row
 * @param client the merchant `{id, name}`, or `undefined`
 * @param customer the storefront customer, or `undefined`
 * @returns the console's invoice (a `''` description is sent as null)
 */
export function invoiceToWire(
  row: Invoice,
  client: { id: number; name: string } | undefined,
  customer: { id: number; name: string; email: string } | undefined,
): WireInvoice {
  return {
    id: row.id,
    number: row.number,
    kind: row.kind,
    status: row.status,
    amount: row.amount,
    fee: row.fee,
    netAmount: row.netAmount,
    taxAmount: row.taxAmount,
    taxRate: row.taxRate,
    taxCountry: row.taxCountry,
    customerVatId: row.customerVatId,
    total: row.total,
    currency: row.currency,
    client: client ? { id: client.id, name: client.name } : null,
    customer: customer ? { id: customer.id, name: customer.name, email: customer.email } : null,
    orderId: row.orderId,
    pdfFileId: row.pdfFileId,
    description: row.description === '' ? null : row.description,
    dueAt: iso(row.dueAt),
    paidAt: iso(row.paidAt),
    createdAt: row.createdAt.toISOString(),
  };
}

/** What a payment's wire needs besides the row. */
export interface PaymentContext {
  readonly clientId: number | null;
  readonly client: { id: number; name: string } | undefined;
  readonly groupName: string | null;
  readonly walletBalance: string | null;
  readonly gateway: { id: number; name: string } | undefined;
  readonly reviewerName: string | undefined;
  /** True when the merchant has no approved top-up yet (a hint for the reviewer). */
  readonly firstDeposit: boolean;
}

/**
 * Builds a top-up payment for staff.
 *
 * Why: money.md: `reviewedBy` is the staff member, or `{ id: null, name: 'System' }` for an automatic credit (reviewed_at set, no
 * reviewer); the `note` is the review note, else a hint while the payment is pending.
 *
 * @param row the payment row
 * @param context the merchant, group, wallet, gateway and reviewer read for the page
 * @returns the console's payment
 */
export function paymentToWire(row: Payment, context: PaymentContext): WirePayment {
  const net = Money.of(row.amount).sub(Money.of(row.feeAmount)).toWire();
  return {
    id: row.id,
    purpose: row.purpose,
    status: row.status as WirePayment['status'],
    methodType: row.methodType as WirePayment['methodType'],
    amount: row.amount,
    feeAmount: row.feeAmount,
    netAmount: net,
    currency: row.currency,
    gatewayTxnId: row.gatewayTxnId ?? '',
    capturedAt: iso(row.capturedAt),
    createdAt: row.createdAt.toISOString(),
    invoiceId: row.invoiceId,
    receiptFileId: row.receiptFileId,
    client: context.client
      ? {
          id: context.client.id,
          name: context.client.name,
          group: context.groupName,
          walletBalance: context.walletBalance,
        }
      : null,
    gateway: context.gateway ? { id: context.gateway.id, name: context.gateway.name } : null,
    reviewedBy:
      row.reviewedAt === null
        ? null
        : row.reviewedBy === null
          ? { id: null, name: 'System' }
          : { id: row.reviewedBy, name: context.reviewerName ?? `Staff ${row.reviewedBy}` },
    reviewedAt: iso(row.reviewedAt),
    note: noteOf(row, context.firstDeposit),
  };
}

function noteOf(row: Payment, firstDeposit: boolean): string | null {
  if (row.reviewNote) return row.reviewNote;
  if (row.status !== 'pending') return null;
  if (row.autoCreditAt && !row.reviewRequired) return waitingNote(row.autoCreditAt);
  return firstDeposit ? 'First deposit of this merchant.' : null;
}

/**
 * Builds a payment method for the merchant portal.
 *
 * @param row the gateway row
 * @param depositLimit the merchant group's `deposit_limit` (`0.0000` = none)
 * @returns the portal's payment method; `maxAmount` is the lower of the gateway maximum and the group limit
 */
export function paymentMethodToWire(row: PaymentGateway, depositLimit: string): WirePaymentMethod {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    kind: row.isManual ? 'manual' : 'automatic',
    methodType: topupMethodOf(row.driver, row.isManual),
    feePercent: row.feePercent,
    feeFixed: row.feeFixed,
    minAmount: row.minAmount,
    maxAmount: effectiveMaxAmount(row.maxAmount, depositLimit),
    currency: 'USD',
    holdHours: row.holdHours,
    instructions: row.isManual ? row.instructions : '',
  };
}

/**
 * Builds an invoice for the merchant portal.
 *
 * @param row the invoice row (never a storefront receipt)
 * @param gateway the gateway the invoice is paid through, or `undefined`
 * @returns the portal's invoice
 */
export function merchantInvoiceToWire(
  row: Invoice,
  gateway: { id: number; name: string } | undefined,
): WireMerchantInvoice {
  return {
    id: row.id,
    number: row.number,
    kind: row.kind as WireMerchantInvoice['kind'],
    status: row.status,
    amount: row.amount,
    fee: row.fee,
    netAmount: row.netAmount,
    taxAmount: row.taxAmount,
    taxRate: row.taxRate,
    total: row.total,
    currency: row.currency,
    description: row.description === '' ? null : row.description,
    gateway: gateway ? { id: gateway.id, name: gateway.name } : null,
    dueAt: iso(row.dueAt),
    paidAt: iso(row.paidAt),
    pdfFileId: row.pdfFileId,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Builds a payment for the merchant portal.
 *
 * @param row the payment row
 * @returns the portal's payment (the reference is `''` when there is none)
 */
export function merchantPaymentToWire(row: Payment): WireMerchantPayment {
  return {
    id: row.id,
    amount: row.amount,
    feeAmount: row.feeAmount,
    currency: row.currency,
    status: row.status as WireMerchantPayment['status'],
    methodType: row.methodType as WireMerchantPayment['methodType'],
    reference: row.gatewayTxnId ?? '',
    receiptFileId: row.receiptFileId,
    capturedAt: iso(row.capturedAt),
    createdAt: row.createdAt.toISOString(),
  };
}
