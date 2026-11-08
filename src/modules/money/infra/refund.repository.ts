// Drizzle queries on `refunds` (map routes /admin/refunds*, feature 16): the storefront refund list with sort, filter, search and exact
// count, find with a row lock, insert, guarded updates and the sums the refundable amount needs. Only the money module touches this table.
import { type SQL, and, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, schema as s } from '../../../infra/db';
import { listOrderBy, listWhere } from '../../../infra/db/list-sql';
import { type NewRefund, type Refund, type RefundStatus, refunds } from '../db/schema';

/** The sort fields of the refund list. */
export type RefundSortField = 'id' | 'amount' | 'status' | 'createdAt';

const COLUMNS = {
  id: refunds.id,
  refundId: sql`${refunds.id}::text`,
  amount: refunds.amount,
  status: refunds.status,
  createdAt: refunds.createdAt,
  reason: refunds.reason,
  'customer.name': s.customers.name,
  'customer.email': s.customers.email,
};

/**
 * Lists storefront refunds.
 *
 * Why: ANSWERS refunds Q1 and RESOLUTIONS money-12: only refunds of customers (`customer_id` set) are listed; merchant refunds go
 * through the order.
 *
 * @param db the database or a transaction
 * @param query the parsed list request (`q` searches the id, the reason and the customer name)
 * @returns the page of refunds and the number matching the filters
 */
export async function listRefundRows(
  db: DbExecutor,
  query: ParsedListQuery<RefundSortField>,
): Promise<{ rows: Refund[]; total: number }> {
  const where = listWhere(query, COLUMNS, isNotNull(refunds.customerId));
  const [rows, [counted]] = await Promise.all([
    db
      .select({ refund: refunds })
      .from(refunds)
      .leftJoin(s.customers, eq(s.customers.id, refunds.customerId))
      .where(where)
      .orderBy(...listOrderBy(query.sort, COLUMNS, refunds.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(refunds)
      .leftJoin(s.customers, eq(s.customers.id, refunds.customerId))
      .where(where),
  ]);
  return { rows: rows.map((row) => row.refund), total: counted?.total ?? 0 };
}

/**
 * Finds a storefront refund by id.
 *
 * @param db the database or a transaction
 * @param id the refund id
 * @returns the refund, or `undefined` for an unknown id or a merchant refund
 */
export async function findStorefrontRefund(db: DbExecutor, id: number): Promise<Refund | undefined> {
  const [row] = await db
    .select()
    .from(refunds)
    .where(and(eq(refunds.id, id), isNotNull(refunds.customerId)))
    .limit(1);
  return row;
}

/**
 * Finds a refund and locks it until the transaction ends.
 *
 * Why: approve, decline, retry and the gateway's answer all lock the refund and re-check its status under the lock, so the loser of a
 * race changes nothing.
 *
 * @param db the caller's transaction
 * @param id the refund id
 * @returns the refund, or `undefined`
 */
export async function lockRefund(db: DbExecutor, id: number): Promise<Refund | undefined> {
  const [row] = await db.select().from(refunds).where(eq(refunds.id, id)).limit(1).for('update');
  return row;
}

/**
 * Inserts a refund.
 *
 * Side effects: inserts a `refunds` row.
 *
 * @param db the caller's transaction
 * @param row the new refund
 * @returns the stored row
 */
export async function insertRefund(db: DbExecutor, row: NewRefund): Promise<Refund> {
  const [created] = await db.insert(refunds).values(row).returning();
  return created!;
}

/**
 * Updates a refund.
 *
 * Side effects: updates the `refunds` row.
 *
 * @param db the caller's transaction
 * @param id the refund id
 * @param changes the columns to set
 * @returns the stored row
 */
export async function updateRefund(db: DbExecutor, id: number, changes: Partial<NewRefund>): Promise<Refund> {
  const [updated] = await db.update(refunds).set(changes).where(eq(refunds.id, id)).returning();
  return updated!;
}

/**
 * Updates a refund only while it is in one of the given statuses (a guarded change).
 *
 * @param db the caller's transaction
 * @param id the refund id
 * @param statuses the statuses it must be in
 * @param changes the columns to set
 * @returns the stored row, or `undefined` when another request changed it first
 */
export async function updateRefundIn(
  db: DbExecutor,
  id: number,
  statuses: readonly RefundStatus[],
  changes: Partial<NewRefund>,
): Promise<Refund | undefined> {
  const [updated] = await db
    .update(refunds)
    .set(changes)
    .where(and(eq(refunds.id, id), inArray(refunds.status, [...statuses])))
    .returning();
  return updated;
}

/**
 * Moves a `processing` refund to `failed`, and moves its idempotency key on when the gateway refused it for good.
 *
 * Why: the next send of a refund the gateway refused (a 4xx, a failed refund object) must use a new key, or the gateway only replays the
 * refusal; after a failure whose outcome is unknown (a timeout, a 5xx) the key stays, so a refund the gateway may have made is not made twice.
 *
 * @param db the caller's transaction
 * @param id the refund id
 * @param changes the failure text, the gateway's id and the time
 * @param definite true when the gateway refused the refund for good: `send_attempt` grows by one in the same update
 * @returns the stored row, or `undefined` when the refund was not `processing`
 */
export async function failProcessingRefund(
  db: DbExecutor,
  id: number,
  changes: Pick<NewRefund, 'note' | 'updatedAt'> & Partial<Pick<NewRefund, 'gatewayRefundId'>>,
  definite: boolean,
): Promise<Refund | undefined> {
  const [updated] = await db
    .update(refunds)
    .set({
      ...changes,
      status: 'failed',
      ...(definite ? { sendAttempt: sql`${refunds.sendAttempt} + 1` } : {}),
    })
    .where(and(eq(refunds.id, id), eq(refunds.status, 'processing')))
    .returning();
  return updated;
}

/**
 * The refunds of a payment that count against what can still go back.
 *
 * Why: ANSWERS refunds Q3: the limit is the paid amount minus the other refunds that are `completed` or `processing` (an approved
 * refund is money already promised). A `failed` refund counts too: its reversal stays posted in the ledger and a retry still sends
 * the money, so a second approval must not post (and pay) the same money again.
 *
 * @param db the database or a transaction
 * @param paymentId the payment
 * @param exceptId a refund to leave out (the one being decided)
 * @returns the refunds, oldest first
 */
export async function takenRefundsOfPayment(db: DbExecutor, paymentId: number, exceptId?: number): Promise<Refund[]> {
  const conditions: SQL[] = [
    eq(refunds.paymentId, paymentId),
    inArray(refunds.status, ['processing', 'completed', 'failed']),
  ];
  if (exceptId !== undefined) conditions.push(ne(refunds.id, exceptId));
  return db
    .select()
    .from(refunds)
    .where(and(...conditions))
    .orderBy(refunds.id);
}

/**
 * Finds a refund by the gateway's own id.
 *
 * @param db the database or a transaction
 * @param paymentId the payment the refund belongs to
 * @param gatewayRefundId the gateway's id
 * @returns the refund, or `undefined`
 */
export async function findRefundByGatewayId(
  db: DbExecutor,
  paymentId: number,
  gatewayRefundId: string,
): Promise<Refund | undefined> {
  const [row] = await db
    .select()
    .from(refunds)
    .where(and(eq(refunds.paymentId, paymentId), eq(refunds.gatewayRefundId, gatewayRefundId)))
    .limit(1);
  return row;
}

/**
 * Finds a refund by id (any refund, storefront or not).
 *
 * @param db the database or a transaction
 * @param id the refund id
 * @returns the refund, or `undefined`
 */
export async function findRefund(db: DbExecutor, id: number): Promise<Refund | undefined> {
  const [row] = await db.select().from(refunds).where(eq(refunds.id, id)).limit(1);
  return row;
}

/**
 * Finds the refund a gateway's event is about, among the refunds of payments of that gateway.
 *
 * Why: a refund result event names our refund id (echoed metadata) or the gateway's own refund id; either way the refund must belong
 * to a payment of the gateway that signed the event, so one gateway can never settle another's refunds.
 *
 * @param db the database or a transaction
 * @param gatewayId the gateway that signed the event
 * @param ref our refund id and/or the gateway's refund id from the event
 * @returns the refund, or `undefined`
 */
export async function findRefundForGateway(
  db: DbExecutor,
  gatewayId: number,
  ref: { readonly refundId: number | null; readonly gatewayRefundId: string },
): Promise<Refund | undefined> {
  const [row] = await db
    .select({ refund: refunds })
    .from(refunds)
    .innerJoin(s.payments, eq(s.payments.id, refunds.paymentId))
    .where(
      and(
        eq(s.payments.gatewayId, gatewayId),
        ref.refundId === null ? eq(refunds.gatewayRefundId, ref.gatewayRefundId) : eq(refunds.id, ref.refundId),
      ),
    )
    .limit(1);
  return row?.refund;
}
