// Drizzle queries on `webhook_deliveries` (platform module): creating a delivery once per event and endpoint, the guarded writes
// of an attempt's result, a manual retry, the staff log with its joins and the endpoint's own log.
import { and, eq, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, type ListColumns, listOrderBy, listWhere, schema as s } from '../../../infra/db';
import {
  type WebhookDelivery,
  type WebhookDeliveryStatus,
  outboxEvents,
  webhookDeliveries,
  webhookEndpoints,
} from '../db/schema';

/** The columns the delivery lists may be sorted by (wire names). */
export type DeliverySortField = 'createdAt' | 'id';

/** A delivery with the endpoint and the merchant behind it. */
export interface DeliveryRow {
  readonly delivery: WebhookDelivery;
  readonly endpoint: { readonly id: number; readonly url: string };
  readonly client: { readonly id: number; readonly name: string };
}

/** A delivery with what the sender needs: the endpoint's address, the encrypted secret and its switch. */
export interface DeliveryToSend {
  readonly delivery: WebhookDelivery;
  readonly endpoint: {
    readonly id: number;
    readonly clientId: number;
    readonly url: string;
    readonly secretEnc: string;
    readonly isActive: boolean;
  };
}

const ADMIN_COLUMNS: ListColumns = {
  id: webhookDeliveries.id,
  createdAt: webhookDeliveries.createdAt,
  status: webhookDeliveries.status,
  event: webhookDeliveries.event,
  clientId: s.clients.id,
  'client.name': s.clients.name,
  'endpoint.url': webhookEndpoints.url,
};

function joined(db: DbExecutor) {
  return db
    .select({
      delivery: webhookDeliveries,
      endpointId: webhookEndpoints.id,
      endpointUrl: webhookEndpoints.url,
      clientId: s.clients.id,
      clientName: s.clients.name,
    })
    .from(webhookDeliveries)
    .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId))
    .innerJoin(s.clients, eq(s.clients.id, webhookEndpoints.clientId));
}

function toRow(row: {
  delivery: WebhookDelivery;
  endpointId: number;
  endpointUrl: string;
  clientId: number;
  clientName: string;
}): DeliveryRow {
  return {
    delivery: row.delivery,
    endpoint: { id: row.endpointId, url: row.endpointUrl },
    client: { id: row.clientId, name: row.clientName },
  };
}

/**
 * Lists deliveries for `GET /admin/webhook-deliveries`.
 *
 * @param db the database or a transaction
 * @param query the parsed list request (filters `status`, `event`, `clientId`; `q` over merchant, event and address)
 * @returns the page of deliveries with their endpoint and merchant, and the exact total for the filter
 */
export async function listDeliveryRows(
  db: DbExecutor,
  query: ParsedListQuery<DeliverySortField>,
): Promise<{ rows: DeliveryRow[]; total: number }> {
  const where = listWhere(query, ADMIN_COLUMNS);
  const [rows, [count]] = await Promise.all([
    joined(db)
      .where(where)
      .orderBy(...listOrderBy(query.sort, ADMIN_COLUMNS, webhookDeliveries.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(webhookDeliveries)
      .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId))
      .innerJoin(s.clients, eq(s.clients.id, webhookEndpoints.clientId))
      .where(where),
  ]);
  return { rows: rows.map(toRow), total: count?.total ?? 0 };
}

/**
 * Reads one delivery with its endpoint and merchant.
 *
 * @param db the database or a transaction
 * @param id the delivery id
 * @returns the row, or `undefined` when there is none
 */
export async function findDeliveryRow(db: DbExecutor, id: number): Promise<DeliveryRow | undefined> {
  const [row] = await joined(db).where(eq(webhookDeliveries.id, id)).limit(1);
  return row ? toRow(row) : undefined;
}

/**
 * Lists the deliveries of one endpoint for `GET /client/webhooks/:id/deliveries`, newest first by default.
 *
 * @param db the database or a transaction
 * @param endpointId the endpoint
 * @param page the range and the sort keys
 * @returns the page and the exact number of deliveries of the endpoint
 */
export async function listDeliveriesOfEndpoint(
  db: DbExecutor,
  endpointId: number,
  page: {
    readonly offset: number;
    readonly limit: number;
    readonly sort: readonly { readonly field: DeliverySortField; readonly order: 'asc' | 'desc' }[];
  },
): Promise<{ rows: WebhookDelivery[]; total: number }> {
  const columns: ListColumns = { createdAt: webhookDeliveries.createdAt, id: webhookDeliveries.id };
  const where = eq(webhookDeliveries.endpointId, endpointId);
  const [rows, [count]] = await Promise.all([
    db
      .select()
      .from(webhookDeliveries)
      .where(where)
      .orderBy(...listOrderBy(page.sort, columns, webhookDeliveries.id))
      .limit(page.limit)
      .offset(page.offset),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(webhookDeliveries)
      .where(where),
  ]);
  return { rows, total: count?.total ?? 0 };
}

/** What a new delivery needs. */
export interface NewDelivery {
  readonly endpointId: number;
  readonly event: string;
  readonly eventId: string;
  readonly payload: Record<string, unknown>;
  readonly nextRetryAt: Date;
}

/**
 * Inserts a delivery unless the endpoint already has one for the event.
 *
 * Why: `(endpoint_id, event_id)` is unique, so a fan-out that runs twice (a retried job) or a price change seen twice creates one
 * delivery.
 *
 * Side effects: inserts a `webhook_deliveries` row (attempt 1, `pending`, due at `nextRetryAt`).
 *
 * @param db the transaction
 * @param values the delivery
 * @returns the new row, or `undefined` when the endpoint already had the event
 */
export async function insertDeliveryOnce(db: DbExecutor, values: NewDelivery): Promise<WebhookDelivery | undefined> {
  const [row] = await db
    .insert(webhookDeliveries)
    .values({ ...values, attempt: 1, status: 'pending' })
    .onConflictDoNothing({ target: [webhookDeliveries.endpointId, webhookDeliveries.eventId] })
    .returning();
  return row;
}

/**
 * Reads the deliveries of an event at some endpoints that still wait for their next attempt.
 *
 * Why: a fan-out job that is repeated finds its deliveries already inserted; it only has to be sure each has its job.
 *
 * @param db the database or a transaction
 * @param eventId the event id
 * @param endpointIds the endpoints
 * @returns the pending deliveries
 */
export function pendingDeliveriesOfEvent(
  db: DbExecutor,
  eventId: string,
  endpointIds: readonly number[],
): Promise<WebhookDelivery[]> {
  if (endpointIds.length === 0) return Promise.resolve([]);
  return db
    .select()
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.eventId, eventId),
        eq(webhookDeliveries.status, 'pending'),
        sql`${webhookDeliveries.endpointId} in (${sql.join(
          endpointIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      ),
    );
}

/**
 * Reads a delivery with the endpoint it goes to.
 *
 * @param db the database or a transaction
 * @param id the delivery id
 * @returns the delivery and its endpoint, or `undefined` when the delivery (or its endpoint) is gone
 */
export async function findDeliveryToSend(db: DbExecutor, id: number): Promise<DeliveryToSend | undefined> {
  const [row] = await db
    .select({
      delivery: webhookDeliveries,
      endpointId: webhookEndpoints.id,
      clientId: webhookEndpoints.clientId,
      url: webhookEndpoints.url,
      secretEnc: webhookEndpoints.secretEnc,
      isActive: webhookEndpoints.isActive,
    })
    .from(webhookDeliveries)
    .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId))
    .where(eq(webhookDeliveries.id, id))
    .limit(1);
  return row
    ? {
        delivery: row.delivery,
        endpoint: {
          id: row.endpointId,
          clientId: row.clientId,
          url: row.url,
          secretEnc: row.secretEnc,
          isActive: row.isActive,
        },
      }
    : undefined;
}

/** The result of one attempt, as it is stored. */
export interface AttemptResult {
  readonly responseCode: number | null;
  readonly responseBody: string | null;
  readonly error: string | null;
}

/** What the next state of a delivery is after an attempt. */
export type AttemptOutcome =
  | { readonly status: 'delivered' }
  | { readonly status: 'pending'; readonly attempt: number; readonly nextRetryAt: Date }
  | { readonly status: 'failed' };

/**
 * Writes the result of an attempt, but only if the delivery is still on that attempt and waiting.
 *
 * Why: a job that runs twice (a stalled worker, a retried job) must not record one attempt twice or undo a manual retry; the
 * guard `status = 'pending' and attempt = <this attempt>` lets exactly one writer win.
 *
 * Side effects: updates the `webhook_deliveries` row.
 *
 * @param db the transaction
 * @param id the delivery id
 * @param attempt the attempt that was made
 * @param outcome the state to move to
 * @param result what the merchant's server answered
 * @returns true when this call wrote the result
 */
export async function recordAttempt(
  db: DbExecutor,
  id: number,
  attempt: number,
  outcome: AttemptOutcome,
  result: AttemptResult,
): Promise<boolean> {
  const rows = await db
    .update(webhookDeliveries)
    .set({
      status: outcome.status,
      ...(outcome.status === 'pending' ? { attempt: outcome.attempt, nextRetryAt: outcome.nextRetryAt } : {}),
      ...(outcome.status === 'pending' ? {} : { nextRetryAt: null }),
      responseCode: result.responseCode,
      responseBody: result.responseBody,
      error: result.error,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(webhookDeliveries.id, id),
        eq(webhookDeliveries.status, 'pending'),
        eq(webhookDeliveries.attempt, attempt),
      ),
    )
    .returning({ id: webhookDeliveries.id });
  return rows.length > 0;
}

/**
 * Reads a delivery and holds its row until the transaction ends.
 *
 * @param db the transaction
 * @param id the delivery id
 * @returns the delivery, or `undefined` when there is none
 */
export async function lockDelivery(db: DbExecutor, id: number): Promise<WebhookDelivery | undefined> {
  const [row] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id)).limit(1).for('update');
  return row;
}

/**
 * Queues a new attempt of a delivery: pending, one attempt further, due now.
 *
 * Side effects: updates the `webhook_deliveries` row.
 *
 * @param db the transaction that holds the delivery
 * @param id the delivery id
 * @param now the time the attempt is due (the injected clock's)
 * @returns the delivery after the change
 */
export async function requeueDelivery(db: DbExecutor, id: number, now: Date): Promise<WebhookDelivery> {
  const [row] = await db
    .update(webhookDeliveries)
    .set({
      status: 'pending' satisfies WebhookDeliveryStatus,
      attempt: sql`${webhookDeliveries.attempt} + 1`,
      nextRetryAt: now,
      updatedAt: sql`now()`,
    })
    .where(eq(webhookDeliveries.id, id))
    .returning();
  return row!;
}

/**
 * Deletes one delivery (the test delivery whose job could not be queued).
 *
 * Side effects: deletes a `webhook_deliveries` row.
 *
 * @param db the transaction
 * @param id the delivery id
 */
export async function deleteDeliveryOf(db: DbExecutor, id: number): Promise<void> {
  await db.delete(webhookDeliveries).where(eq(webhookDeliveries.id, id));
}

/**
 * Reads when an outbox event was written.
 *
 * Why: the envelope's `createdAt` is the moment the event happened, not the moment the worker got to it.
 *
 * @param db the database or a transaction
 * @param eventId the outbox row id
 * @returns the time, or `undefined` when the row is gone
 */
export async function outboxEventTime(db: DbExecutor, eventId: number): Promise<Date | undefined> {
  const [row] = await db
    .select({ createdAt: outboxEvents.createdAt })
    .from(outboxEvents)
    .where(eq(outboxEvents.id, eventId))
    .limit(1);
  return row?.createdAt;
}
