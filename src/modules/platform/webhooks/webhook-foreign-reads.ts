// Read-only lookups into tables other modules own, kept in this one file: the fields of an order, an invoice and a service that
// a merchant's webhook event carries.
//
// DEVIATION to resolve when those features export a reader: decision 016 wants these reads through the owning module's public
// service. Orders (feature 5) and invoices (feature 8) export nothing yet, and the platform module imports no other module (it is
// the base layer they all use), so this file reads `orders`, `services` and `invoices` with plain selects, like the catalog's
// foreign-reads repository. Replace the bodies with calls to those services; nothing outside this file knows.
import { eq } from 'drizzle-orm';
import { type DbExecutor, schema as s } from '../../../infra/db';

/** The public fields of an order, as `order.status_changed` shows them. */
export interface OrderEventSource {
  readonly orderId: number;
  readonly clientId: number;
  readonly serviceId: number;
  readonly serviceName: string;
  readonly imei: string | null;
  readonly quantity: number;
  readonly unitPrice: string;
  readonly totalPrice: string;
  readonly currency: string;
  readonly resultCode: string | null;
  readonly resultComment: string | null;
  readonly placedAt: Date;
  readonly completedAt: Date | null;
}

/**
 * Reads the public fields of a merchant's order.
 *
 * Why: `order.status_changed` carries the order as the merchant sees it (map: "the payload carries the whole order"), never the
 * cost, the supplier or the internal notes. A storefront (B2C) order has no merchant and no event.
 *
 * @param db the database or a transaction
 * @param orderId the order id
 * @returns the fields, or `undefined` when the order is gone or belongs to a storefront customer
 */
export async function orderForEvent(db: DbExecutor, orderId: number): Promise<OrderEventSource | undefined> {
  const [row] = await db
    .select({
      orderId: s.orders.id,
      clientId: s.orders.clientId,
      serviceId: s.orders.serviceId,
      serviceName: s.services.name,
      imei: s.orders.imei,
      quantity: s.orders.quantity,
      unitPrice: s.orders.unitPrice,
      totalPrice: s.orders.totalPrice,
      currency: s.orders.currency,
      resultCode: s.orders.resultCode,
      resultComment: s.orders.resultComment,
      placedAt: s.orders.placedAt,
      completedAt: s.orders.completedAt,
    })
    .from(s.orders)
    .innerJoin(s.services, eq(s.services.id, s.orders.serviceId))
    .where(eq(s.orders.id, orderId))
    .limit(1);
  return row && row.clientId !== null ? { ...row, clientId: row.clientId } : undefined;
}

/** The public fields of an invoice, as `invoice.paid` shows them. */
export interface InvoiceEventSource {
  readonly invoiceId: number;
  readonly clientId: number;
  readonly number: string;
  readonly amount: string;
  readonly currency: string;
  readonly paidAt: Date | null;
}

/**
 * Reads the public fields of a merchant's invoice.
 *
 * @param db the database or a transaction
 * @param invoiceId the invoice id
 * @returns the fields, or `undefined` when the invoice is gone or is a storefront receipt
 */
export async function invoiceForEvent(db: DbExecutor, invoiceId: number): Promise<InvoiceEventSource | undefined> {
  const [row] = await db
    .select({
      invoiceId: s.invoices.id,
      clientId: s.invoices.clientId,
      number: s.invoices.number,
      amount: s.invoices.amount,
      currency: s.invoices.currency,
      paidAt: s.invoices.paidAt,
    })
    .from(s.invoices)
    .where(eq(s.invoices.id, invoiceId))
    .limit(1);
  return row && row.clientId !== null ? { ...row, clientId: row.clientId } : undefined;
}

/**
 * Reads the name of a service.
 *
 * @param db the database or a transaction
 * @param serviceId the service id
 * @returns the name, or `undefined` when there is no such service
 */
export async function serviceNameOf(db: DbExecutor, serviceId: number): Promise<string | undefined> {
  const [row] = await db
    .select({ name: s.services.name })
    .from(s.services)
    .where(eq(s.services.id, serviceId))
    .limit(1);
  return row?.name;
}
