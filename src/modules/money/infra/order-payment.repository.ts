// Drizzle queries on the storefront (order) payments of `payments` (feature 16): the pending payment of a pay call, the payment of an
// order, locks and the guarded updates of capture, failure and refund status. Top-ups have their own file (`payment.repository.ts`).
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import { type NewPayment, type Payment, invoices, payments } from '../db/schema';

/** The statuses of an order payment that was captured (money received), whatever happened to it since. */
export const CAPTURED_STATUSES = ['captured', 'partial_refund', 'refunded', 'disputed', 'chargeback'] as const;

/**
 * Takes the lock of a pay call without waiting.
 *
 * Why: two `/pay` calls with the same checkout and `Idempotency-Key` must not both open a gateway checkout; the loser learns at once
 * that the key is in use (`409 IDEMPOTENCY_IN_PROGRESS`), as REST v1 does.
 *
 * @param db the transaction
 * @param sessionId the checkout session
 * @param key the `Idempotency-Key`
 * @returns true when this transaction now holds the lock
 */
export async function tryLockPayKey(db: DbExecutor, sessionId: number, key: string): Promise<boolean> {
  const result = await db.execute(
    sql`select pg_try_advisory_xact_lock(hashtextextended(${`pay:${sessionId}:${key}`}, 0)) as locked`,
  );
  return result.rows[0]?.locked === true;
}

/**
 * Finds the payment a pay call opened under a key.
 *
 * @param db the database or a transaction
 * @param sessionId the checkout session
 * @param key the `Idempotency-Key`
 * @returns the payment, or `undefined`
 */
export async function findPaymentByKey(db: DbExecutor, sessionId: number, key: string): Promise<Payment | undefined> {
  const [row] = await db
    .select()
    .from(payments)
    .where(and(eq(payments.checkoutSessionId, sessionId), eq(payments.idempotencyKey, key)))
    .limit(1);
  return row;
}

/**
 * Reserves the next payment id.
 *
 * Why: the gateway's reference of a storefront checkout is `PAY-<id>` and the gateway is asked before anything is written.
 *
 * @param db the database or a transaction
 * @returns the id
 */
export async function reservePaymentId(db: DbExecutor): Promise<number> {
  const result = await db.execute<{ id: string }>(
    sql`select nextval(pg_get_serial_sequence('public.payments', 'id')) as id`,
  );
  return Number(result.rows[0]!.id);
}

/**
 * Inserts an order payment under an id reserved with {@link reservePaymentId}.
 *
 * Side effects: inserts a `payments` row.
 *
 * @param db the transaction
 * @param row the new row with its id
 * @returns the stored row
 */
export async function insertOrderPayment(db: DbExecutor, row: NewPayment & { id: number }): Promise<Payment> {
  const [created] = await db.insert(payments).overridingSystemValue().values(row).returning();
  return created!;
}

/**
 * Finds an order payment by id (any status).
 *
 * @param db the database or a transaction
 * @param id the payment id
 * @returns the payment, or `undefined` for an unknown id or a top-up
 */
export async function findOrderPayment(db: DbExecutor, id: number): Promise<Payment | undefined> {
  const [row] = await db
    .select()
    .from(payments)
    .where(and(eq(payments.id, id), eq(payments.purpose, 'order')))
    .limit(1);
  return row;
}

/**
 * Finds an order payment and locks it until the transaction ends.
 *
 * Why: capture, refund approval and the dispute webhook all lock the payment first and re-check its status under the lock. Lock order
 * everywhere: the order (an existing one: a rejection's guarded update and an approval's `lockOrderForRefund` take it first), the checkout
 * session, the payment, the refund, the ledger accounts.
 *
 * @param db the caller's transaction
 * @param id the payment id
 * @returns the payment, or `undefined`
 */
export async function lockOrderPayment(db: DbExecutor, id: number): Promise<Payment | undefined> {
  const [row] = await db
    .select()
    .from(payments)
    .where(and(eq(payments.id, id), eq(payments.purpose, 'order')))
    .limit(1)
    .for('update');
  return row;
}

/**
 * Finds the captured payment that paid an order.
 *
 * Why: an order can have more than one captured payment (a duplicate payment for a paid checkout is booked and refunded at once). The
 * payment that paid the order is the one linked to the order's first receipt invoice, whatever its id; the duplicate's own receipt comes
 * later. Taking the lowest payment id instead would pick an already refunded duplicate whenever it was opened first and confirmed second,
 * and a rejection would then refund nothing.
 *
 * @param db the database or a transaction
 * @param orderId the order
 * @returns the payment of the order's first receipt (when no payment is linked to a receipt, the oldest captured one), or `undefined`
 */
export async function findPaymentOfOrder(db: DbExecutor, orderId: number): Promise<Payment | undefined> {
  const [row] = await db
    .select({ payment: payments })
    .from(payments)
    .leftJoin(
      invoices,
      and(eq(invoices.id, payments.invoiceId), eq(invoices.kind, 'receipt'), eq(invoices.orderId, orderId)),
    )
    .where(
      and(
        eq(payments.purpose, 'order'),
        eq(payments.orderId, orderId),
        inArray(payments.status, [...CAPTURED_STATUSES]),
      ),
    )
    .orderBy(sql`${invoices.id} asc nulls last`, asc(payments.id))
    .limit(1);
  return row?.payment;
}

/**
 * Finds a payment by the gateway's reference (the event's id of the payment).
 *
 * @param db the database or a transaction
 * @param gatewayId the gateway
 * @param reference the gateway's reference
 * @returns the order payment, or `undefined`
 */
export async function findOrderPaymentByReference(
  db: DbExecutor,
  gatewayId: number,
  reference: string,
): Promise<Payment | undefined> {
  const [row] = await db
    .select()
    .from(payments)
    .where(and(eq(payments.purpose, 'order'), eq(payments.gatewayId, gatewayId), eq(payments.gatewayTxnId, reference)))
    .limit(1);
  return row;
}

/**
 * Updates an order payment.
 *
 * Side effects: updates the `payments` row.
 *
 * @param db the caller's transaction
 * @param id the payment id
 * @param changes the columns to set
 * @returns the stored row
 */
export async function updateOrderPayment(db: DbExecutor, id: number, changes: Partial<NewPayment>): Promise<Payment> {
  const [updated] = await db.update(payments).set(changes).where(eq(payments.id, id)).returning();
  return updated!;
}

/**
 * Updates an order payment only while it still has a status (a guarded change).
 *
 * @param db the caller's transaction
 * @param id the payment id
 * @param statuses the statuses it must be in
 * @param changes the columns to set
 * @returns the stored row, or `undefined` when another request changed it first
 */
export async function updateOrderPaymentIn(
  db: DbExecutor,
  id: number,
  statuses: readonly Payment['status'][],
  changes: Partial<NewPayment>,
): Promise<Payment | undefined> {
  const [updated] = await db
    .update(payments)
    .set(changes)
    .where(and(eq(payments.id, id), inArray(payments.status, [...statuses])))
    .returning();
  return updated;
}

/**
 * Reads order payments by id.
 *
 * @param db the database or a transaction
 * @param ids the payment ids
 * @returns the payments that exist (top-ups excluded), by id
 */
export async function loadOrderPayments(db: DbExecutor, ids: readonly number[]): Promise<Map<number, Payment>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select()
    .from(payments)
    .where(and(eq(payments.purpose, 'order'), inArray(payments.id, unique)));
  return new Map(rows.map((row) => [row.id, row]));
}
