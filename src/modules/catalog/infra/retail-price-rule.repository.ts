// Drizzle queries of the retail price rules and of the follow rows (decision 040, feature 31) on `retail_price_rules` and
// `retail_price_follows`, with the category name of a category rule and the type and category of the services they price.
// Every read of the rules filters `deleted_at IS NULL`, except `ruleLabelsOf`, which names a deleted rule for history.
import { type SQL, and, asc, count, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, type ListColumns, listOrderBy, listWhere } from '../../../infra/db';
import {
  type NewRetailPriceRule,
  type RetailPriceFollow,
  type RetailPriceRule,
  type RetailRuleScope,
  type ServiceType,
  retailPriceFollows,
  retailPriceRules,
  serviceCategories,
  services,
} from '../db/schema';

/** The sorts of `GET /admin/retail-price-rules`. */
export type RetailRuleSort = 'id' | 'scope';

/** A rule with the name of its category and the number of services whose price it wrote last. */
export interface RetailRuleRow {
  readonly rule: RetailPriceRule;
  /** The category's name for a category rule; `null` otherwise. */
  readonly categoryName: string | null;
  readonly following: number;
}

/** The type and category of a live service: what picks its rule. */
export interface ServiceRuleTarget {
  readonly type: ServiceType;
  readonly categoryId: number;
}

/** The scope order of the list: `global`, then `type`, then `category`. */
const scopeRank = sql<number>`case ${retailPriceRules.scope} when 'global' then 0 when 'type' then 1 else 2 end`;

const FILTER_COLUMNS: ListColumns = {
  scope: retailPriceRules.scope,
  isActive: retailPriceRules.isActive,
};

const SORT_COLUMNS: ListColumns = {
  id: retailPriceRules.id,
  scope: scopeRank,
};

const followingCount = sql<number>`(select count(*)::int from ${retailPriceFollows} where ${retailPriceFollows.ruleId} = ${retailPriceRules.id})`;

const notDeleted = isNull(retailPriceRules.deletedAt);

const selectRows = (db: DbExecutor) =>
  db
    .select({ rule: retailPriceRules, categoryName: serviceCategories.name, following: followingCount })
    .from(retailPriceRules)
    .leftJoin(serviceCategories, eq(serviceCategories.id, retailPriceRules.categoryId));

/**
 * Lists the rules that are not deleted for `GET /admin/retail-price-rules`.
 *
 * @param db the database or a transaction
 * @param query the parsed list request (`scope` and `isActive` filters, `id` and `scope` sorts, range)
 * @returns the page and the exact total
 */
export async function listRetailRuleRows(
  db: DbExecutor,
  query: ParsedListQuery<RetailRuleSort>,
): Promise<{ rows: RetailRuleRow[]; total: number }> {
  const where = listWhere(query, FILTER_COLUMNS, notDeleted);
  const [rows, [total]] = await Promise.all([
    selectRows(db)
      .where(where)
      .orderBy(...listOrderBy(query.sort, SORT_COLUMNS, retailPriceRules.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db.select({ total: count() }).from(retailPriceRules).where(where),
  ]);
  return { rows, total: total?.total ?? 0 };
}

/**
 * Finds a rule that is not deleted, with its category name and its follower count.
 *
 * @param db the database or a transaction
 * @param id the rule id
 * @returns the rule, or `undefined` when it is unknown or deleted
 */
export async function findRetailRuleRow(db: DbExecutor, id: number): Promise<RetailRuleRow | undefined> {
  const [row] = await selectRows(db)
    .where(and(eq(retailPriceRules.id, id), notDeleted))
    .limit(1);
  return row;
}

/**
 * Finds a rule that is not deleted and locks it for the rest of the transaction.
 *
 * Why: `FOR NO KEY UPDATE`, not `FOR UPDATE`: an edit and the soft delete change no key column, so they never wait on (or
 * deadlock with) the foreign key checks of the follow pass and the publisher, which take the rule row `FOR KEY SHARE` while
 * they hold a service row (plan 31 section 4.1). Two edits of one rule still serialize.
 *
 * @param db the transaction
 * @param id the rule id
 * @returns the rule, or `undefined` when it is unknown or deleted
 */
export async function lockRetailRule(db: DbExecutor, id: number): Promise<RetailPriceRule | undefined> {
  const [row] = await db
    .select()
    .from(retailPriceRules)
    .where(and(eq(retailPriceRules.id, id), notDeleted))
    .limit(1)
    .for('no key update');
  return row;
}

/**
 * Finds the rule that is not deleted for a target (one rule per target).
 *
 * @param db the database or a transaction
 * @param target the scope and its target field
 * @returns the rule's id, or `undefined` when the target is free
 */
export async function findRetailRuleForTarget(
  db: DbExecutor,
  target: { scope: RetailRuleScope; serviceType: ServiceType | null; categoryId: number | null },
): Promise<number | undefined> {
  const which =
    target.scope === 'global'
      ? eq(retailPriceRules.scope, 'global')
      : target.scope === 'type'
        ? and(eq(retailPriceRules.scope, 'type'), eq(retailPriceRules.serviceType, target.serviceType!))
        : and(eq(retailPriceRules.scope, 'category'), eq(retailPriceRules.categoryId, target.categoryId!));
  const [row] = await db
    .select({ id: retailPriceRules.id })
    .from(retailPriceRules)
    .where(and(which, notDeleted))
    .limit(1);
  return row?.id;
}

/**
 * Inserts a rule.
 *
 * @param db the transaction
 * @param row the new rule
 * @returns the stored rule
 */
export async function insertRetailRule(db: DbExecutor, row: NewRetailPriceRule): Promise<RetailPriceRule> {
  const [created] = await db.insert(retailPriceRules).values(row).returning();
  return created!;
}

/**
 * Changes a rule that is not deleted (the caller holds its lock).
 *
 * @param db the transaction
 * @param id the rule id
 * @param changes the columns that change
 * @returns the updated rule
 */
export async function updateRetailRuleRow(
  db: DbExecutor,
  id: number,
  changes: Partial<Omit<NewRetailPriceRule, 'id' | 'scope' | 'serviceType' | 'categoryId'>>,
): Promise<RetailPriceRule> {
  const [row] = await db
    .update(retailPriceRules)
    .set(changes)
    .where(and(eq(retailPriceRules.id, id), notDeleted))
    .returning();
  return row!;
}

/**
 * Reads the active rules that are not deleted and could price services of these types and categories: the global rule, the
 * rules of the types and the rules of the categories.
 *
 * @param db the database or a transaction
 * @param scope the types and categories of the services to price
 * @returns the rules with their category names
 */
export async function activeRetailRules(
  db: DbExecutor,
  scope: { types: readonly ServiceType[]; categoryIds: readonly number[] },
): Promise<RetailRuleRow[]> {
  const targets: SQL[] = [eq(retailPriceRules.scope, 'global')];
  if (scope.types.length > 0) {
    targets.push(
      and(eq(retailPriceRules.scope, 'type'), inArray(retailPriceRules.serviceType, [...new Set(scope.types)]))!,
    );
  }
  if (scope.categoryIds.length > 0) {
    targets.push(
      and(
        eq(retailPriceRules.scope, 'category'),
        inArray(retailPriceRules.categoryId, [...new Set(scope.categoryIds)]),
      )!,
    );
  }
  return selectRows(db)
    .where(and(notDeleted, eq(retailPriceRules.isActive, true), or(...targets)))
    .orderBy(asc(retailPriceRules.id));
}

/**
 * Tells whether any rule is active (and not deleted).
 *
 * @param db the database or a transaction
 * @returns true when at least one active rule exists
 */
export async function anyActiveRetailRule(db: DbExecutor): Promise<boolean> {
  const [row] = await db
    .select({ id: retailPriceRules.id })
    .from(retailPriceRules)
    .where(and(notDeleted, eq(retailPriceRules.isActive, true)))
    .limit(1);
  return row !== undefined;
}

/**
 * Reads the id of a category's rule that is not deleted (what the cascade of a category delete removes).
 *
 * @param db the transaction
 * @param categoryId the category
 * @returns the rule's id, or `null` when the category has none
 */
export async function categoryRetailRuleId(db: DbExecutor, categoryId: number): Promise<number | null> {
  const [row] = await db
    .select({ id: retailPriceRules.id })
    .from(retailPriceRules)
    .where(and(eq(retailPriceRules.scope, 'category'), eq(retailPriceRules.categoryId, categoryId), notDeleted))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Reads rules by id whether deleted or not, with their category names: the history of a price names the rule that made it.
 *
 * @param db the database or a transaction
 * @param ids the rule ids
 * @returns the rules by id (an id with no row is absent)
 */
export async function ruleRowsOf(db: DbExecutor, ids: readonly number[]): Promise<Map<number, RetailRuleRow>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await selectRows(db).where(inArray(retailPriceRules.id, unique));
  return new Map(rows.map((row) => [row.rule.id, row]));
}

/**
 * Reads the type and category of live services.
 *
 * @param db the database or a transaction
 * @param serviceIds the services
 * @returns the targets by service id (an unknown or archived service is absent)
 */
export async function serviceRuleTargets(
  db: DbExecutor,
  serviceIds: readonly number[],
): Promise<Map<number, ServiceRuleTarget>> {
  const unique = [...new Set(serviceIds)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: services.id, type: services.type, categoryId: services.categoryId })
    .from(services)
    .where(and(inArray(services.id, unique), isNull(services.archivedAt)));
  return new Map(rows.map((row) => [row.id, { type: row.type, categoryId: row.categoryId }]));
}

/**
 * Reads the name and code of services (archived or not).
 *
 * @param db the database or a transaction
 * @param serviceIds the services
 * @returns the name and code by service id
 */
export async function serviceNamesOf(
  db: DbExecutor,
  serviceIds: readonly number[],
): Promise<Map<number, { name: string; code: string }>> {
  const unique = [...new Set(serviceIds)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: services.id, name: services.name, code: services.code })
    .from(services)
    .where(inArray(services.id, unique));
  return new Map(rows.map((row) => [row.id, { name: row.name, code: row.code }]));
}

/**
 * Reads the follow rows of services.
 *
 * @param db the database or a transaction
 * @param serviceIds the services
 * @returns the follow rows by service id (a service whose price is typed, or that has none, is absent)
 */
export async function followsOf(
  db: DbExecutor,
  serviceIds: readonly number[],
): Promise<Map<number, RetailPriceFollow>> {
  const unique = [...new Set(serviceIds)];
  if (unique.length === 0) return new Map();
  const rows = await db.select().from(retailPriceFollows).where(inArray(retailPriceFollows.serviceId, unique));
  return new Map(rows.map((row) => [row.serviceId, row]));
}

/**
 * Writes the follow row of a service: its price is the rule's from now on.
 *
 * @param db the caller's transaction (the service row is locked)
 * @param row the rule, the price written and the cost it was worked out from, and the clock's time
 */
export async function upsertRetailFollow(
  db: DbExecutor,
  row: { serviceId: number; ruleId: number; appliedPrice: string; appliedCost: string; appliedAt: Date },
): Promise<void> {
  await db
    .insert(retailPriceFollows)
    .values(row)
    .onConflictDoUpdate({
      target: retailPriceFollows.serviceId,
      set: {
        ruleId: row.ruleId,
        appliedPrice: row.appliedPrice,
        appliedCost: row.appliedCost,
        appliedAt: row.appliedAt,
        // updated_at is bookkeeping (decision 027), so the database's now() is fine here.
        updatedAt: sql`now()`,
      },
    });
}

/**
 * Deletes the follow row of a service: its price is a typed one from now on (or it has none).
 *
 * @param db the caller's transaction (the service row is locked)
 * @param serviceId the service
 * @returns true when a row was deleted
 */
export async function deleteRetailFollow(db: DbExecutor, serviceId: number): Promise<boolean> {
  const rows = await db
    .delete(retailPriceFollows)
    .where(eq(retailPriceFollows.serviceId, serviceId))
    .returning({ id: retailPriceFollows.id });
  return rows.length > 0;
}

/**
 * Reads the next page of following services, in service id order: the keyset walk of the follow pass.
 *
 * @param db the database or a transaction
 * @param afterServiceId the last service of the page before (0 for the first page)
 * @param limit the page size
 * @returns the service ids, lowest first
 */
export async function followServiceIdsAfter(db: DbExecutor, afterServiceId: number, limit: number): Promise<number[]> {
  const rows = await db
    .select({ serviceId: retailPriceFollows.serviceId })
    .from(retailPriceFollows)
    .where(gt(retailPriceFollows.serviceId, afterServiceId))
    .orderBy(asc(retailPriceFollows.serviceId))
    .limit(limit);
  return rows.map((row) => row.serviceId);
}

/**
 * Finds the follow row of a service and locks it for the rest of the transaction.
 *
 * Why: plan 31 section 6.4: read again under the service lock, it tells the follow pass whether the price still follows: a person who
 * typed a price meanwhile has deleted it.
 *
 * @param db the caller's transaction (the service row is locked)
 * @param serviceId the service
 * @returns the row, or `undefined` when the price does not follow a rule
 */
export async function lockRetailFollow(db: DbExecutor, serviceId: number): Promise<RetailPriceFollow | undefined> {
  const [row] = await db
    .select()
    .from(retailPriceFollows)
    .where(eq(retailPriceFollows.serviceId, serviceId))
    .limit(1)
    .for('update');
  return row;
}

/**
 * Brings a follow row up to date when the rule still gives the stored price: the rule, the cost and the time it was confirmed.
 *
 * @param db the caller's transaction (the service row is locked)
 * @param serviceId the service
 * @param row the rule of now, the cost of now and the clock's time
 */
export async function confirmRetailFollow(
  db: DbExecutor,
  serviceId: number,
  row: { ruleId: number; appliedCost: string; appliedAt: Date },
): Promise<void> {
  await db.update(retailPriceFollows).set(row).where(eq(retailPriceFollows.serviceId, serviceId));
}

/**
 * Moves the time a follow row was last brought up to date, and nothing else: what the row says of the price and the cost stays.
 *
 * Why: plan 31 correction 3: the follow pass reads a rule changed after `applied_at` as a decision of staff that applies at once. When a
 * sync moves a service to another rule, that rule's older edits were no decision about this service, so the comparison starts at the move.
 *
 * @param db the caller's transaction (the service row is locked)
 * @param serviceId the service (one whose price follows no rule has no row, and nothing happens)
 * @param at the clock's time
 */
export async function restampRetailFollow(db: DbExecutor, serviceId: number, at: Date): Promise<void> {
  await db.update(retailPriceFollows).set({ appliedAt: at }).where(eq(retailPriceFollows.serviceId, serviceId));
}

/**
 * Reads the follow rows of live services a rule target can reach, in service id order: what a rule change can move.
 *
 * @param db the database or a transaction
 * @param target the scope and its target field
 * @param limit the most rows to return
 * @returns the ids of the following services, lowest first
 */
export async function followersInReach(
  db: DbExecutor,
  target: { scope: RetailRuleScope; serviceType: ServiceType | null; categoryId: number | null },
  limit: number,
): Promise<number[]> {
  const reach =
    target.scope === 'global'
      ? undefined
      : target.scope === 'type'
        ? eq(services.type, target.serviceType!)
        : eq(services.categoryId, target.categoryId!);
  const rows = await db
    .select({ serviceId: retailPriceFollows.serviceId })
    .from(retailPriceFollows)
    .innerJoin(services, eq(services.id, retailPriceFollows.serviceId))
    .where(and(isNull(services.archivedAt), reach))
    .orderBy(asc(retailPriceFollows.serviceId))
    .limit(limit);
  return rows.map((row) => row.serviceId);
}
