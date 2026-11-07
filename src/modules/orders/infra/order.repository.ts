// Drizzle queries on the tables the orders module owns (`orders`, `order_events`): find, insert, the guarded status update of
// every transition, and the timeline writes and reads. The read model with its joins is order-read.repository.ts.
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import {
  type NewOrder,
  type NewOrderEvent,
  type Order,
  type OrderDispatchState,
  type OrderEvent,
  type OrderEventType,
  type OrderStatus,
  type OrderVerificationStatus,
  orderEvents,
  orders,
} from '../db/schema';

/**
 * Finds an order.
 *
 * @param db the database or a transaction
 * @param id the order id
 * @returns the row, or `undefined`
 */
export async function findOrder(db: DbExecutor, id: number): Promise<Order | undefined> {
  const [row] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
  return row;
}

/**
 * Inserts an order and returns the stored row.
 *
 * Why: `placed_at` and `created_at` are never given: both take the same transaction time (decision 025, orders-suppliers-1).
 *
 * @param db the transaction
 * @param row the new order (without the two timestamps)
 * @returns the stored order with its generated id (the Dhru REFERENCEID)
 */
export async function insertOrder(db: DbExecutor, row: NewOrder): Promise<Order> {
  const [created] = await db.insert(orders).values(row).returning();
  return created!;
}

/** The state an order must still be in for a guarded update to apply. */
export interface OrderStateGuard {
  readonly status: OrderStatus;
  readonly dispatchState: OrderDispatchState;
  readonly verificationStatus: OrderVerificationStatus | null;
}

/** The columns a transition may change. */
export type OrderChanges = Partial<
  Pick<
    Order,
    | 'status'
    | 'dispatchState'
    | 'verificationStatus'
    | 'resultCode'
    | 'resultComment'
    | 'completedAt'
    | 'adminNote'
    | 'sentAt'
    | 'supplierId'
    | 'supplierServiceId'
    | 'supplierRef'
  >
>;

/**
 * Applies a transition with the guarded update of decision 025.
 *
 * Why: `UPDATE ... WHERE id = $1 AND status = $2 AND dispatch_state = $3 AND verification_status IS NOT DISTINCT FROM $4`: zero
 * rows means another request changed the order first, so the caller answers `409 INVALID_TRANSITION` and posts nothing. Two
 * parallel replies, or a reply and a reject, therefore change the order and the ledger once.
 *
 * @param db the transaction
 * @param id the order id
 * @param from the state the use case decided on
 * @param changes the columns to write
 * @returns the updated row, or `undefined` when the guard no longer held
 */
export async function updateOrderGuarded(
  db: DbExecutor,
  id: number,
  from: OrderStateGuard,
  changes: OrderChanges,
): Promise<Order | undefined> {
  const [row] = await db
    .update(orders)
    .set(changes)
    .where(
      and(
        eq(orders.id, id),
        eq(orders.status, from.status),
        eq(orders.dispatchState, from.dispatchState),
        from.verificationStatus === null
          ? isNull(orders.verificationStatus)
          : eq(orders.verificationStatus, from.verificationStatus),
      ),
    )
    .returning();
  return row;
}

/**
 * Sets the latest internal note on an order (any status).
 *
 * @param db the transaction
 * @param id the order id
 * @param note the note text
 * @returns true when the order exists
 */
export async function setAdminNote(db: DbExecutor, id: number, note: string): Promise<boolean> {
  const rows = await db.update(orders).set({ adminNote: note }).where(eq(orders.id, id)).returning({ id: orders.id });
  return rows.length > 0;
}

/**
 * Takes the transaction-scoped advisory lock of a duplicate fingerprint.
 *
 * Why: the `block_open` duplicate rule must hold when two requests place the same IMEI at the same moment: both would read "no
 * open duplicate" before either inserts. The lock makes the second wait for the first's commit, then see its order.
 *
 * @param db the transaction
 * @param fingerprint the keyed hash of merchant, service and input
 */
export async function lockFingerprint(db: DbExecutor, fingerprint: string): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${fingerprint}, 0))`);
}

/**
 * Tells whether the merchant already has an open order with this fingerprint.
 *
 * @param db the transaction (after {@link lockFingerprint})
 * @param fingerprint the keyed hash of merchant, service and input
 * @returns the id of an open order with it, or `undefined`
 */
export async function findOpenDuplicate(db: DbExecutor, fingerprint: string): Promise<number | undefined> {
  const [row] = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.fingerprint, fingerprint), inArray(orders.status, ['pending', 'processing'])))
    .limit(1);
  return row?.id;
}

/**
 * Appends events to an order's timeline.
 *
 * @param db the transaction
 * @param events the events, in the order they happened
 * @returns the stored rows
 */
export async function insertEvents(db: DbExecutor, events: readonly NewOrderEvent[]): Promise<OrderEvent[]> {
  if (events.length === 0) return [];
  return db
    .insert(orderEvents)
    .values([...events])
    .returning();
}

/**
 * Counts the events of one type on an order.
 *
 * @param db the transaction
 * @param orderId the order
 * @param type the event type
 * @returns how many there are
 */
export async function countEventsOfType(db: DbExecutor, orderId: number, type: OrderEventType): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(orderEvents)
    .where(and(eq(orderEvents.orderId, orderId), eq(orderEvents.type, type)));
  return row?.total ?? 0;
}

/**
 * Tells whether a settlement of this order already booked a supplier cost.
 *
 * Why: B17 (decision 024): a reopen reverses revenue only and the cost stays booked, so a later completion must not book it a
 * second time. Every `settle` event records the cost it booked in `data.cost`.
 *
 * @param db the transaction
 * @param orderId the order
 * @returns true when an earlier `settle` event booked a cost above zero
 */
export async function costAlreadyBooked(db: DbExecutor, orderId: number): Promise<boolean> {
  const result = await db.execute<{ booked: boolean }>(sql`
    select exists (
      select 1 from ${orderEvents}
      where order_id = ${orderId} and type = 'settle' and coalesce((data->>'cost')::numeric, 0) > 0
    ) as booked`);
  return result.rows[0]?.booked === true;
}

/**
 * Reads the timeline of an order, oldest first.
 *
 * @param db the database or a transaction
 * @param orderId the order
 * @param types when given, only events of these types
 * @returns the events
 */
export async function eventsOfOrder(
  db: DbExecutor,
  orderId: number,
  types?: readonly OrderEventType[],
): Promise<OrderEvent[]> {
  return db
    .select()
    .from(orderEvents)
    .where(
      types === undefined
        ? eq(orderEvents.orderId, orderId)
        : and(eq(orderEvents.orderId, orderId), inArray(orderEvents.type, [...types])),
    )
    .orderBy(asc(orderEvents.id));
}

/**
 * Reads the newest review reason of several orders.
 *
 * Why: orders-suppliers-14 and decision 025: `reviewReason` is the text stored on the event that opened the current queue: the
 * newest `review`, `risk` or `verification` event that carries a `reason`.
 *
 * @param db the database or a transaction
 * @param orderIds the orders of a page
 * @returns the reason by order id; orders without one are absent
 */
export async function reviewReasonsOf(db: DbExecutor, orderIds: readonly number[]): Promise<Map<number, string>> {
  const reasons = new Map<number, string>();
  if (orderIds.length === 0) return reasons;
  const rows = await db
    .selectDistinctOn([orderEvents.orderId], {
      orderId: orderEvents.orderId,
      reason: sql<string>`${orderEvents.data}->>'reason'`,
    })
    .from(orderEvents)
    .where(
      and(
        inArray(orderEvents.orderId, [...orderIds]),
        inArray(orderEvents.type, ['review', 'risk', 'verification']),
        sql`${orderEvents.data} ? 'reason'`,
      ),
    )
    .orderBy(orderEvents.orderId, desc(orderEvents.id));
  for (const row of rows) reasons.set(row.orderId, row.reason);
  return reasons;
}

/**
 * Counts the dispatch events of several orders.
 *
 * Why: `attempts` on the wire is the number of `dispatch` events (the brief's seed rule).
 *
 * @param db the database or a transaction
 * @param orderIds the orders of a page
 * @returns the count by order id; orders without a dispatch are absent
 */
export async function attemptsOf(db: DbExecutor, orderIds: readonly number[]): Promise<Map<number, number>> {
  const attempts = new Map<number, number>();
  if (orderIds.length === 0) return attempts;
  const rows = await db
    .select({ orderId: orderEvents.orderId, total: sql<number>`count(*)::int` })
    .from(orderEvents)
    .where(and(inArray(orderEvents.orderId, [...orderIds]), eq(orderEvents.type, 'dispatch')))
    .groupBy(orderEvents.orderId);
  for (const row of rows) attempts.set(row.orderId, row.total);
  return attempts;
}
