// Drizzle queries on `webhook_endpoints` (platform module): a merchant's own list, the row a change locks, the writes, the
// endpoints an event goes to, and the failure counter. Every function takes a DbExecutor, so a caller can use its transaction.
import { and, arrayContains, eq, sql } from 'drizzle-orm';
import { type DbExecutor, type ListColumns, listOrderBy } from '../../../infra/db';
import { type NewWebhookEndpoint, type WebhookEndpoint, webhookEndpoints } from '../db/schema';

/** The columns a merchant's endpoint list may be sorted by (wire names). */
export type EndpointSortField = 'createdAt' | 'id';

const COLUMNS: ListColumns = { createdAt: webhookEndpoints.createdAt, id: webhookEndpoints.id };

/**
 * Lists a merchant's endpoints.
 *
 * @param db the database or a transaction
 * @param clientId the merchant
 * @param page the range and the sort keys
 * @returns the page and the exact number of endpoints of the merchant
 */
export async function listEndpointsOfClient(
  db: DbExecutor,
  clientId: number,
  page: {
    readonly offset: number;
    readonly limit: number;
    readonly sort: readonly { readonly field: EndpointSortField; readonly order: 'asc' | 'desc' }[];
  },
): Promise<{ rows: WebhookEndpoint[]; total: number }> {
  const where = eq(webhookEndpoints.clientId, clientId);
  const [rows, [count]] = await Promise.all([
    db
      .select()
      .from(webhookEndpoints)
      .where(where)
      .orderBy(...listOrderBy(page.sort, COLUMNS, webhookEndpoints.id))
      .limit(page.limit)
      .offset(page.offset),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(webhookEndpoints)
      .where(where),
  ]);
  return { rows, total: count?.total ?? 0 };
}

/**
 * Counts a merchant's endpoints.
 *
 * @param db the transaction that holds the merchant's endpoint lock
 * @param clientId the merchant
 * @returns the number of endpoints
 */
export async function countEndpointsOfClient(db: DbExecutor, clientId: number): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.clientId, clientId));
  return row?.total ?? 0;
}

/**
 * Serialises the creation of endpoints of one merchant.
 *
 * Why: "at most 5 endpoints" is a count followed by an insert; two requests at once would both see four.
 *
 * Side effects: takes `pg_advisory_xact_lock` (released at commit or rollback).
 *
 * @param db the transaction
 * @param clientId the merchant
 */
export async function lockEndpointsOfClient(db: DbExecutor, clientId: number): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`webhook-endpoints:${clientId}`}, 0))`);
}

/**
 * Reads an endpoint and holds its row until the transaction ends.
 *
 * @param db the transaction
 * @param id the endpoint id
 * @returns the endpoint, or `undefined` when there is none
 */
export async function lockEndpoint(db: DbExecutor, id: number): Promise<WebhookEndpoint | undefined> {
  const [row] = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, id)).limit(1).for('update');
  return row;
}

/**
 * Reads an endpoint.
 *
 * @param db the database or a transaction
 * @param id the endpoint id
 * @returns the endpoint, or `undefined` when there is none
 */
export async function findEndpoint(db: DbExecutor, id: number): Promise<WebhookEndpoint | undefined> {
  const [row] = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, id)).limit(1);
  return row;
}

/**
 * Inserts an endpoint.
 *
 * Side effects: inserts a `webhook_endpoints` row.
 *
 * @param db the transaction
 * @param values the new endpoint (the secret already encrypted)
 * @returns the stored row
 */
export async function insertEndpoint(db: DbExecutor, values: NewWebhookEndpoint): Promise<WebhookEndpoint> {
  const [row] = await db.insert(webhookEndpoints).values(values).returning();
  return row!;
}

/**
 * Changes an endpoint.
 *
 * @param db the transaction that holds the endpoint
 * @param id the endpoint id
 * @param changes the columns to change
 * @returns the endpoint after the change
 */
export async function updateEndpoint(
  db: DbExecutor,
  id: number,
  changes: {
    readonly url?: string;
    readonly events?: readonly string[];
    readonly isActive?: boolean;
    readonly failureCount?: number;
  },
): Promise<WebhookEndpoint> {
  const [row] = await db
    .update(webhookEndpoints)
    .set({
      ...(changes.url === undefined ? {} : { url: changes.url }),
      ...(changes.events === undefined ? {} : { events: [...changes.events] }),
      ...(changes.isActive === undefined ? {} : { isActive: changes.isActive }),
      ...(changes.failureCount === undefined ? {} : { failureCount: changes.failureCount }),
      updatedAt: sql`now()`,
    })
    .where(eq(webhookEndpoints.id, id))
    .returning();
  return row!;
}

/**
 * Deletes an endpoint; its deliveries go with it (`ON DELETE CASCADE`, identity-platform-12).
 *
 * Side effects: deletes the `webhook_endpoints` row and its `webhook_deliveries`.
 *
 * @param db the transaction that holds the endpoint
 * @param id the endpoint id
 */
export async function deleteEndpoint(db: DbExecutor, id: number): Promise<void> {
  await db.delete(webhookEndpoints).where(eq(webhookEndpoints.id, id));
}

/**
 * Lists the active endpoints of a merchant that subscribed to an event.
 *
 * @param db the database or a transaction
 * @param clientId the merchant
 * @param event the event type
 * @returns the endpoints, oldest first
 */
export function activeEndpointsFor(db: DbExecutor, clientId: number, event: string): Promise<WebhookEndpoint[]> {
  return db
    .select()
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.clientId, clientId),
        eq(webhookEndpoints.isActive, true),
        arrayContains(webhookEndpoints.events, [event]),
      ),
    )
    .orderBy(webhookEndpoints.id);
}

/**
 * Counts one more failed attempt on an endpoint.
 *
 * @param db the transaction
 * @param id the endpoint id
 */
export async function bumpFailureCount(db: DbExecutor, id: number): Promise<void> {
  await db
    .update(webhookEndpoints)
    .set({ failureCount: sql`${webhookEndpoints.failureCount} + 1`, updatedAt: sql`now()` })
    .where(eq(webhookEndpoints.id, id));
}

/**
 * Resets the failure counter after a delivery worked.
 *
 * @param db the transaction
 * @param id the endpoint id
 */
export async function resetFailureCount(db: DbExecutor, id: number): Promise<void> {
  await db
    .update(webhookEndpoints)
    .set({ failureCount: 0, updatedAt: sql`now()` })
    .where(and(eq(webhookEndpoints.id, id), sql`${webhookEndpoints.failureCount} > 0`));
}
