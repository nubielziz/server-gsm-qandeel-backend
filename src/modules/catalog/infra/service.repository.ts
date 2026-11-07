// Drizzle queries of the service routes on `services` and the parts of a service (`service_fields`, `service_options`,
// `service_group_prices`): the list and the single row with the figures worked out in SQL, the locks and writes, and the
// pricing-rule switches of the archive and delete paths.
import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, type ListColumns, listOrderBy, listWhere } from '../../../infra/db';
import {
  type NewService,
  type NewServiceField,
  type NewServiceOption,
  type Service,
  type ServiceField,
  type ServiceGroupPrice,
  type ServiceOption,
  pricingRules,
  serviceCategories,
  serviceFields,
  serviceGroupPrices,
  serviceOptions,
  services,
} from '../db/schema';
import { belowFloorSql, floorPriceSql, marginPctSql, minProfitSql } from './service-figures.sql';

/** A service with its category name and the figures worked out in SQL. */
export interface ServiceRow {
  readonly service: Service;
  readonly categoryName: string;
  /** The minimum profit that counts, four decimals. */
  readonly minProfit: string;
  readonly floorPrice: string;
  readonly marginPct: string;
  readonly belowFloor: boolean;
}

const COLUMNS: ListColumns = {
  id: services.id,
  name: services.name,
  type: services.type,
  status: services.status,
  categoryId: services.categoryId,
  basePrice: services.basePrice,
  // `cost` on the wire is the effective cost (RESOLUTIONS catalog-1), so the sort uses it too.
  cost: services.effectiveCost,
  code: services.code,
  'category.name': serviceCategories.name,
  belowFloor: belowFloorSql,
};

const live = isNull(services.archivedAt);

function selectRows(db: DbExecutor) {
  return db
    .select({
      service: services,
      categoryName: serviceCategories.name,
      minProfit: minProfitSql,
      floorPrice: floorPriceSql,
      marginPct: marginPctSql,
      belowFloor: belowFloorSql,
    })
    .from(services)
    .innerJoin(serviceCategories, eq(serviceCategories.id, services.categoryId));
}

/**
 * Lists live services for `GET /admin/services`.
 *
 * @param db the database or a transaction
 * @param query the parsed list request (filters, search, sort, range)
 * @returns the page of services with their figures, and the exact total
 */
export async function listServiceRows(
  db: DbExecutor,
  query: ParsedListQuery<'name' | 'type' | 'cost' | 'basePrice' | 'id'>,
): Promise<{ rows: ServiceRow[]; total: number }> {
  const where = listWhere(query, COLUMNS, live);
  const [rows, [count]] = await Promise.all([
    selectRows(db)
      .where(where)
      .orderBy(...listOrderBy(query.sort, COLUMNS, services.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(services)
      .innerJoin(serviceCategories, eq(serviceCategories.id, services.categoryId))
      .where(where),
  ]);
  return { rows, total: count?.total ?? 0 };
}

/**
 * Finds a live service with its figures.
 *
 * @param db the database or a transaction
 * @param id the service id
 * @returns the service, or `undefined` when it is unknown or archived
 */
export async function findServiceRow(db: DbExecutor, id: number): Promise<ServiceRow | undefined> {
  const [row] = await selectRows(db)
    .where(and(eq(services.id, id), live))
    .limit(1);
  return row;
}

/**
 * Finds a live service and locks it for the rest of the transaction.
 *
 * Why: a change, a delete, a replace-all of its parts and an inventory import on the same service must not interleave (the
 * delete decides between archiving and deleting from what refers to it).
 *
 * @param db the transaction
 * @param id the service id
 * @param mode `update` for writers (default), `share` for readers that insert children (inventory import)
 * @returns the service, or `undefined` when it is unknown or archived
 */
export async function lockLiveService(
  db: DbExecutor,
  id: number,
  mode: 'update' | 'share' = 'update',
): Promise<Service | undefined> {
  const query = db
    .select()
    .from(services)
    .where(and(eq(services.id, id), live))
    .limit(1);
  const [row] = await query.for(mode === 'update' ? 'update' : 'share');
  return row;
}

/**
 * Finds the live service that holds a code, ignoring case.
 *
 * @param db the database or a transaction
 * @param code the trimmed code
 * @param exceptId a service to leave out (the one being changed)
 * @returns the id and name of the service that holds the code, or `undefined`
 */
export async function findServiceByCode(
  db: DbExecutor,
  code: string,
  exceptId?: number,
): Promise<{ id: number; name: string } | undefined> {
  const same = and(sql`lower(${services.code}) = lower(${code})`, live);
  const [row] = await db
    .select({ id: services.id, name: services.name })
    .from(services)
    .where(exceptId === undefined ? same : and(same, ne(services.id, exceptId)))
    .limit(1);
  return row;
}

/**
 * Inserts a service.
 *
 * @param db the transaction
 * @param row the new service
 * @returns the stored service
 */
export async function insertServiceRow(db: DbExecutor, row: NewService): Promise<Service> {
  const [created] = await db.insert(services).values(row).returning();
  return created!;
}

/**
 * Changes a service.
 *
 * @param db the transaction
 * @param id the service id
 * @param changes the columns that change
 * @returns the updated service, or `undefined` when it is gone
 */
export async function updateServiceRow(
  db: DbExecutor,
  id: number,
  changes: Partial<Omit<NewService, 'id'>>,
): Promise<Service | undefined> {
  const [row] = await db.update(services).set(changes).where(eq(services.id, id)).returning();
  return row;
}

/**
 * Switches the pricing rules of one service off.
 *
 * @param db the transaction
 * @param serviceId the archived service
 * @returns the ids of the rules that were active
 */
export async function deactivateServiceRules(db: DbExecutor, serviceId: number): Promise<number[]> {
  const rows = await db
    .update(pricingRules)
    .set({ isActive: false })
    .where(
      and(eq(pricingRules.scope, 'service'), eq(pricingRules.targetId, serviceId), eq(pricingRules.isActive, true)),
    )
    .returning({ id: pricingRules.id });
  return rows.map((row) => row.id).sort((a, b) => a - b);
}

/**
 * Deletes the pricing rules of one service.
 *
 * @param db the transaction
 * @param serviceId the service about to be deleted
 * @returns the ids of the deleted rules
 */
export async function deleteServiceRules(db: DbExecutor, serviceId: number): Promise<number[]> {
  const rows = await db
    .delete(pricingRules)
    .where(and(eq(pricingRules.scope, 'service'), eq(pricingRules.targetId, serviceId)))
    .returning({ id: pricingRules.id });
  return rows.map((row) => row.id).sort((a, b) => a - b);
}

/**
 * Deletes a service row (its fields, options and prices go with it).
 *
 * @param db the transaction
 * @param id the service id
 * @returns true when a row was deleted
 */
export async function deleteServiceRow(db: DbExecutor, id: number): Promise<boolean> {
  const rows = await db.delete(services).where(eq(services.id, id)).returning({ id: services.id });
  return rows.length > 0;
}

/**
 * Reads the custom fields of a service in order.
 *
 * @param db the database or a transaction
 * @param serviceId the service
 * @returns the fields by `sort`
 */
export async function listFieldRows(db: DbExecutor, serviceId: number): Promise<ServiceField[]> {
  return db
    .select()
    .from(serviceFields)
    .where(eq(serviceFields.serviceId, serviceId))
    .orderBy(asc(serviceFields.sort), asc(serviceFields.id));
}

/**
 * Reads the option lists of a service in the order they were saved.
 *
 * @param db the database or a transaction
 * @param serviceId the service
 * @returns the options by id (insertion order)
 */
export async function listOptionRows(db: DbExecutor, serviceId: number): Promise<ServiceOption[]> {
  return db
    .select()
    .from(serviceOptions)
    .where(eq(serviceOptions.serviceId, serviceId))
    .orderBy(asc(serviceOptions.id));
}

/**
 * Reads the fixed group prices of a service.
 *
 * @param db the database or a transaction
 * @param serviceId the service
 * @returns the prices by group id
 */
export async function listGroupPriceRows(db: DbExecutor, serviceId: number): Promise<ServiceGroupPrice[]> {
  return db
    .select()
    .from(serviceGroupPrices)
    .where(eq(serviceGroupPrices.serviceId, serviceId))
    .orderBy(asc(serviceGroupPrices.groupId));
}

/** Rows inserted per statement when a replace-all list is written. */
const INSERT_CHUNK = 500;

/**
 * Replaces all custom fields of a service: deletes the old ones and inserts the new list in order.
 *
 * @param db the transaction (the service row is locked)
 * @param serviceId the service
 * @param rows the new fields; `sort` is set from the list order
 * @returns the saved fields in order
 */
export async function replaceFieldRows(
  db: DbExecutor,
  serviceId: number,
  rows: ReadonlyArray<Omit<NewServiceField, 'serviceId' | 'sort' | 'id'>>,
): Promise<ServiceField[]> {
  await db.delete(serviceFields).where(eq(serviceFields.serviceId, serviceId));
  const saved: ServiceField[] = [];
  for (let start = 0; start < rows.length; start += INSERT_CHUNK) {
    const chunk = rows
      .slice(start, start + INSERT_CHUNK)
      .map((row, offset) => ({ ...row, serviceId, sort: start + offset }));
    saved.push(...(await db.insert(serviceFields).values(chunk).returning()));
  }
  return saved.sort((a, b) => a.sort - b.sort);
}

/**
 * Replaces all option lists of a service: deletes the old entries and inserts the new list in order.
 *
 * @param db the transaction (the service row is locked)
 * @param serviceId the service
 * @param rows the new entries
 * @returns the saved options in order
 */
export async function replaceOptionRows(
  db: DbExecutor,
  serviceId: number,
  rows: ReadonlyArray<Omit<NewServiceOption, 'serviceId' | 'id'>>,
): Promise<ServiceOption[]> {
  await db.delete(serviceOptions).where(eq(serviceOptions.serviceId, serviceId));
  const saved: ServiceOption[] = [];
  for (let start = 0; start < rows.length; start += INSERT_CHUNK) {
    const chunk = rows.slice(start, start + INSERT_CHUNK).map((row) => ({ ...row, serviceId }));
    saved.push(...(await db.insert(serviceOptions).values(chunk).returning()));
  }
  return saved.sort((a, b) => a.id - b.id);
}
