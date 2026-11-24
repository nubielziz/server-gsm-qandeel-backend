// Drizzle queries of the merchant catalog: the live, active services in an active category that a merchant group may see,
// ordered by category position, then the service's own position, then name (decision 063). Archived and disabled services are
// never listed (RESOLUTIONS catalog-3, RULES services 10).
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, type ListColumns, listOrderBy, listWhere } from '../../../infra/db';
import { type Service, serviceCategories, services } from '../db/schema';
import { categoryPositionSql, expandSortField } from './service-order.sql';

/** A visible service with its category. */
export interface VisibleServiceRow {
  readonly service: Service;
  readonly category: { readonly id: number; readonly name: string };
}

/** The most services one price export or full list carries. */
export const MAX_CATALOG_ROWS = 10_000;

/**
 * The visibility rule as a condition: the service is live and `active`, its category is on, and the category lists no allowed
 * groups (every group) or lists the merchant's.
 *
 * @param groupId the merchant's group
 * @returns the SQL condition
 */
export function visibleTo(groupId: number) {
  return and(
    isNull(services.archivedAt),
    eq(services.status, 'active'),
    eq(serviceCategories.isActive, true),
    sql`(cardinality(${serviceCategories.allowedGroupIds}) = 0 or ${groupId} = any(${serviceCategories.allowedGroupIds}))`,
  );
}

const COLUMNS: ListColumns = {
  id: services.id,
  name: services.name,
  type: services.type,
  categoryId: services.categoryId,
  category: categoryPositionSql,
  // Not a sort of the contract: `category` stands for "category position, then this" (decision 063).
  position: services.sort,
  code: services.code,
  'category.name': serviceCategories.name,
};

const select = (db: DbExecutor) =>
  db
    .select({
      service: services,
      category: { id: serviceCategories.id, name: serviceCategories.name },
    })
    .from(services)
    .innerJoin(serviceCategories, eq(serviceCategories.id, services.categoryId));

/**
 * Lists one page of the services a merchant group may see.
 *
 * @param db the database or a transaction
 * @param groupId the merchant's group
 * @param query the parsed list request (type and category filters, search, sort, range)
 * @param ids when given, only these services (the visibility rule still applies, so an id that is unknown or hidden is absent)
 * @returns the page and the exact total
 */
export async function pageVisibleServices(
  db: DbExecutor,
  groupId: number,
  query: ParsedListQuery<'category' | 'name' | 'type' | 'id', unknown>,
  ids?: readonly number[],
): Promise<{ rows: VisibleServiceRow[]; total: number }> {
  const where = listWhere(
    query,
    COLUMNS,
    visibleTo(groupId),
    ids === undefined ? undefined : inArray(services.id, [...ids]),
  );
  const [rows, [count]] = await Promise.all([
    select(db)
      .where(where)
      .orderBy(...listOrderBy(expandSortField(query.sort, 'category', { after: ['position'] }), COLUMNS, services.id))
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
 * Finds one service a merchant group may see.
 *
 * @param db the database or a transaction
 * @param groupId the merchant's group
 * @param serviceId the service id
 * @returns the service with its category, or `undefined` when it is unknown, archived, off, or hidden from the group
 */
export async function findVisibleService(
  db: DbExecutor,
  groupId: number,
  serviceId: number,
): Promise<VisibleServiceRow | undefined> {
  const [row] = await select(db)
    .where(and(eq(services.id, serviceId), visibleTo(groupId)))
    .limit(1);
  return row;
}

/**
 * Lists every service a merchant group may see (up to {@link MAX_CATALOG_ROWS}), by category order, then the service's own position
 * (`services.sort`, decision 063), then name.
 *
 * @param db the database or a transaction
 * @param groupId the merchant's group
 * @param filter optional `type` and `categoryId` filters
 * @returns the services with their category
 */
export async function listVisibleServices(
  db: DbExecutor,
  groupId: number,
  filter: { readonly type?: Service['type']; readonly categoryId?: number } = {},
): Promise<VisibleServiceRow[]> {
  return select(db)
    .where(
      and(
        visibleTo(groupId),
        filter.type === undefined ? undefined : eq(services.type, filter.type),
        filter.categoryId === undefined ? undefined : eq(services.categoryId, filter.categoryId),
      ),
    )
    .orderBy(
      asc(serviceCategories.sort),
      asc(serviceCategories.id),
      asc(services.sort),
      asc(services.name),
      asc(services.id),
    )
    .limit(MAX_CATALOG_ROWS);
}
