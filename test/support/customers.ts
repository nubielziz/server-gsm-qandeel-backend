// Helpers for the admin customer tests (feature 14b): the currencies the customers join, a service and orders for the order figures,
// a payment with its refund, dispute and ticket for the detail's counts, and the audit rows of a customer.
import { and, asc, eq } from 'drizzle-orm';
import { type Database, schema as s } from '../../src/infra/db';
import { insertCategory, insertService } from './catalog';
import { insertOrderRow } from './orders';

/** Inserts USD, GBP, EUR and SEK (GBP and USD shown by the store, SEK not). Ids 1 to 4 in that order. */
export async function insertStoreCurrencies(db: Database): Promise<void> {
  await db.insert(s.currencies).values([
    { code: 'USD', name: 'US dollar', rateToBase: '1', isStorefront: true },
    { code: 'GBP', name: 'Pound sterling', rateToBase: '0.79', isStorefront: true },
    { code: 'EUR', name: 'Euro', rateToBase: '0.92', isStorefront: true },
    { code: 'SEK', name: 'Swedish krona', rateToBase: '10.6', isStorefront: false },
  ]);
}

/**
 * Inserts a tax rate row for each country: the storefront sells to a country when it has a current one (ANSWERS customers Q8).
 *
 * @param db the test database
 * @param countries upper-case ISO codes
 * @param window overrides of the row (a window that has ended or not yet begun, to prove such a country is refused)
 */
export async function insertTaxRates(
  db: Database,
  countries: readonly string[],
  window: Partial<typeof s.taxRates.$inferInsert> = {},
): Promise<void> {
  await db.insert(s.taxRates).values(
    countries.map((country) => ({
      country,
      ratePercent: '20',
      taxType: 'vat',
      appliesTo: 'digital_services',
      validFrom: new Date('2026-01-01T00:00:00.000Z'),
      ...window,
    })),
  );
}

/** Inserts a service and returns its id (orders need one). */
export async function insertAnyService(db: Database, name = 'Vodafone UK iPhone Unlock'): Promise<number> {
  const category = await insertCategory(db);
  return insertService(db, category, { name });
}

/** Inserts a storefront order for a customer and returns its id. */
export async function insertCustomerOrder(
  db: Database,
  serviceId: number,
  customerId: number,
  values: Partial<typeof s.orders.$inferInsert> = {},
): Promise<number> {
  const row = await insertOrderRow(db, { serviceId, customerId, source: 'store', currency: 'GBP', ...values });
  return row.id;
}

/** Inserts a payment for an order (and the gateway it needs); returns the payment id. */
export async function insertOrderPayment(db: Database, orderId: number, customerId: number): Promise<number> {
  const [gateway] = await db
    .insert(s.paymentGateways)
    .values({ code: `stripe-${crypto.randomUUID().slice(0, 6)}`, driver: 'stripe', name: 'Card' })
    .returning({ id: s.paymentGateways.id });
  const [payment] = await db
    .insert(s.payments)
    .values({
      customerId,
      orderId,
      purpose: 'order',
      gatewayId: gateway!.id,
      amount: '13.7500',
      currency: 'USD',
      status: 'captured',
      methodType: 'card',
    })
    .returning({ id: s.payments.id });
  return payment!.id;
}

/** Inserts one refund, one dispute and one ticket of a customer for the detail's counts. */
export async function insertCustomerHistory(db: Database, customerId: number, orderId: number): Promise<void> {
  const paymentId = await insertOrderPayment(db, orderId, customerId);
  await db.insert(s.refunds).values({
    paymentId,
    orderId,
    customerId,
    amount: '5.0000',
    currency: 'USD',
    method: 'original',
    requestedByType: 'customer',
    requestedById: customerId,
  });
  await db.insert(s.disputes).values({
    paymentId,
    orderId,
    customerId,
    gatewayDisputeId: `dp_${crypto.randomUUID().slice(0, 8)}`,
    reasonCode: 'fraudulent',
    amount: '13.7500',
    currency: 'USD',
    evidenceDueAt: new Date('2026-12-01T00:00:00.000Z'),
  });
  await db.insert(s.supportTickets).values({
    number: `T-${crypto.randomUUID().slice(0, 6)}`,
    subject: 'Where is my unlock?',
    requesterType: 'customer',
    requesterId: customerId,
  });
}

/** The audit rows written for one customer, oldest first. */
export async function auditOfCustomer(db: Database, customerId: number) {
  return db
    .select()
    .from(s.auditLogs)
    .where(and(eq(s.auditLogs.entityType, 'customer'), eq(s.auditLogs.entityId, customerId)))
    .orderBy(asc(s.auditLogs.id));
}
