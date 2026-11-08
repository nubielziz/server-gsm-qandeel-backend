// Drizzle queries of the public order tracking (feature 14a): the order a token names with its service, and its timeline. Read only.
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import { type Order, type OrderEvent, type OrderEventType, orderEvents, orders } from '../db/schema';
import { foreignTables as f } from './foreign-reads.repository';

/** An order with the service names the tracking page shows. */
export interface TrackedOrderRow {
  readonly order: Order;
  readonly serviceName: string;
  readonly serviceType: string;
  readonly deliveryTime: string;
}

/**
 * Finds the id and token of the order a tracking token names.
 *
 * Why: the capability guard looks the token up by the unique index before any handler runs; it gets the stored token back so the
 * resolver can compare it in constant time. Only a storefront order has a token.
 *
 * @param db the database or a transaction
 * @param token the token the visitor sent
 * @returns the order id and stored token, or `undefined`
 */
export async function findOrderByTrackingToken(
  db: DbExecutor,
  token: string,
): Promise<{ id: number; token: string } | undefined> {
  const [row] = await db
    .select({ id: orders.id, token: orders.publicToken })
    .from(orders)
    .where(eq(orders.publicToken, token))
    .limit(1);
  return row?.token == null ? undefined : { id: row.id, token: row.token };
}

/**
 * Reads a storefront order with its service names.
 *
 * @param db the database or a transaction
 * @param id the order id
 * @returns the order, or `undefined`
 */
export async function findTrackedOrder(db: DbExecutor, id: number): Promise<TrackedOrderRow | undefined> {
  const [row] = await db
    .select({
      order: orders,
      serviceName: f.services.name,
      serviceType: f.services.type,
      deliveryTime: f.services.deliveryTime,
    })
    .from(orders)
    .innerJoin(f.services, eq(f.services.id, orders.serviceId))
    .where(eq(orders.id, id))
    .limit(1);
  return row;
}

/**
 * Reads the timeline lines of the given types, oldest first.
 *
 * @param db the database or a transaction
 * @param orderId the order
 * @param types the event types to keep
 * @returns the events by id
 */
export async function findOrderEventsOfTypes(
  db: DbExecutor,
  orderId: number,
  types: readonly OrderEventType[],
): Promise<OrderEvent[]> {
  return db
    .select()
    .from(orderEvents)
    .where(and(eq(orderEvents.orderId, orderId), inArray(orderEvents.type, [...types])))
    .orderBy(asc(orderEvents.createdAt), asc(orderEvents.id));
}

/**
 * Reads the tracking token of one order.
 *
 * @param db the database or a transaction
 * @param orderId the order
 * @returns the token, or `null` for an order without one (a merchant's)
 */
export async function trackingTokenOfOrder(db: DbExecutor, orderId: number): Promise<string | null> {
  const [row] = await db.select({ token: orders.publicToken }).from(orders).where(eq(orders.id, orderId)).limit(1);
  return row?.token ?? null;
}
