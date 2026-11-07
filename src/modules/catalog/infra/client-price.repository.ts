// Drizzle queries of the client price routes on `service_client_prices`, joined to the live service each price is for.
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, type ListColumns, listOrderBy, listWhere } from '../../../infra/db';
import {
  type NewServiceClientPrice,
  type Service,
  type ServiceClientPrice,
  serviceClientPrices,
  services,
} from '../db/schema';

/** A client price with its service. */
export interface ClientPriceRow {
  readonly price: ServiceClientPrice;
  readonly service: Service;
}

const COLUMNS: ListColumns = {
  id: serviceClientPrices.id,
  price: serviceClientPrices.price,
  createdAt: serviceClientPrices.createdAt,
  clientId: serviceClientPrices.clientId,
  serviceId: serviceClientPrices.serviceId,
  'service.name': services.name,
  'service.code': services.code,
};

/** Prices of archived services are gone for every reader (RESOLUTIONS catalog-3). */
const liveService = isNull(services.archivedAt);

const select = (db: DbExecutor) =>
  db
    .select({ price: serviceClientPrices, service: services })
    .from(serviceClientPrices)
    .innerJoin(services, eq(services.id, serviceClientPrices.serviceId));

/**
 * Lists client prices for `GET /admin/client-prices`.
 *
 * @param db the database or a transaction
 * @param query the parsed list request (`clientId` and `serviceId` filters, search, sort, range)
 * @returns the page and the exact total
 */
export async function listClientPriceRows(
  db: DbExecutor,
  query: ParsedListQuery<'service.name' | 'price' | 'createdAt' | 'id'>,
): Promise<{ rows: ClientPriceRow[]; total: number }> {
  const where = listWhere(query, COLUMNS, liveService);
  const [rows, [count]] = await Promise.all([
    select(db)
      .where(where)
      .orderBy(...listOrderBy(query.sort, COLUMNS, serviceClientPrices.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(serviceClientPrices)
      .innerJoin(services, eq(services.id, serviceClientPrices.serviceId))
      .where(where),
  ]);
  return { rows, total: count?.total ?? 0 };
}

/**
 * Finds a client price with its (live) service.
 *
 * @param db the database or a transaction
 * @param id the client price id
 * @returns the row, or `undefined` when it is unknown or its service is archived
 */
export async function findClientPriceRow(db: DbExecutor, id: number): Promise<ClientPriceRow | undefined> {
  const [row] = await select(db)
    .where(and(eq(serviceClientPrices.id, id), liveService))
    .limit(1);
  return row;
}

/**
 * Finds a client price and locks it for the rest of the transaction.
 *
 * @param db the transaction
 * @param id the client price id
 * @returns the row with its service, or `undefined` when it is unknown or its service is archived
 */
export async function lockClientPriceRow(db: DbExecutor, id: number): Promise<ClientPriceRow | undefined> {
  const [row] = await select(db)
    .where(and(eq(serviceClientPrices.id, id), liveService))
    .limit(1)
    .for('update', { of: serviceClientPrices });
  return row;
}

/**
 * Finds a merchant's price for a service.
 *
 * @param db the database or a transaction
 * @param clientId the merchant
 * @param serviceId the service
 * @returns the price row, or `undefined`
 */
export async function findClientPriceByPair(
  db: DbExecutor,
  clientId: number,
  serviceId: number,
): Promise<ServiceClientPrice | undefined> {
  const [row] = await db
    .select()
    .from(serviceClientPrices)
    .where(and(eq(serviceClientPrices.clientId, clientId), eq(serviceClientPrices.serviceId, serviceId)))
    .limit(1);
  return row;
}

/**
 * Inserts a client price.
 *
 * @param db the transaction
 * @param row the new price
 * @returns the stored row
 */
export async function insertClientPrice(db: DbExecutor, row: NewServiceClientPrice): Promise<ServiceClientPrice> {
  const [created] = await db.insert(serviceClientPrices).values(row).returning();
  return created!;
}

/**
 * Changes a client price.
 *
 * @param db the transaction
 * @param id the client price id
 * @param changes the columns that change
 * @returns the updated row
 */
export async function updateClientPriceRow(
  db: DbExecutor,
  id: number,
  changes: Partial<Pick<NewServiceClientPrice, 'price' | 'note'>>,
): Promise<ServiceClientPrice | undefined> {
  const [row] = await db.update(serviceClientPrices).set(changes).where(eq(serviceClientPrices.id, id)).returning();
  return row;
}

/**
 * Deletes a client price.
 *
 * @param db the transaction
 * @param id the client price id
 * @returns true when a row was deleted
 */
export async function deleteClientPriceRow(db: DbExecutor, id: number): Promise<boolean> {
  const rows = await db
    .delete(serviceClientPrices)
    .where(eq(serviceClientPrices.id, id))
    .returning({ id: serviceClientPrices.id });
  return rows.length > 0;
}
