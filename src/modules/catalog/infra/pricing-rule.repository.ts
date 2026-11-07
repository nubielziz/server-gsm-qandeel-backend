// Drizzle queries of the pricing rule routes on `pricing_rules`, with the name of each rule's target (a category or a service
// by scope) and of its merchant group.
import { and, eq, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, type ListColumns, listOrderBy, listWhere } from '../../../infra/db';
import {
  type NewPricingRule,
  type PricingRule,
  clientGroups,
  pricingRules,
  serviceCategories,
  services,
} from '../db/schema';

/** A rule with the names of its target and group. */
export interface PricingRuleRow {
  readonly rule: PricingRule;
  /** The category or service name; `null` for a global rule (or a target that no longer exists). */
  readonly targetName: string | null;
  readonly groupName: string | null;
}

/** The target's name, whichever table it lives in. Written with table names: see the note in service-figures.sql.ts. */
const targetNameSql = sql<string | null>`coalesce("service_categories"."name", "services"."name")`;

const COLUMNS: ListColumns = {
  id: pricingRules.id,
  priority: pricingRules.priority,
  scope: pricingRules.scope,
  kind: pricingRules.kind,
  isActive: pricingRules.isActive,
  'target.name': targetNameSql,
};

const select = (db: DbExecutor) =>
  db
    .select({
      rule: pricingRules,
      targetName: targetNameSql,
      groupName: clientGroups.name,
    })
    .from(pricingRules)
    .leftJoin(
      serviceCategories,
      and(eq(pricingRules.scope, 'category'), eq(serviceCategories.id, pricingRules.targetId)),
    )
    .leftJoin(services, and(eq(pricingRules.scope, 'service'), eq(services.id, pricingRules.targetId)))
    .leftJoin(clientGroups, eq(clientGroups.id, pricingRules.groupId));

/**
 * Lists pricing rules for `GET /admin/pricing-rules`.
 *
 * @param db the database or a transaction
 * @param query the parsed list request (`scope`, `kind` and `isActive` filters, search, sort, range)
 * @returns the page and the exact total
 */
export async function listPricingRuleRows(
  db: DbExecutor,
  query: ParsedListQuery<'priority' | 'id' | 'scope' | 'kind'>,
): Promise<{ rows: PricingRuleRow[]; total: number }> {
  const where = listWhere(query, COLUMNS);
  const [rows, [count]] = await Promise.all([
    select(db)
      .where(where)
      .orderBy(...listOrderBy(query.sort, COLUMNS, pricingRules.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(pricingRules)
      .leftJoin(
        serviceCategories,
        and(eq(pricingRules.scope, 'category'), eq(serviceCategories.id, pricingRules.targetId)),
      )
      .leftJoin(services, and(eq(pricingRules.scope, 'service'), eq(services.id, pricingRules.targetId)))
      .where(where),
  ]);
  return { rows, total: count?.total ?? 0 };
}

/**
 * Finds one rule with the names of its target and group.
 *
 * @param db the database or a transaction
 * @param id the rule id
 * @returns the rule, or `undefined`
 */
export async function findPricingRuleRow(db: DbExecutor, id: number): Promise<PricingRuleRow | undefined> {
  const [row] = await select(db).where(eq(pricingRules.id, id)).limit(1);
  return row;
}

/**
 * Finds a rule and locks it for the rest of the transaction.
 *
 * @param db the transaction
 * @param id the rule id
 * @returns the rule, or `undefined`
 */
export async function lockPricingRule(db: DbExecutor, id: number): Promise<PricingRule | undefined> {
  const [row] = await db.select().from(pricingRules).where(eq(pricingRules.id, id)).limit(1).for('update');
  return row;
}

/**
 * Inserts a rule.
 *
 * @param db the transaction
 * @param row the new rule
 * @returns the stored rule
 */
export async function insertPricingRule(db: DbExecutor, row: NewPricingRule): Promise<PricingRule> {
  const [created] = await db.insert(pricingRules).values(row).returning();
  return created!;
}

/**
 * Changes a rule.
 *
 * @param db the transaction
 * @param id the rule id
 * @param changes the columns that change
 * @returns the updated rule
 */
export async function updatePricingRuleRow(
  db: DbExecutor,
  id: number,
  changes: Partial<Omit<NewPricingRule, 'id'>>,
): Promise<PricingRule | undefined> {
  const [row] = await db.update(pricingRules).set(changes).where(eq(pricingRules.id, id)).returning();
  return row;
}

/**
 * Deletes a rule.
 *
 * @param db the transaction
 * @param id the rule id
 * @returns true when a row was deleted
 */
export async function deletePricingRuleRow(db: DbExecutor, id: number): Promise<boolean> {
  const rows = await db.delete(pricingRules).where(eq(pricingRules.id, id)).returning({ id: pricingRules.id });
  return rows.length > 0;
}
