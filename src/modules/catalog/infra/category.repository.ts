// Drizzle queries of the service category routes on `service_categories`, with the live service count of each category, the
// service counts the delete and type-change guards need, and the category-scope pricing rules that go with a category.
import { and, asc, eq, gt, inArray, ne, sql } from 'drizzle-orm';
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

/** A category found by one of several (type, name) lookups. */
export interface CategoryNameHit {
  /** The position of the lookup in the list asked for, from 0. */
  readonly lookup: number;
  readonly id: number;
  /** The category's own name (its case may differ from the name looked up). */
  readonly name: string;
}

/**
 * Finds the category of each (type, name) pair, ignoring the case of the name, in one statement.
 *
 * Why: the importer looks a category up by type and `lower(name)`, which `service_categories_name_uq` makes unique; the preview of
 * an import (decision 063) asks the same of every new service at once. The names are compared by Postgres's own `lower()`, the
 * comparison the importer makes, so the preview and the import never disagree on a name.
 *
 * @param db the database or a transaction
 * @param lookups the (type, name) pairs, at most two per supplier service of a request (1000)
 * @returns one hit per pair that has a category, any order; a pair without one is missing
 */
export async function categoriesByTypeAndName(
  db: DbExecutor,
  lookups: ReadonlyArray<{ readonly type: ServiceType; readonly name: string }>,
): Promise<CategoryNameHit[]> {
  if (lookups.length === 0) return [];
  const result = await db.execute<{ lookup: number; id: string; name: string }>(sql`
    select wanted.lookup, category.id, category.name
    from (values ${sql.join(
      lookups.map((pair, lookup) => sql`(${lookup}::integer, ${pair.type}::text, ${pair.name}::text)`),
      sql`, `,
    )}) as wanted(lookup, type, name)
    join ${serviceCategories} as category on category.type = wanted.type and lower(category.name) = lower(wanted.name)`);
  return result.rows.map((row) => ({ lookup: Number(row.lookup), id: Number(row.id), name: row.name }));
}

/** A category as the pass over the names reads it. */
export interface CategoryNameRow {
  readonly id: number;
  readonly name: string;
}

/**
 * Reads a page of categories after an id, for a pass over all of them.
 *
 * @param db the database or a transaction
 * @param afterId the last id of the previous page, or 0
 * @param limit the size of the page
 * @returns the ids and names, in id order
 */
export function categoryNamesAfter(db: DbExecutor, afterId: number, limit: number): Promise<CategoryNameRow[]> {
  return db
    .select({ id: serviceCategories.id, name: serviceCategories.name })
    .from(serviceCategories)
    .where(gt(serviceCategories.id, afterId))
    .orderBy(asc(serviceCategories.id))
    .limit(limit);
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

/** A category as the order of categories reads it. */
export interface CategoryPosition {
  readonly id: number;
  readonly name: string;
  readonly sort: number;
}

/**
 * Locks the given categories for the rest of the transaction, in id order, and reads their position.
 *
 * Why: decision 078: a new order of categories is written from the positions nobody can change until the transaction ends, so two
 * saves (or a save and a category edit or delete) never interleave; the id order keeps two saves from deadlocking.
 *
 * @param db the transaction
 * @param ids the category ids to lock (duplicates are fine)
 * @returns the categories among them, by id; an unknown id is not in the list
 */
export async function lockCategoryPositions(db: DbExecutor, ids: readonly number[]): Promise<CategoryPosition[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  return db
    .select({ id: serviceCategories.id, name: serviceCategories.name, sort: serviceCategories.sort })
    .from(serviceCategories)
    .where(inArray(serviceCategories.id, unique))
    .orderBy(asc(serviceCategories.id))
    .for('update');
}

/**
 * Writes the positions of categories that changed, in one statement.
 *
 * @param db the transaction (the categories are locked)
 * @param items the categories and their new position
 * @returns the ids of the categories whose position changed (a category already at its position is left alone)
 */
export async function writeCategoryPositions(
  db: DbExecutor,
  items: ReadonlyArray<{ readonly id: number; readonly sort: number }>,
): Promise<number[]> {
  if (items.length === 0) return [];
  const result = await db.execute<{ id: string }>(sql`
    update ${serviceCategories} as target
    set sort = changed.sort, updated_at = now()
    from (values ${sql.join(
      items.map((item) => sql`(${item.id}::bigint, ${item.sort}::integer)`),
      sql`, `,
    )}) as changed(id, sort)
    where target.id = changed.id and target.sort is distinct from changed.sort
    returning target.id`);
  return result.rows.map((row) => Number(row.id)).sort((a, b) => a - b);
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
