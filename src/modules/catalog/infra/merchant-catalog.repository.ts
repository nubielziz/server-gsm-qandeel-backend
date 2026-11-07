// Drizzle queries of the merchant catalog: the live, active services in an active category that a merchant group may see,
// ordered by category then name. Archived and disabled services are never listed (RESOLUTIONS catalog-3, RULES services 10).
import { and, asc, eq, gt, ilike, isNull, or, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, type ListColumns, escapeLike, listOrderBy, listWhere } from '../../../infra/db';
import { type Service, serviceCategories, services } from '../db/schema';

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
function visibleTo(groupId: number) {
  return and(
    isNull(services.archivedAt),
    eq(services.status, 'active'),
    eq(serviceCategories.isActive, true),
    sql`(cardinality(${serviceCategories.allowedGroupIds}) = 0 or ${groupId} = any(${serviceCategories.allowedGroupIds}))`,
  );
}

/**
 * The order of a category: its `sort`, then its id, as one text that sorts like the pair (both are written with a fixed width), so
 * two categories with the same `sort` never interleave their services.
 */
const categoryOrder = sql`(lpad(${serviceCategories.sort}::text, 10, '0') || lpad(${serviceCategories.id}::text, 20, '0'))`;

const COLUMNS: ListColumns = {
  id: services.id,
  name: services.name,
  type: services.type,
  categoryId: services.categoryId,
  category: categoryOrder,
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
 * @returns the page and the exact total
 */
export async function pageVisibleServices(
  db: DbExecutor,
  groupId: number,
  query: ParsedListQuery<'category' | 'name' | 'type' | 'id'>,
): Promise<{ rows: VisibleServiceRow[]; total: number }> {
  const where = listWhere(query, COLUMNS, visibleTo(groupId));
  const [rows, [count]] = await Promise.all([
    select(db)
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

/** What REST v1 filters its service list by. */
export interface ServiceCursorFilter {
  readonly type?: Service['type'];
  readonly categoryId?: number;
  /** Case-insensitive contains over the service name and code and the category name. */
  readonly search?: string;
}

/**
 * Reads one page of the services a merchant group may see, by cursor.
 *
 * Why: `GET /v1/services` pages by cursor (ALIGNMENT § 7): each page continues after the id of the last service of the previous one,
 * in id order, so a service added or switched off meanwhile never repeats or skips one.
 *
 * @param db the database or a transaction
 * @param groupId the merchant's group
 * @param options how many rows to read (one more than the page), where to continue and the filters
 * @returns the services with their category, in id order
 */
export async function pageVisibleServicesAfter(
  db: DbExecutor,
  groupId: number,
  options: { readonly limit: number; readonly afterId?: number } & ServiceCursorFilter,
): Promise<VisibleServiceRow[]> {
  const pattern = options.search === undefined ? undefined : `%${escapeLike(options.search)}%`;
  return select(db)
    .where(
      and(
        visibleTo(groupId),
        options.afterId === undefined ? undefined : gt(services.id, options.afterId),
        options.type === undefined ? undefined : eq(services.type, options.type),
        options.categoryId === undefined ? undefined : eq(services.categoryId, options.categoryId),
        pattern === undefined
          ? undefined
          : or(ilike(services.name, pattern), ilike(services.code, pattern), ilike(serviceCategories.name, pattern)),
      ),
    )
    .orderBy(asc(services.id))
    .limit(options.limit);
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
 * Lists every service a merchant group may see (up to {@link MAX_CATALOG_ROWS}), by category order then name.
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
    .orderBy(asc(serviceCategories.sort), asc(serviceCategories.id), asc(services.name), asc(services.id))
    .limit(MAX_CATALOG_ROWS);
}
