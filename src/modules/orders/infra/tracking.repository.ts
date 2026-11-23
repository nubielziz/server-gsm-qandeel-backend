// Drizzle queries of the public order tracking (feature 14a): the order a token names with its service, and its timeline. Read only.
import { and, asc, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { SealedCapabilityToken, UnsealedCapabilityToken } from '../../../infra/crypto';
import type { DbExecutor } from '../../../infra/db';
import { type Order, type OrderEvent, type OrderEventType, orderEvents, orders } from '../db/schema';
import { foreignTables as f } from './foreign-reads.repository';

/** An order with the service names the tracking page shows. */
export interface TrackedOrderRow {
  readonly order: Order;
  /** The title the service is published under, or its catalog name when it has no listing. */
  readonly serviceName: string;
  readonly serviceType: string;
  readonly deliveryTime: string;
}

/**
 * Finds the order a presented tracking token names, with the stored form to compare.
 *
 * Why: the capability guard looks the token up by a unique index before any handler runs; it gets the stored form back so the
 * resolver can compare it in constant time. Only a storefront order has a token. Decision 054: the lookup is by the keyed hash; an
 * order placed before is found by its plain token until the seal pass ran.
 *
 * @param db the database or a transaction
 * @param lookup the hash of the presented token (`CapabilityTokenVault.hashOf('tracking', …)`) and the token itself
 * @returns the order id and its customer, with its stored hash or plain token, or `undefined`
 */
export async function findOrderByTrackingToken(
  db: DbExecutor,
  lookup: { readonly hash: string; readonly token: string },
): Promise<{ id: number; customerId: number | null; tokenHash: string | null; token: string | null } | undefined> {
  const columns = {
    id: orders.id,
    customerId: orders.customerId,
    tokenHash: orders.publicTokenHash,
    token: orders.publicToken,
  };
  const [sealed] = await db.select(columns).from(orders).where(eq(orders.publicTokenHash, lookup.hash)).limit(1);
  if (sealed) return sealed;
  // Orders placed before decision 054 keep the token as issued until the seal pass ran.
  const [plain] = await db.select(columns).from(orders).where(eq(orders.publicToken, lookup.token)).limit(1);
  return plain;
}

/**
 * The orders that still keep their tracking token as issued, by id.
 *
 * Why: decision 054: the one-off seal pass walks them a page at a time.
 *
 * @param db the database
 * @param afterId the last id of the previous page (0 to start)
 * @param limit the page size
 * @returns the id and plain token of each row
 */
export async function findUnsealedOrders(
  db: DbExecutor,
  afterId: number,
  limit: number,
): Promise<UnsealedCapabilityToken[]> {
  const rows = await db
    .select({ id: orders.id, token: orders.publicToken })
    .from(orders)
    .where(and(isNotNull(orders.publicToken), isNull(orders.publicTokenHash), gt(orders.id, afterId)))
    .orderBy(asc(orders.id))
    .limit(limit);
  return rows.flatMap((row) => (row.token === null ? [] : [{ id: row.id, token: row.token }]));
}

/**
 * Stores an order's tracking token as its hash and encrypted copy and empties the plain column.
 *
 * Why: decision 054: the seal pass converts each row in one guarded statement, so a row that changed since it was read is left alone
 * and a repeat finds nothing to do.
 *
 * @param db the database
 * @param row the row as read (id and plain token)
 * @param sealed the token's stored forms
 * @returns true when the row was converted
 */
export async function sealOrderToken(
  db: DbExecutor,
  row: UnsealedCapabilityToken,
  sealed: SealedCapabilityToken,
): Promise<boolean> {
  const changed = await db
    .update(orders)
    // Sealing is not a change of the order: updated_at keeps its value.
    .set({
      publicTokenHash: sealed.hash,
      publicTokenEnc: sealed.enc,
      publicToken: null,
      updatedAt: sql`${orders.updatedAt}`,
    })
    .where(and(eq(orders.id, row.id), eq(orders.publicToken, row.token), isNull(orders.publicTokenHash)))
    .returning({ id: orders.id });
  return changed.length === 1;
}

/**
 * Reads a storefront order with its service names.
 *
 * Why: the tracking page names the service as the shop did: the listing's public title (a service has at most one), and the catalog name
 * only without a listing (feature 31: a bulk publish cleans the title from the supplier's name).
 *
 * @param db the database or a transaction
 * @param id the order id
 * @returns the order, or `undefined`
 */
export async function findTrackedOrder(db: DbExecutor, id: number): Promise<TrackedOrderRow | undefined> {
  const [row] = await db
    .select({
      order: orders,
      serviceName: sql<string>`coalesce(${f.listings.publicTitle}, ${f.services.name})`,
      serviceType: f.services.type,
      deliveryTime: f.services.deliveryTime,
    })
    .from(orders)
    .innerJoin(f.services, eq(f.services.id, orders.serviceId))
    .leftJoin(f.listings, eq(f.listings.serviceId, orders.serviceId))
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
 * Reads the stored forms of one order's tracking token.
 *
 * Why: decision 054: the token is kept as an encrypted copy (or, for an order placed before, as issued); the caller reveals it.
 *
 * @param db the database or a transaction
 * @param orderId the order
 * @returns the encrypted copy and the plain column, or `undefined` when the order does not exist
 */
export async function trackingTokenOfOrder(
  db: DbExecutor,
  orderId: number,
): Promise<{ enc: string | null; plain: string | null } | undefined> {
  const [row] = await db
    .select({ enc: orders.publicTokenEnc, plain: orders.publicToken })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);
  return row;
}
