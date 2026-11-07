// Drizzle queries of the storefront's view of the catalog (feature 14a): the services a group may buy, their order fields, and
// the TAC catalogue. Read only; the visibility rule is the merchant catalog's (live, active, active category, group allowed).
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import {
  type Service,
  type ServiceField,
  type TacCatalogEntry,
  serviceCategories,
  serviceFields,
  serviceGroupPrices,
  services,
  tacCatalog,
} from '../db/schema';
import { visibleTo } from './merchant-catalog.repository';

/** A service with its category name. */
export interface SellableServiceRow {
  readonly service: Service;
  readonly categoryName: string;
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
    .select({ service: services, categoryName: serviceCategories.name })
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
 * Reads the ids of the services a group may buy AND that have a fixed price for it.
 *
 * Why: the storefront sells only what staff priced for the retail group (a service without that row has no retail price yet).
 *
 * @param db the database or a transaction
 * @param groupId the group (the storefront's retail group)
 * @returns the service ids, ascending, at most {@link MAX_PRICED_IDS}
 */
export async function findPricedServiceIds(db: DbExecutor, groupId: number): Promise<number[]> {
  const rows = await db
    .select({ id: services.id })
    .from(services)
    .innerJoin(serviceCategories, eq(serviceCategories.id, services.categoryId))
    .innerJoin(
      serviceGroupPrices,
      and(eq(serviceGroupPrices.serviceId, services.id), eq(serviceGroupPrices.groupId, groupId)),
    )
    .where(visibleTo(groupId))
    .orderBy(asc(services.id))
    .limit(MAX_PRICED_IDS);
  return rows.map((row) => row.id);
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
