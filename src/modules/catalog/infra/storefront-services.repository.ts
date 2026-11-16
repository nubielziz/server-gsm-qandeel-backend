// Drizzle queries of the storefront's view of the catalog (feature 14a): the services a group may buy, their order fields, and
// the TAC catalogue. Read only; the visibility rule is the merchant catalog's (live, active, active category, group allowed).
import { type SQL, and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import {
  type Service,
  type ServiceField,
  type ServiceType,
  type TacCatalogEntry,
  serviceCategories,
  serviceFields,
  serviceGroupPrices,
  serviceOptions,
  services,
  tacCatalog,
} from '../db/schema';
import { visibleTo } from './merchant-catalog.repository';

/** A service with its category. */
export interface SellableServiceRow {
  readonly service: Service;
  readonly categoryId: number;
  readonly categoryName: string;
  readonly categoryNameAr: string;
}

/**
 * Reads the services of a list that a group may buy.
 *
 * @param db the database or a transaction
 * @param ids the service ids to look at
 * @param groupId the group whose visibility counts (the storefront's retail group)
 * @returns the rows that are visible; the others are simply absent
 */
export async function findSellableServices(
  db: DbExecutor,
  ids: readonly number[],
  groupId: number,
): Promise<SellableServiceRow[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      service: services,
      categoryId: serviceCategories.id,
      categoryName: serviceCategories.name,
      categoryNameAr: serviceCategories.nameAr,
    })
    .from(services)
    .innerJoin(serviceCategories, eq(serviceCategories.id, services.categoryId))
    .where(and(inArray(services.id, [...new Set(ids)]), visibleTo(groupId)));
  return rows;
}

/** What a buyer's own record needs to name a service, whatever its state today. */
export interface ServiceNameRow {
  readonly id: number;
  readonly name: string;
  readonly type: Service['type'];
  readonly deliveryTime: string;
}

/**
 * Reads the names of some services, live or archived, active or not.
 *
 * Why: a checkout session or an order must still say which service it was for after the service is switched off or archived.
 *
 * @param db the database or a transaction
 * @param ids the service ids
 * @returns one row per id that exists
 */
export async function findServiceNames(db: DbExecutor, ids: readonly number[]): Promise<ServiceNameRow[]> {
  if (ids.length === 0) return [];
  return db
    .select({ id: services.id, name: services.name, type: services.type, deliveryTime: services.deliveryTime })
    .from(services)
    .where(inArray(services.id, [...new Set(ids)]));
}

/** The most ids {@link findPricedServiceIds} returns: the same ceiling as a price export. */
const MAX_PRICED_IDS = 10_000;

/**
 * The smallest quantity a service accepts, as SQL: the smallest pack, else `min_qty` (the twin of `smallestOrder` in
 * domain/storefront-availability.ts). Refers to the outer table `services` by name.
 */
const NEED_SQL = sql`coalesce((select min(q) from unnest(services.qty_options) as q), services.min_qty)`;

/**
 * "The service has enough available inventory codes for its smallest order", as a condition on the outer table `services`.
 *
 * Why: feature 22 shows `in_stock` / `on_request` and filters by it. The count is bounded by the smallest order and uses the
 * partial index `inventory_codes_available_idx (service_id, id)`, so a service with a million codes costs the same as one with
 * three. Written with the table name `services` as text so it also works in a select from `services` alone (Drizzle prints
 * columns without their table there). The domain twin is `coversSmallestOrder`.
 */
export const IN_STOCK_SQL: SQL = sql`((select count(*) from (select 1 from inventory_codes ic where ic.service_id = services.id and ic.status = 'available' limit ${NEED_SQL}) s) >= ${NEED_SQL})`;

/** What narrows the storefront's priced ids: service types, categories, and the stock flag. An empty list restricts nothing. */
export interface SellableFilter {
  readonly types?: readonly ServiceType[];
  readonly categoryIds?: readonly number[];
  /** `true` keeps services with enough stock, `false` the others, `undefined` all. */
  readonly inStock?: boolean | undefined;
}

/**
 * Reads the ids of the services a group may buy AND that have a fixed price for it.
 *
 * Why: the storefront sells only what staff priced for the retail group (a service without that row has no retail price yet).
 *
 * @param db the database or a transaction
 * @param groupId the group (the storefront's retail group)
 * @param filter optional narrowing by type, category and stock (feature 22)
 * @returns the service ids, ascending, at most {@link MAX_PRICED_IDS}
 */
export async function findPricedServiceIds(
  db: DbExecutor,
  groupId: number,
  filter: SellableFilter = {},
): Promise<number[]> {
  const extra: SQL[] = [];
  if (filter.types && filter.types.length > 0) extra.push(inArray(services.type, [...filter.types]));
  if (filter.categoryIds && filter.categoryIds.length > 0) {
    extra.push(inArray(services.categoryId, [...filter.categoryIds]));
  }
  if (filter.inStock === true) extra.push(IN_STOCK_SQL);
  if (filter.inStock === false) extra.push(sql`not ${IN_STOCK_SQL}`);
  const rows = await db
    .select({ id: services.id })
    .from(services)
    .innerJoin(serviceCategories, eq(serviceCategories.id, services.categoryId))
    .innerJoin(
      serviceGroupPrices,
      and(eq(serviceGroupPrices.serviceId, services.id), eq(serviceGroupPrices.groupId, groupId)),
    )
    .where(and(visibleTo(groupId), ...extra))
    .orderBy(asc(services.id))
    .limit(MAX_PRICED_IDS);
  return rows.map((row) => row.id);
}

/**
 * Reads one page of the ids of the services a group may buy and that have a fixed price for it, after an id.
 *
 * Why: feature 29, plan section 4.5: the search reconcile and the rebuild walk every searchable service; unlike
 * {@link findPricedServiceIds} there is no ceiling, the caller pages with the last id it got (keyset, no offset).
 *
 * @param db the database or a transaction
 * @param groupId the group (the storefront's retail group)
 * @param afterId the last id of the previous page (0 for the first)
 * @param limit the page size
 * @returns the ids, ascending
 */
export async function findPricedServicePage(
  db: DbExecutor,
  groupId: number,
  afterId: number,
  limit: number,
): Promise<number[]> {
  const rows = await db
    .select({ id: services.id })
    .from(services)
    .innerJoin(serviceCategories, eq(serviceCategories.id, services.categoryId))
    .innerJoin(
      serviceGroupPrices,
      and(eq(serviceGroupPrices.serviceId, services.id), eq(serviceGroupPrices.groupId, groupId)),
    )
    .where(and(visibleTo(groupId), gt(services.id, afterId)))
    .orderBy(asc(services.id))
    .limit(limit);
  return rows.map((row) => row.id);
}

/**
 * Finds which of some services a group may buy and has a fixed price for.
 *
 * @param db the database or a transaction
 * @param ids the service ids
 * @param groupId the group (the storefront's retail group)
 * @returns the ids among `ids` that are visible to the group and carry its price row
 */
export async function findPricedAmong(db: DbExecutor, ids: readonly number[], groupId: number): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: services.id })
    .from(services)
    .innerJoin(serviceCategories, eq(serviceCategories.id, services.categoryId))
    .innerJoin(
      serviceGroupPrices,
      and(eq(serviceGroupPrices.serviceId, services.id), eq(serviceGroupPrices.groupId, groupId)),
    )
    .where(and(inArray(services.id, [...new Set(ids)]), visibleTo(groupId)));
  return new Set(rows.map((row) => row.id));
}

/**
 * Reads one page of the ids of the services of a category, whatever their state, after an id.
 *
 * Why: feature 29, plan section 4.5: a category change (its switch, name or groups) can show or hide every service in it, so the
 * search sync re-reads them all, 500 at a time.
 *
 * @param db the database or a transaction
 * @param categoryId the category
 * @param afterId the last id of the previous page (0 for the first)
 * @param limit the page size
 * @returns the ids, ascending
 */
export async function findServiceIdsOfCategory(
  db: DbExecutor,
  categoryId: number,
  afterId: number,
  limit: number,
): Promise<number[]> {
  const rows = await db
    .select({ id: services.id })
    .from(services)
    .where(and(eq(services.categoryId, categoryId), gt(services.id, afterId)))
    .orderBy(asc(services.id))
    .limit(limit);
  return rows.map((row) => row.id);
}

/** The labels of a service's option lists that the storefront search indexes. */
export interface OptionLabelRow {
  readonly serviceId: number;
  readonly list: 'model' | 'network';
  readonly label: string;
}

/**
 * Reads the labels of the `model` and `network` option lists of some services.
 *
 * Why: feature 29, plan section 4.2: a visitor types a model (`SM-G991B`) or a network (`Vodafone`) the service lists as an option.
 * The `mep` list and the supplier values are never read.
 *
 * @param db the database or a transaction
 * @param ids the service ids
 * @returns the labels in id order
 */
export async function findOptionLabels(db: DbExecutor, ids: readonly number[]): Promise<OptionLabelRow[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ serviceId: serviceOptions.serviceId, list: serviceOptions.list, label: serviceOptions.label })
    .from(serviceOptions)
    .where(
      and(inArray(serviceOptions.serviceId, [...new Set(ids)]), inArray(serviceOptions.list, ['model', 'network'])),
    )
    .orderBy(asc(serviceOptions.id));
  return rows as OptionLabelRow[];
}

/**
 * Finds which of some services have enough available inventory codes for their smallest order.
 *
 * @param db the database or a transaction
 * @param ids the service ids
 * @returns the ids among `ids` for which {@link IN_STOCK_SQL} holds
 */
export async function findInStockIds(db: DbExecutor, ids: readonly number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: services.id })
    .from(services)
    .where(and(inArray(services.id, [...new Set(ids)]), IN_STOCK_SQL));
  return new Set(rows.map((row) => row.id));
}

/** A category with the number of the given services in it. */
export interface CategoryCountRow {
  readonly id: number;
  readonly name: string;
  readonly nameAr: string;
  readonly type: ServiceType;
  readonly sort: number;
  readonly serviceCount: number;
}

/**
 * Counts some services per category.
 *
 * @param db the database or a transaction
 * @param ids the service ids to count (the caller already decided which are public)
 * @returns one row per category that holds at least one of them, ordered by `sort`, then id
 */
export async function countServicesByCategory(db: DbExecutor, ids: readonly number[]): Promise<CategoryCountRow[]> {
  if (ids.length === 0) return [];
  return db
    .select({
      id: serviceCategories.id,
      name: serviceCategories.name,
      nameAr: serviceCategories.nameAr,
      type: serviceCategories.type,
      sort: serviceCategories.sort,
      serviceCount: sql<number>`count(*)::int`,
    })
    .from(services)
    .innerJoin(serviceCategories, eq(serviceCategories.id, services.categoryId))
    .where(inArray(services.id, [...new Set(ids)]))
    .groupBy(serviceCategories.id)
    .orderBy(asc(serviceCategories.sort), asc(serviceCategories.id));
}

/**
 * Reads the custom fields of a service in form order.
 *
 * @param db the database or a transaction
 * @param serviceId the service
 * @returns the fields by `sort`, then id
 */
export async function findServiceFields(db: DbExecutor, serviceId: number): Promise<ServiceField[]> {
  return db
    .select()
    .from(serviceFields)
    .where(eq(serviceFields.serviceId, serviceId))
    .orderBy(asc(serviceFields.sort), asc(serviceFields.id));
}

/**
 * Reads one TAC catalogue entry.
 *
 * @param db the database or a transaction
 * @param tac the first 8 digits of an IMEI
 * @returns the entry, or `undefined` when the TAC is not in the catalogue
 */
export async function findTacEntry(db: DbExecutor, tac: string): Promise<TacCatalogEntry | undefined> {
  const [row] = await db.select().from(tacCatalog).where(eq(tacCatalog.tac, tac)).limit(1);
  return row;
}
