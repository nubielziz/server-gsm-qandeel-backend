// Drizzle queries of the merchant group routes on `client_groups`, plus the deletes that go with removing a group
// (`service_group_prices`, `pricing_rules` of the group, the group id inside `service_categories.allowed_group_ids`).
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, type ListColumns, listOrderBy, listWhere } from '../../../infra/db';
import {
  type ClientGroup,
  type NewClientGroup,
  clientGroups,
  pricingRules,
  serviceCategories,
  serviceGroupPrices,
} from '../db/schema';

const COLUMNS: ListColumns = {
  id: clientGroups.id,
  name: clientGroups.name,
  sort: clientGroups.sort,
  createdAt: clientGroups.createdAt,
};

/**
 * Lists groups for `GET /admin/client-groups`.
 *
 * @param db the database or a transaction
 * @param query the parsed list request
 * @returns the page of groups and the exact total
 */
export async function listGroupRows(
  db: DbExecutor,
  query: ParsedListQuery<'sort' | 'name' | 'id' | 'createdAt'>,
): Promise<{ rows: ClientGroup[]; total: number }> {
  const where = listWhere(query, COLUMNS);
  const [rows, [count]] = await Promise.all([
    db
      .select()
      .from(clientGroups)
      .where(where)
      .orderBy(...listOrderBy(query.sort, COLUMNS, clientGroups.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(clientGroups)
      .where(where),
  ]);
  return { rows, total: count?.total ?? 0 };
}

/**
 * Finds a group by id.
 *
 * @param db the database or a transaction
 * @param id the group id
 * @returns the group, or `undefined`
 */
export async function findGroupRow(db: DbExecutor, id: number): Promise<ClientGroup | undefined> {
  const [row] = await db.select().from(clientGroups).where(eq(clientGroups.id, id)).limit(1);
  return row;
}

/**
 * Finds a group by id and locks it for the rest of the transaction.
 *
 * Why: a group change or delete must not interleave with a merchant move into the group, a credit limit change of one of its
 * merchants or another change of the default mark (the readers take `FOR SHARE`, user rule 2).
 *
 * @param db the transaction
 * @param id the group id
 * @returns the group, or `undefined`
 */
export async function lockGroupRow(db: DbExecutor, id: number): Promise<ClientGroup | undefined> {
  const [row] = await db.select().from(clientGroups).where(eq(clientGroups.id, id)).for('update').limit(1);
  return row;
}

/**
 * Tells whether another group already has a name, ignoring case.
 *
 * @param db the database or a transaction
 * @param name the trimmed name
 * @param exceptId a group to leave out (the one being renamed)
 * @returns true when a group other than `exceptId` has the name
 */
export async function groupNameTaken(db: DbExecutor, name: string, exceptId?: number): Promise<boolean> {
  const same = sql`lower(${clientGroups.name}) = lower(${name})`;
  const [row] = await db
    .select({ id: clientGroups.id })
    .from(clientGroups)
    .where(exceptId === undefined ? same : and(same, ne(clientGroups.id, exceptId)))
    .limit(1);
  return row !== undefined;
}

/**
 * The next `sort` value: one after the largest.
 *
 * @param db the database or a transaction
 * @returns the number a new group takes
 */
export async function nextGroupSort(db: DbExecutor): Promise<number> {
  const [row] = await db.select({ top: sql<number>`coalesce(max(${clientGroups.sort}), 0)::int` }).from(clientGroups);
  return (row?.top ?? 0) + 1;
}

/**
 * Takes the default mark off every group except one.
 *
 * Why: `client_groups_single_default_uq` allows one default group, so the old mark goes before the new one is set.
 *
 * @param db the transaction
 * @param exceptId the group that keeps or gets the mark
 */
export async function clearDefaultMark(db: DbExecutor, exceptId?: number): Promise<void> {
  const marked = eq(clientGroups.isDefault, true);
  await db
    .update(clientGroups)
    .set({ isDefault: false })
    .where(exceptId === undefined ? marked : and(marked, ne(clientGroups.id, exceptId)));
}

/**
 * Inserts a group.
 *
 * @param db the transaction
 * @param row the new group
 * @returns the stored group
 */
export async function insertGroupRow(db: DbExecutor, row: NewClientGroup): Promise<ClientGroup> {
  const [created] = await db.insert(clientGroups).values(row).returning();
  return created!;
}

/**
 * Changes a group.
 *
 * @param db the transaction
 * @param id the group id
 * @param changes the columns that change
 * @returns the updated group, or `undefined` when it is gone
 */
export async function updateGroupRow(
  db: DbExecutor,
  id: number,
  changes: Partial<Omit<NewClientGroup, 'id'>>,
): Promise<ClientGroup | undefined> {
  const [row] = await db.update(clientGroups).set(changes).where(eq(clientGroups.id, id)).returning();
  return row;
}

/**
 * Deletes the fixed group prices of a group.
 *
 * @param db the transaction
 * @param groupId the group
 * @returns how many prices were deleted
 */
export async function deleteGroupPrices(db: DbExecutor, groupId: number): Promise<number> {
  const rows = await db
    .delete(serviceGroupPrices)
    .where(eq(serviceGroupPrices.groupId, groupId))
    .returning({ id: serviceGroupPrices.id });
  return rows.length;
}

/**
 * Deletes the pricing rules that name a group.
 *
 * @param db the transaction
 * @param groupId the group
 * @returns the ids of the deleted rules (the audit row lists them)
 */
export async function deletePricingRulesOfGroup(db: DbExecutor, groupId: number): Promise<number[]> {
  const rows = await db
    .delete(pricingRules)
    .where(eq(pricingRules.groupId, groupId))
    .returning({ id: pricingRules.id });
  return rows.map((row) => row.id).sort((a, b) => a - b);
}

/**
 * Removes a group id from the allowed groups of every service category.
 *
 * Why: the categories that listed the group are locked first, in ascending id order, and only then updated. A single `UPDATE` locks
 * the rows in the order its scan meets them, which is the order on the page and not the id order. The other writer that takes several
 * categories at once, `lockCategoryPositions` of `POST /admin/service-categories/order` (`CategoryOrderService`, decision 078), takes
 * them in ascending id order; two writers that take the same rows in two orders can each hold one row and wait for the other's
 * (a deadlock). With one order for both, one of them waits for the other and then goes on.
 *
 * @param db the transaction
 * @param groupId the group
 * @returns the ids of the categories that listed it, ascending
 */
export async function dropGroupFromCategories(db: DbExecutor, groupId: number): Promise<number[]> {
  // The condition is checked again on the locked row, so a category that stopped listing the group meanwhile is left out.
  const locked = await db
    .select({ id: serviceCategories.id })
    .from(serviceCategories)
    .where(sql`${groupId}::bigint = any(${serviceCategories.allowedGroupIds})`)
    .orderBy(asc(serviceCategories.id))
    .for('update');
  if (locked.length === 0) return [];
  const ids = locked.map((row) => row.id);
  await db
    .update(serviceCategories)
    .set({ allowedGroupIds: sql`array_remove(${serviceCategories.allowedGroupIds}, ${groupId}::bigint)` })
    .where(inArray(serviceCategories.id, ids));
  return ids;
}

/**
 * Deletes a group row.
 *
 * @param db the transaction
 * @param id the group id
 * @returns true when a row was deleted
 */
export async function deleteGroupRow(db: DbExecutor, id: number): Promise<boolean> {
  const rows = await db.delete(clientGroups).where(eq(clientGroups.id, id)).returning({ id: clientGroups.id });
  return rows.length > 0;
}
