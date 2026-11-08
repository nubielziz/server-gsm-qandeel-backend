// The content of a customer data export (feature 18, GET /admin/customers/:id/export, the data-subject access right): what is in the
// file and what is never in it. Pure, no database.
import type { Customer } from '../db/schema';
import type { ExportRows } from '../infra/privacy-reads.repository';

/** The format version of the file, so a reader can tell when the shape changes. */
export const EXPORT_FORMAT = 1;

const iso = (date: Date | null): string | null => (date === null ? null : date.toISOString());

/**
 * Builds the export document of one customer.
 *
 * Why: the console downloads it as `customer-<id>.json` (B49, RESOLUTIONS b2c-8). It holds the profile, the orders (service, IMEI,
 * status, totals, dates), the payments without card data (no brand, fingerprint or gateway payload), the consents, the checkout
 * sessions, the support tickets with their public messages (never the internal notes), the IMEI checks and the data requests. Passwords,
 * sessions and tokens are not personal data the customer can use and are never included. What staff keep to protect the shop is left out too:
 * the internal notes, the risk level, the reason of a suspension and the blocklist entries made from the customer's data. The file has
 * what the customer gave and did, not what the shop thinks of them. An IMEI is decrypted for the file, and an erased one is `null`.
 *
 * @param customer the customer row
 * @param rows the rows read about the customer
 * @param exportedAt the clock's time
 * @param imeiOf decrypts a stored IMEI (`null` stays `null`; an unreadable text becomes `null`)
 * @returns a JSON-serialisable object
 */
export function buildCustomerExport(
  customer: Customer,
  rows: ExportRows,
  exportedAt: Date,
  imeiOf: (kind: 'checkout' | 'check', ciphertext: string | null) => string | null,
): Record<string, unknown> {
  return {
    format: EXPORT_FORMAT,
    exportedAt: exportedAt.toISOString(),
    profile: {
      id: customer.id,
      email: customer.email,
      emailVerifiedAt: iso(customer.emailVerifiedAt),
      name: customer.name,
      phone: customer.phone,
      country: customer.country,
      locale: customer.locale,
      currency: customer.currency,
      hasAccount: customer.hasAccount,
      marketingOptIn: customer.marketingOptIn,
      status: customer.status,
      lastLoginAt: iso(customer.lastLoginAt),
      firstOrderAt: iso(customer.firstOrderAt),
      totalSpent: customer.totalSpent,
      anonymizedAt: iso(customer.anonymizedAt),
      createdAt: customer.createdAt.toISOString(),
    },
    orders: rows.orders.map((order) => ({
      id: order.id,
      service: order.service,
      imei: order.imei,
      status: order.status,
      quantity: order.quantity,
      totalPrice: order.totalPrice,
      taxAmount: order.taxAmount,
      currency: order.currency,
      createdAt: order.createdAt.toISOString(),
      completedAt: iso(order.completedAt),
    })),
    payments: rows.payments.map((payment) => ({
      id: payment.id,
      orderId: payment.orderId,
      amount: payment.amount,
      feeAmount: payment.feeAmount,
      currency: payment.currency,
      status: payment.status,
      method: payment.methodType,
      capturedAt: iso(payment.capturedAt),
      createdAt: payment.createdAt.toISOString(),
    })),
    consents: rows.consents.map((consent) => ({
      id: consent.id,
      purpose: consent.purpose,
      granted: consent.granted,
      ip: consent.ip,
      userAgent: consent.userAgent,
      checkoutSessionId: consent.checkoutSessionId,
      orderId: consent.orderId,
      createdAt: consent.createdAt.toISOString(),
    })),
    checkoutSessions: rows.sessions.map((session) => ({
      id: session.id,
      email: session.email,
      service: session.service,
      imei: imeiOf('checkout', session.imeiEnc),
      quantity: session.quantity,
      currency: session.currency,
      netAmount: session.netAmount,
      taxAmount: session.taxAmount,
      grossAmount: session.grossAmount,
      taxCountry: session.taxCountry,
      status: session.status,
      ip: session.ip,
      userAgent: session.userAgent,
      orderId: session.orderId,
      createdAt: session.createdAt.toISOString(),
      expiresAt: session.expiresAt.toISOString(),
    })),
    supportTickets: rows.tickets.map((ticket) => ({
      number: ticket.number,
      subject: ticket.subject,
      status: ticket.status,
      category: ticket.category,
      createdAt: ticket.createdAt.toISOString(),
      messages: ticket.messages.map((message) => ({
        author: message.author,
        body: message.body,
        createdAt: message.createdAt.toISOString(),
      })),
    })),
    imeiChecks: rows.imeiChecks.map((check) => ({
      id: check.id,
      imei: imeiOf('check', check.imeiEnc),
      source: check.source,
      type: check.checkType,
      status: check.status,
      ip: check.ip,
      createdAt: check.createdAt.toISOString(),
    })),
    dataRequests: rows.requests.map((request) => ({
      id: request.id,
      kind: request.kind,
      status: request.status,
      requestedAt: request.requestedAt.toISOString(),
      dueAt: request.dueAt.toISOString(),
      completedAt: iso(request.completedAt),
    })),
  };
}
