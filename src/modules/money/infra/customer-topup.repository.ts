// Drizzle queries of the storefront customer's store balance top-ups (feature 21, plan § 5.6.4): a top-up is a `topup` invoice with the
// customer's id and, once paid, a `topup` payment. The advisory lock that serializes one customer's creates lives here too.
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import type { DbExecutor } from '../../../infra/db';
import { type Invoice, type Payment, type PaymentGateway, invoices, paymentGateways, payments } from '../db/schema';

/**
 * Takes the transaction-scoped advisory lock of one customer's top-up creates.
 *
 * Why: plan 21 § 5.6.4 a: the limit checks read the customer's recent top-ups and then insert one; two creates of one customer must not
 * both pass the checks. The lock waits, ends with the transaction and is taken before any row lock; no network call happens while it is held.
 *
 * Side effects: holds `pg_advisory_xact_lock(hashtextextended('wallet-topup:<customerId>', 0))` until the transaction ends.
 *
 * @param tx the transaction
 * @param customerId the customer
 */
export async function lockCustomerTopUps(tx: DbExecutor, customerId: number): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`wallet-topup:${customerId}`}, 0))`);
}

const ownTopUp = (customerId: number) => and(eq(invoices.customerId, customerId), eq(invoices.kind, 'topup'));

/**
 * Finds the customer's top-up created with an `Idempotency-Key`.
 *
 * @param db the database or a transaction
 * @param customerId the customer
 * @param key the key
 * @returns the invoice, or `undefined`
 */
export async function findTopUpByKey(db: DbExecutor, customerId: number, key: string): Promise<Invoice | undefined> {
  const [row] = await db
    .select()
    .from(invoices)
    .where(and(ownTopUp(customerId), eq(invoices.idempotencyKey, key)))
    .limit(1);
  return row;
}

/**
 * Finds one of the customer's top-ups.
 *
 * @param db the database or a transaction
 * @param customerId the customer (another customer's top-up is not found)
 * @param id the invoice id
 * @param lock lock the row `FOR UPDATE` until the transaction ends
 * @returns the invoice, or `undefined`
 */
export async function findCustomerTopUp(
  db: DbExecutor,
  customerId: number,
  id: number,
  lock = false,
): Promise<Invoice | undefined> {
  const query = db
    .select()
    .from(invoices)
    .where(and(ownTopUp(customerId), eq(invoices.id, id)))
    .limit(1);
  const [row] = await (lock ? query.for('update') : query);
  return row;
}

/**
 * Lists the customer's top-ups, newest first by default, with an exact count.
 *
 * @param db the database or a transaction
 * @param customerId the customer
 * @param query the parsed list request (`createdAt` sort and the range)
 * @returns the page and the total
 */
export async function listCustomerTopUps(
  db: DbExecutor,
  customerId: number,
  query: ParsedListQuery<'createdAt'>,
): Promise<{ rows: Invoice[]; total: number }> {
  const direction = query.sort[0]?.order === 'asc' ? asc : desc;
  const rows = await db
    .select()
    .from(invoices)
    .where(ownTopUp(customerId))
    .orderBy(direction(invoices.createdAt), direction(invoices.id))
    .limit(query.range.limit)
    .offset(query.range.start);
  const [counted] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(invoices)
    .where(ownTopUp(customerId));
  return { rows, total: counted?.total ?? 0 };
}

/**
 * Reads the newest payment of each invoice.
 *
 * Why: a top-up's store status and reference come from its newest payment (a rejected receipt voids the top-up; a new top-up is a new
 * invoice), batched for a page.
 *
 * @param db the database or a transaction
 * @param invoiceIds the invoices
 * @returns the newest payment by invoice id
 */
export async function latestPaymentsOf(db: DbExecutor, invoiceIds: readonly number[]): Promise<Map<number, Payment>> {
  const unique = [...new Set(invoiceIds)];
  if (unique.length === 0) return new Map();
  const rows = await db.select().from(payments).where(inArray(payments.invoiceId, unique)).orderBy(asc(payments.id));
  const map = new Map<number, Payment>();
  for (const row of rows) if (row.invoiceId !== null) map.set(row.invoiceId, row);
  return map;
}

/**
 * Lists the gateways a storefront customer may top up through: active, for B2C or both audiences, by name.
 *
 * @param db the database or a transaction
 * @returns the gateways (the caller keeps manual ones, and automatic ones with a driver while card top-ups are on)
 */
export async function listTopUpGateways(db: DbExecutor): Promise<PaymentGateway[]> {
  return db
    .select()
    .from(paymentGateways)
    .where(and(eq(paymentGateways.isActive, true), inArray(paymentGateways.audience, ['b2c', 'both'])))
    .orderBy(asc(paymentGateways.name), asc(paymentGateways.id));
}

/**
 * Stores the hosted payment page of an automatic top-up, while it is still open.
 *
 * Side effects: updates `invoices.checkout_url`.
 *
 * @param tx the transaction
 * @param invoiceId the top-up
 * @param url the gateway's page
 * @param now the clock's time
 * @returns the invoice after the change, or `undefined` when it was no longer open
 */
export async function storeTopUpCheckoutUrl(
  tx: DbExecutor,
  invoiceId: number,
  url: string,
  now: Date,
): Promise<Invoice | undefined> {
  const [row] = await tx
    .update(invoices)
    .set({ checkoutUrl: url, updatedAt: now })
    .where(and(eq(invoices.id, invoiceId), eq(invoices.status, 'open')))
    .returning();
  return row;
}

/**
 * Voids a top-up that has no payment and frees its `Idempotency-Key` (a gateway that failed to open its page, or a stale attempt).
 *
 * Side effects: updates `invoices.status`, `idempotency_key` and `updated_at` when the top-up is open and has no payment.
 *
 * @param tx the transaction
 * @param invoiceId the top-up
 * @param now the clock's time
 * @returns true when it was voided
 */
export async function voidUnpaidTopUp(tx: DbExecutor, invoiceId: number, now: Date): Promise<boolean> {
  const rows = await tx
    .update(invoices)
    .set({ status: 'void', idempotencyKey: null, updatedAt: now })
    .where(
      and(
        eq(invoices.id, invoiceId),
        eq(invoices.status, 'open'),
        sql`not exists (select 1 from ${payments} p where p.invoice_id = ${invoices.id})`,
      ),
    )
    .returning({ id: invoices.id });
  return rows.length > 0;
}
