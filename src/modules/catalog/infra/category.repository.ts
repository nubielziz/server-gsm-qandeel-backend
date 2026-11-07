// Drizzle queries of the service category routes on `service_categories`, with the live service count of each category, the
// service counts the delete and type-change guards need, and the category-scope pricing rules that go with a category.
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, type ListColumns, listOrderBy, listWhere } from '../../../infra/db';
import {
  type NewServiceCategory,
  type ServiceCategory,
  type ServiceType,
  clientGroups,
  pricingRules,
  serviceCategories,
  services,
} from '../db/schema';

/** A category with the number of live services in it. */
export interface CategoryRow {
  readonly category: ServiceCategory;
  readonly serviceCount: number;
}

/**
 * Live services of the category: archived ones are hidden from the console and not counted (RESOLUTIONS catalog-6).
 *
 * The outer column is written as text on purpose: in a select from one table Drizzle prints the columns inside a selected
 * `sql` expression without their table name, which would bind `id` to the inner table.
 */
const liveServiceCount = sql<number>`(select count(*)::int from ${services} as live_service where live_service.category_id = "service_categories"."id" and live_service.archived_at is null)`;

const COLUMNS: ListColumns = { id: serviceCategories.id, name: serviceCategories.name, sort: serviceCategories.sort };

/**
 * Lists categories for `GET /admin/service-categories`.
 *
 * @param db the database or a transaction
 * @param query the parsed list request
 * @returns the page of categories with their live service counts, and the exact total
 */
export async function listCategoryRows(
  db: DbExecutor,
  query: ParsedListQuery<'sort' | 'name' | 'id'>,
): Promise<{ rows: CategoryRow[]; total: number }> {
  const where = listWhere(query, COLUMNS);
  const [rows, [count]] = await Promise.all([
    db
      .select({ category: serviceCategories, serviceCount: liveServiceCount })
      .from(serviceCategories)
      .where(where)
      .orderBy(...listOrderBy(query.sort, COLUMNS, serviceCategories.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(serviceCategories)
      .where(where),
  ]);
  return { rows, total: count?.total ?? 0 };
}

/**
 * Finds a category with its live service count.
 *
 * @param db the database or a transaction
 * @param id the category id
 * @returns the category, or `undefined`
 */
export async function findCategoryRow(db: DbExecutor, id: number): Promise<CategoryRow | undefined> {
  const [row] = await db
    .select({ category: serviceCategories, serviceCount: liveServiceCount })
    .from(serviceCategories)
    .where(eq(serviceCategories.id, id))
    .limit(1);
  return row;
}

/**
 * Finds a category and locks it for the rest of the transaction.
 *
 * Why: a type change or a delete must not interleave with a service being created in or moved into the category. `update`
 * (default) is for the category's own writers; `share` is for a service write that decides on the category's type, so a
 * concurrent type change waits for it.
 *
 * @param db the transaction
 * @param id the category id
 * @param mode `update` or `share`
 * @returns the category, or `undefined`
 */
export async function lockCategoryRow(
  db: DbExecutor,
  id: number,
  mode: 'update' | 'share' = 'update',
): Promise<ServiceCategory | undefined> {
  const query = db.select().from(serviceCategories).where(eq(serviceCategories.id, id)).limit(1);
  const [row] = await query.for(mode === 'update' ? 'update' : 'share');
  return row;
}

/**
 * Tells whether a category of a type already has a name, ignoring case.
 *
 * @param db the database or a transaction
 * @param type the service type
 * @param name the trimmed name
 * @param exceptId a category to leave out (the one being changed)
 * @returns true when another category of the type has the name
 */
export async function categoryNameTaken(
  db: DbExecutor,
  type: ServiceType,
  name: string,
  exceptId?: number,
): Promise<boolean> {
  const same = and(eq(serviceCategories.type, type), sql`lower(${serviceCategories.name}) = lower(${name})`);
  const [row] = await db
    .select({ id: serviceCategories.id })
    .from(serviceCategories)
    .where(exceptId === undefined ? same : and(same, ne(serviceCategories.id, exceptId)))
    .limit(1);
  return row !== undefined;
}

/**
 * The next `sort` value: one after the largest.
 *
 * @param db the database or a transaction
 * @returns the number a new category takes
 */
export async function nextCategorySort(db: DbExecutor): Promise<number> {
  const [row] = await db
    .select({ top: sql<number>`coalesce(max(${serviceCategories.sort}), 0)::int` })
    .from(serviceCategories);
  return (row?.top ?? 0) + 1;
}

/**
 * Tells which of some group ids exist.
 *
 * @param db the database or a transaction
 * @param ids the group ids a category is to list
 * @returns the ids that name a group
 */
export async function existingGroupIds(db: DbExecutor, ids: readonly number[]): Promise<number[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: clientGroups.id })
    .from(clientGroups)
    .where(inArray(clientGroups.id, [...ids]));
  return rows.map((row) => row.id);
}

/**
 * Counts the services of a category, live and archived apart.
 *
 * @param db the database or a transaction
 * @param categoryId the category
 * @returns the live and archived counts
 */
export async function countServicesOfCategory(
  db: DbExecutor,
  categoryId: number,
): Promise<{ live: number; archived: number }> {
  const [row] = await db
    .select({
      live: sql<number>`count(*) filter (where ${services.archivedAt} is null)::int`,
      archived: sql<number>`count(*) filter (where ${services.archivedAt} is not null)::int`,
    })
    .from(services)
    .where(eq(services.categoryId, categoryId));
  return { live: row?.live ?? 0, archived: row?.archived ?? 0 };
}

/**
 * Inserts a category.
 *
 * @param db the transaction
 * @param row the new category
 * @returns the stored category
 */
export async function insertCategoryRow(db: DbExecutor, row: NewServiceCategory): Promise<ServiceCategory> {
  const [created] = await db.insert(serviceCategories).values(row).returning();
  return created!;
}

/**
 * Changes a category.
 *
 * @param db the transaction
 * @param id the category id
 * @param changes the columns that change
 * @returns the updated category, or `undefined` when it is gone
 */
export async function updateCategoryRow(
  db: DbExecutor,
  id: number,
  changes: Partial<Omit<NewServiceCategory, 'id'>>,
): Promise<ServiceCategory | undefined> {
  const [row] = await db.update(serviceCategories).set(changes).where(eq(serviceCategories.id, id)).returning();
  return row;
}

/**
 * Deletes the pricing rules that apply to one category.
 *
 * @param db the transaction
 * @param categoryId the category
 * @returns the ids of the deleted rules
 */
export async function deleteCategoryRules(db: DbExecutor, categoryId: number): Promise<number[]> {
  const rows = await db
    .delete(pricingRules)
    .where(and(eq(pricingRules.scope, 'category'), eq(pricingRules.targetId, categoryId)))
    .returning({ id: pricingRules.id });
  return rows.map((row) => row.id).sort((a, b) => a - b);
}

/**
 * Deletes a category row.
 *
 * @param db the transaction
 * @param id the category id
 * @returns true when a row was deleted
 */
export async function deleteCategoryRow(db: DbExecutor, id: number): Promise<boolean> {
  const rows = await db
    .delete(serviceCategories)
    .where(eq(serviceCategories.id, id))
    .returning({ id: serviceCategories.id });
  return rows.length > 0;
}
